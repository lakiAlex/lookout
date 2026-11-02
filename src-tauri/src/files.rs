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
