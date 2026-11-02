//! The Git panel. Runs the user's own `git`, so their configuration,
//! credentials, signing and hooks apply as in any terminal.

use std::path::Path;

use serde::Serialize;
use tokio::process::Command;

use crate::error::{AppError, AppResult};

pub struct Output {
    pub stdout: String,
    pub stderr: String,
}

pub async fn run(root: &str, args: &[&str]) -> AppResult<Output> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.quotepath=false"])
        .args(args)
        // Never wait for a password prompt that nobody can answer.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .await
        .map_err(|e| AppError::new("no_git", format!("Could not run git: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        let message = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        return Err(AppError::new("git", message.to_string()));
    }
    Ok(Output { stdout, stderr })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    /// Status in the index (staged) and in the working tree, as git's letters:
    /// M modified, A added, D deleted, R renamed, ? untracked, U conflict, . none.
    pub index: char,
    pub work: char,
    pub from: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub root: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub files: Vec<FileStatus>,
    /// Lines added and removed since the last commit, staged or not, with
    /// the lines of new files counted as added. Shown in the title bar.
    pub added: i64,
    pub removed: i64,
}

/// The repository containing `path`, or None outside a repository.
pub async fn root_of(path: &str) -> Option<String> {
    run(path, &["rev-parse", "--show-toplevel"]).await.ok().map(|o| o.stdout.trim().to_string())
}

pub fn parse_status(root: &str, text: &str) -> Status {
    let mut status = Status { root: root.to_string(), ..Status::default() };
    let mut records = text.split('\0').peekable();
    while let Some(record) = records.next() {
        if let Some(head) = record.strip_prefix("# branch.head ") {
            status.branch = (head != "(detached)").then(|| head.to_string());
        } else if let Some(upstream) = record.strip_prefix("# branch.upstream ") {
            status.upstream = Some(upstream.to_string());
        } else if let Some(ab) = record.strip_prefix("# branch.ab ") {
            let mut parts = ab.split(' ');
            status.ahead = parts.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
            status.behind = parts.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if let Some(path) = record.strip_prefix("? ") {
            status.files.push(FileStatus { path: path.to_string(), index: '?', work: '?', from: None });
        } else if record.starts_with("1 ") || record.starts_with("2 ") || record.starts_with("u ") {
            let kind = record.as_bytes()[0];
            // Fields before the path: 1 has 8, 2 has 9, u has 10.
            let fields = match kind {
                b'1' => 8,
                b'2' => 9,
                _ => 10,
            };
            let mut parts = record.splitn(fields + 1, ' ');
            let _ = parts.next();
            let xy: Vec<char> = parts.next().unwrap_or("..").chars().collect();
            let path = parts.nth(fields - 2).unwrap_or("").to_string();
            let from = if kind == b'2' { records.next().map(str::to_string) } else { None };
            let (index, work) = if kind == b'u' { ('U', 'U') } else { (xy[0], xy[1]) };
            status.files.push(FileStatus { path, index, work, from });
        }
    }
    status
}

pub async fn status(path: &str) -> AppResult<Option<Status>> {
    let Some(root) = root_of(path).await else { return Ok(None) };
    let (out, numstat) = tokio::join!(
        run(&root, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
        line_changes(&root),
    );
    let mut status = parse_status(&root, &out?.stdout);
    (status.added, status.removed) = numstat;
    let new: Vec<String> = status.files.iter().filter(|f| f.work == '?').map(|f| f.path.clone()).collect();
    let base = root.clone();
    status.added += tokio::task::spawn_blocking(move || count_lines(&base, &new)).await.unwrap_or(0);
    Ok(Some(status))
}

/// The tree of a repository with no files, to compare against before the first commit.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async fn line_changes(root: &str) -> (i64, i64) {
    let out = match run(root, &["diff", "HEAD", "--numstat"]).await {
        Ok(out) => out,
        Err(_) => match run(root, &["diff", EMPTY_TREE, "--numstat"]).await {
            Ok(out) => out,
            Err(_) => return (0, 0),
        },
    };
    parse_numstat(&out.stdout)
}

/// Sums `git diff --numstat` lines: "added<TAB>removed<TAB>path", with "-"
/// for both counts of a binary file.
pub fn parse_numstat(text: &str) -> (i64, i64) {
    text.lines().fold((0, 0), |(added, removed), line| {
        let mut parts = line.split('\t');
        let a = parts.next().and_then(|n| n.parse::<i64>().ok()).unwrap_or(0);
        let r = parts.next().and_then(|n| n.parse::<i64>().ok()).unwrap_or(0);
        (added + a, removed + r)
    })
}

/// Lines in new files, which git diff leaves out. Binary files, files over
/// 1 MB and files past the first 500 are skipped, so a folder of generated
/// files cannot slow down every refresh.
fn count_lines(root: &str, paths: &[String]) -> i64 {
    paths
        .iter()
        .take(500)
        .filter_map(|p| {
            let path = Path::new(root).join(p);
            if std::fs::metadata(&path).ok()?.len() > 1024 * 1024 {
                return None;
            }
            let bytes = std::fs::read(&path).ok()?;
            if bytes.iter().take(8000).any(|&b| b == 0) {
                return None;
            }
            let lines = bytes.iter().filter(|&&b| b == b'\n').count() as i64;
            Some(if bytes.last().is_some_and(|&b| b != b'\n') { lines + 1 } else { lines })
        })
        .sum()
}

pub async fn stage(root: &str, paths: &[String]) -> AppResult<()> {
    let mut args = vec!["add", "-A", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(root, &args).await.map(|_| ())
}

pub async fn unstage(root: &str, paths: &[String]) -> AppResult<()> {
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    if run(root, &args).await.is_ok() {
        return Ok(());
    }
    // Before the first commit there is no HEAD to restore from.
    let mut args = vec!["rm", "--cached", "-r", "-q", "--"];
    args.extend(paths.iter().map(String::as_str));
    run(root, &args).await.map(|_| ())
}

/// Throws away working tree changes. Untracked files go to the Trash.
pub async fn discard(root: &str, tracked: &[String], untracked: &[String]) -> AppResult<()> {
    if !tracked.is_empty() {
        let mut args = vec!["restore", "--worktree", "--"];
        args.extend(tracked.iter().map(String::as_str));
        run(root, &args).await?;
    }
    if !untracked.is_empty() {
        let full: Vec<String> = untracked.iter().map(|p| Path::new(root).join(p).to_string_lossy().into_owned()).collect();
        crate::files::move_to_trash(&full)?;
    }
    Ok(())
}

pub async fn commit(root: &str, message: &str, amend: bool) -> AppResult<String> {
    let mut args = vec!["commit", "-m", message];
    if amend {
        args.push("--amend");
    }
    run(root, &args).await.map(|o| o.stdout)
}

pub async fn push(root: &str) -> AppResult<String> {
    match run(root, &["push"]).await {
        Ok(o) => Ok(format!("{}{}", o.stdout, o.stderr)),
        // A new branch has no upstream yet.
        Err(e) if e.message.contains("has no upstream branch") => {
            run(root, &["push", "-u", "origin", "HEAD"]).await.map(|o| format!("{}{}", o.stdout, o.stderr))
        }
        Err(e) => Err(e),
    }
}

pub async fn pull(root: &str) -> AppResult<String> {
    run(root, &["pull"]).await.map(|o| format!("{}{}", o.stdout, o.stderr))
}

pub async fn fetch(root: &str) -> AppResult<()> {
    run(root, &["fetch", "--prune"]).await.map(|_| ())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub current: Option<String>,
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

pub async fn branches(root: &str) -> AppResult<Branches> {
    let local = run(root, &["branch", "--format=%(refname:short)"]).await?.stdout;
    let remote = run(root, &["branch", "-r", "--format=%(refname:short)"]).await.map(|o| o.stdout).unwrap_or_default();
    let current = run(root, &["branch", "--show-current"]).await.ok().map(|o| o.stdout.trim().to_string()).filter(|s| !s.is_empty());
    Ok(Branches {
        current,
        local: local.lines().map(str::to_string).collect(),
        remote: remote.lines().filter(|l| !l.ends_with("/HEAD")).map(str::to_string).collect(),
    })
}

pub async fn switch(root: &str, branch: &str, create: bool) -> AppResult<()> {
    let args = if create { vec!["switch", "-c", branch] } else { vec!["switch", branch] };
    run(root, &args).await.map(|_| ())
}

/// A file's text at HEAD ("HEAD") or in the index (""), for the diff view.
/// Missing files (new, deleted) are empty.
pub async fn show(root: &str, rev: &str, path: &str) -> AppResult<String> {
    let spec = format!("{rev}:{path}");
    Ok(run(root, &["show", &spec]).await.map(|o| o.stdout).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let text = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/a b.ts\0\
2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\0old.ts\0\
u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts\0\
? notes.md\0";
        let s = parse_status("/r", text);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        let paths: Vec<(&str, char, char)> = s.files.iter().map(|f| (f.path.as_str(), f.index, f.work)).collect();
        assert_eq!(paths, [("src/a b.ts", '.', 'M'), ("new.ts", 'R', '.'), ("conflict.ts", 'U', 'U'), ("notes.md", '?', '?')]);
        assert_eq!(s.files[1].from.as_deref(), Some("old.ts"));
    }

    #[test]
    fn sums_numstat() {
        assert_eq!(parse_numstat("12\t3\tsrc/a.ts\n-\t-\timage.png\n0\t7\told.md\n"), (12, 10));
        assert_eq!(parse_numstat(""), (0, 0));
    }

    #[test]
    fn counts_lines_of_new_files() {
        let dir = std::env::temp_dir().join(format!("lookout-lines-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("b.txt"), "no newline at the end").unwrap();
        std::fs::write(dir.join("c.bin"), [0u8, 1, 2, b'\n']).unwrap();
        let paths: Vec<String> = ["a.txt", "b.txt", "c.bin", "missing.txt"].map(String::from).to_vec();
        assert_eq!(count_lines(dir.to_str().unwrap(), &paths), 3);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
