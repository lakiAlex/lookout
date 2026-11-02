//! The Files panel and the editor: folder listings, reading and saving text
//! files, and a watcher that reports changes in the open folder.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget};

use crate::error::{AppError, AppResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    /// Matched by .gitignore; shown dimmed.
    pub ignored: bool,
}

/// Files that are never shown.
fn hidden(name: &str) -> bool {
    matches!(name, ".git" | ".DS_Store")
}

pub fn list_dir(path: &str) -> AppResult<Vec<Entry>> {
    let dir = Path::new(path);
    // What ripgrep would walk at this level; the rest is ignored by git rules.
    let visible: HashSet<PathBuf> = ignore::WalkBuilder::new(dir)
        .max_depth(Some(1))
        .hidden(false)
        .parents(true)
        .require_git(true)
        .build()
        .filter_map(|e| e.ok())
        .map(|e| e.into_path())
        .collect();
    let mut entries: Vec<Entry> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if hidden(&name) {
                return None;
            }
            let path = e.path();
            // Symlinks to folders count as folders.
            let dir = std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
            Some(Entry { ignored: !visible.contains(&path), path: path.to_string_lossy().into_owned(), name, dir })
        })
        .collect();
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| natural(&a.name).cmp(&natural(&b.name))));
    Ok(entries)
}

/// Sort key that puts "file2" before "file10" and ignores case.
fn natural(name: &str) -> Vec<(u8, u64, String)> {
    let mut out = Vec::new();
    let mut chars = name.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            let mut n = String::new();
            while let Some(&d) = chars.peek().filter(|d| d.is_ascii_digit()) {
                n.push(d);
                chars.next();
            }
            out.push((0, n.parse().unwrap_or(u64::MAX), String::new()));
        } else {
            let mut s = String::new();
            while let Some(&d) = chars.peek().filter(|d| !d.is_ascii_digit()) {
                s.extend(d.to_lowercase());
                chars.next();
            }
            out.push((1, 0, s));
        }
    }
    out
}

/// All files under `root` that git does not ignore, relative to it, for quick
/// open. Stops at 50,000.
pub fn list_files(root: &str) -> Vec<String> {
    let base = Path::new(root);
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .filter_map(|e| e.path().strip_prefix(base).ok().map(|p| p.to_string_lossy().into_owned()))
        .take(50_000)
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub text: String,
    /// Not shown in the editor: binary or larger than the limit.
    pub binary: bool,
    pub too_large: bool,
}

const MAX_EDIT_SIZE: u64 = 8 * 1024 * 1024;

pub fn read_text(path: &str) -> AppResult<FileText> {
    let size = std::fs::metadata(path)?.len();
    if size > MAX_EDIT_SIZE {
        return Ok(FileText { text: String::new(), binary: false, too_large: true });
    }
    let bytes = std::fs::read(path)?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Ok(FileText { text: String::new(), binary: true, too_large: false });
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileText { text, binary: false, too_large: false }),
        Err(_) => Ok(FileText { text: String::new(), binary: true, too_large: false }),
    }
}

/// Writes next to the file and moves it into place, so a failed write never
/// leaves half a file.
pub fn write_text(path: &str, text: &str) -> AppResult<()> {
    let target = Path::new(path);
    let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let temp = target.with_file_name(format!(".{name}.lookout-tmp"));
    std::fs::write(&temp, text)?;
    if let Ok(meta) = std::fs::metadata(target) {
        let _ = std::fs::set_permissions(&temp, meta.permissions());
    }
    std::fs::rename(&temp, target).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })?;
    Ok(())
}

pub fn create(path: &str, dir: bool) -> AppResult<()> {
    if Path::new(path).exists() {
        return Err(AppError::new("exists", "A file or folder with that name already exists"));
    }
    if dir {
        std::fs::create_dir_all(path)?;
    } else {
        if let Some(parent) = Path::new(path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, "")?;
    }
    Ok(())
}

pub fn rename(from: &str, to: &str) -> AppResult<()> {
    if Path::new(to).exists() {
        return Err(AppError::new("exists", "A file or folder with that name already exists"));
    }
    std::fs::rename(from, to)?;
    Ok(())
}

/// A name in `dir` that is free, numbered as Finder does: "notes 2.md",
/// "notes 3.md". Folders and dot files get the number at the end.
fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if std::fs::symlink_metadata(&first).is_err() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !dir.join(name).is_dir() => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} {n}{ext}")))
        .find(|p| std::fs::symlink_metadata(p).is_err())
        .unwrap()
}

