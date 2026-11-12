//! Claude Code's hooks (shell/claude-settings.json) save their JSON to
//! hooks/<session id>/lookout-hook.XXXXXX.json. This watches the hooks folder
//! and emits "claude-hook" with the session and the file, and the terminal of
//! that session reads it. The hooks used to tell the terminal through an escape
//! sequence written to its tty, which could land inside Claude Code's own
//! output and leave old lines and prompts on its screen.

use std::path::Path;
use std::sync::mpsc;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookFile {
    session: String,
    path: String,
}

/// The watcher, kept for as long as the app runs.
pub struct HookWatcher(#[allow(dead_code)] notify::RecommendedWatcher);

pub fn watch(app: AppHandle) -> notify::Result<HookWatcher> {
    let dir = crate::hooks_dir(&app).map_err(notify::Error::io)?;
    let dir = dir.canonicalize().unwrap_or(dir);
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(&dir, RecursiveMode::Recursive)?;
    std::thread::spawn(move || {
        for event in rx.into_iter().flatten() {
            for path in event.paths {
                if let Some(session) = hook_session(&dir, &path) {
                    let file = HookFile { session, path: path.to_string_lossy().into_owned() };
                    let _ = app.emit("claude-hook", file);
                }
            }
        }
    });
    Ok(HookWatcher(watcher))
}

/// The session of a complete hook file, `dir`/<session>/lookout-hook.XXXXXX.json.
/// A hook writes lookout-hook.XXXXXX and renames it when complete.
fn hook_session(dir: &Path, path: &Path) -> Option<String> {
    let named = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("lookout-hook.") && n.ends_with(".json"));
    let session = path.parent().filter(|p| p.parent() == Some(dir)).and_then(|p| p.file_name()).and_then(|n| n.to_str());
    if named && path.is_file() {
        session.map(str::to_string)
    } else {
        None
    }
}

/// Removes a session's folder and any hook files no terminal read.
pub fn remove_session(app: &AppHandle, id: &str) {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return;
    }
    if let Ok(dir) = crate::hooks_dir(app) {
        let folder = dir.join(id);
        if Path::new(&folder).is_dir() {
            let _ = std::fs::remove_dir_all(folder);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Runs the hook command from claude-settings.json and checks the watcher
    /// sees one complete file for the session.
    #[test]
    fn hook_file_is_seen_for_its_session() {
        let settings: serde_json::Value = serde_json::from_str(include_str!("../shell/claude-settings.json")).unwrap();
        let command = settings["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap().to_string();
        let dir = std::env::temp_dir().join(format!("lookout-hooks-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("session-1")).unwrap();
        let dir = dir.canonicalize().unwrap();
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(tx).unwrap();
        watcher.watch(&dir, RecursiveMode::Recursive).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .env("LOOKOUT_HOOKS", &dir)
            .env("LOOKOUT_SESSION", "session-1")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child.stdin.take().unwrap().write_all(br#"{"hook_event_name":"Stop"}"#).unwrap();
        assert!(child.wait().unwrap().success());

        let mut seen = std::collections::HashSet::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            let Ok(Ok(event)) = rx.recv_timeout(left) else { break };
            for path in event.paths {
                if let Some(session) = hook_session(&dir, &path) {
                    assert_eq!(session, "session-1");
                    assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"hook_event_name":"Stop"}"#);
                    seen.insert(path);
                }
            }
            if !seen.is_empty() {
                break;
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(seen.len(), 1, "the watcher saw no complete hook file");
    }
}