/// Copies a file or folder, with symlinks copied as links.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        std::os::unix::fs::symlink(std::fs::read_link(from)?, to)
    } else if meta.is_dir() {
        std::fs::create_dir(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

/// Copies files and folders dropped from Finder into `dir`. A name that is
/// taken gets a number. Returns the new paths.
pub fn copy_into(sources: &[String], dir: &str) -> AppResult<Vec<String>> {
    let target = Path::new(dir);
    let mut copied = Vec::new();
    for source in sources {
        let from = Path::new(source);
        let name = from.file_name().and_then(|n| n.to_str()).ok_or_else(|| AppError::other(format!("Cannot copy {source}")))?;
        if target.starts_with(from) {
            return Err(AppError::new("inside", format!("{name} cannot be copied into itself")));
        }
        let to = free_name(target, name);
        copy_tree(from, &to).map_err(|e| AppError::other(format!("Could not copy {name}: {e}")))?;
        copied.push(to.to_string_lossy().into_owned());
    }
    Ok(copied)
}

/// Moves files and folders into `dir`, for drags inside the Files panel.
/// Returns each old path with its new one; items already in `dir` stay.
pub fn move_into(sources: &[String], dir: &str) -> AppResult<Vec<(String, String)>> {
    let target = Path::new(dir);
    let mut moved = Vec::new();
    for source in sources {
        let from = Path::new(source);
        let name = from.file_name().and_then(|n| n.to_str()).ok_or_else(|| AppError::other(format!("Cannot move {source}")))?;
        if from.parent() == Some(target) {
            continue;
        }
        if target.starts_with(from) {
            return Err(AppError::new("inside", format!("{name} cannot be moved into itself")));
        }
        let to = target.join(name);
        if std::fs::symlink_metadata(&to).is_ok() {
            return Err(AppError::new("exists", format!("{name} already exists in {}", target.file_name().and_then(|n| n.to_str()).unwrap_or(dir))));
        }
        std::fs::rename(from, &to)?;
        moved.push((source.clone(), to.to_string_lossy().into_owned()));
    }
    Ok(moved)
}

pub fn move_to_trash(paths: &[String]) -> AppResult<()> {
    trash::delete_all(paths).map_err(|e| AppError::other(format!("Could not move to the Trash: {e}")))
}

/// Watches a folder and emits "fs-changed" with the folders whose contents
/// changed, and "git-changed" when the repository state may have changed, to
/// the window with the label `window`.
pub fn watch(app: AppHandle, window: &str, root: &str) -> AppResult<notify::RecommendedWatcher> {
    let target = EventTarget::webview_window(window);
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| AppError::other(e.to_string()))?;
    watcher.watch(Path::new(root), RecursiveMode::Recursive).map_err(|e| AppError::other(e.to_string()))?;
    std::thread::spawn(move || {
        // Events arrive in bursts (a build, a checkout); they are sent at most
        // every 150 ms.
        loop {
            let Ok(first) = rx.recv() else { return };
            let mut events = vec![first];
            let deadline = std::time::Instant::now() + Duration::from_millis(150);
            while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
                match rx.recv_timeout(left) {
                    Ok(e) => events.push(e),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let mut dirs: HashSet<String> = HashSet::new();
            let mut git = false;
            for path in events.into_iter().filter_map(|e| e.ok()).flat_map(|e| e.paths) {
                let text = path.to_string_lossy();
                if text.contains("/.git/") || text.ends_with("/.git") {
                    // The index, HEAD and refs change on stage, commit, checkout.
                    git |= !text.contains("/.git/objects/");
                    continue;
                }
                git = true;
                if let Some(parent) = path.parent() {
                    dirs.insert(parent.to_string_lossy().into_owned());
                }
            }
            if !dirs.is_empty() {
                let _ = app.emit_to(target.clone(), "fs-changed", dirs.into_iter().collect::<Vec<_>>());
            }
            if git {
                let _ = app.emit_to(target.clone(), "git-changed", ());
            }
        }
    });
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lookout-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn numbers_taken_names() {
        let dir = temp("names");
        std::fs::write(dir.join("notes.md"), "").unwrap();
        std::fs::write(dir.join("notes 2.md"), "").unwrap();
        std::fs::create_dir(dir.join("src")).unwrap();
        assert_eq!(free_name(&dir, "notes.md"), dir.join("notes 3.md"));
        assert_eq!(free_name(&dir, "src"), dir.join("src 2"));
        assert_eq!(free_name(&dir, "new.txt"), dir.join("new.txt"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copies_and_moves_folders() {
        let dir = temp("copy");
        let outside = dir.join("Desktop");
        std::fs::create_dir_all(outside.join("pics/inner")).unwrap();
        std::fs::write(outside.join("pics/inner/a.txt"), "a").unwrap();
        let project = dir.join("project");
        std::fs::create_dir_all(project.join("assets")).unwrap();
        let source = outside.join("pics").to_string_lossy().into_owned();

        let copied = copy_into(&[source.clone()], project.to_str().unwrap()).unwrap();
        assert_eq!(std::fs::read_to_string(project.join("pics/inner/a.txt")).unwrap(), "a");
        assert!(outside.join("pics/inner/a.txt").exists(), "the original stays");
        copy_into(&[source], project.to_str().unwrap()).unwrap();
        assert!(project.join("pics 2/inner/a.txt").exists());

        let assets = project.join("assets").to_string_lossy().into_owned();
        let moved = move_into(&copied, &assets).unwrap();
        assert_eq!(moved, vec![(copied[0].clone(), project.join("assets/pics").to_string_lossy().into_owned())]);
        assert!(project.join("assets/pics/inner/a.txt").exists());
        assert!(move_into(&[assets.clone()], &format!("{assets}/pics")).is_err(), "not into itself");
        assert!(move_into(&[format!("{assets}/pics")], &assets).unwrap().is_empty(), "already there");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
