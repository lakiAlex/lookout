//! Notifications: Claude finishing or needing input, long commands ending and
//! messages programs send to the terminal. All windows list them under the
//! bell in the title bar. A notification from a tab you are not looking at
//! also pops up as a card in the Lookout window in front, or, while another
//! app is in front, as a macOS notification.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget};
use tauri_plugin_notification::NotificationExt;

/// Older notifications are dropped.
const KEEP: usize = 100;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: u64,
    /// "claude", "claude-input", "done", "failed" or "message"; sets the icon.
    pub kind: String,
    pub title: String,
    pub body: String,
    pub tab_id: String,
    pub tab_title: String,
    /// Milliseconds since 1970.
    pub time: u64,
    pub read: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNotice {
    pub kind: String,
    pub title: String,
    pub body: String,
    pub tab_id: String,
    pub tab_title: String,
    /// The tab is the one showing in its window.
    pub tab_active: bool,
    /// macOS notifications are on in Settings.
    pub banner: bool,
}

#[derive(Default)]
pub struct Notices {
    list: Mutex<Vec<Notice>>,
    next: AtomicU64,
}

impl Notices {
    /// Adds a notification from a tab in the window `source`. When the tab is
    /// in view in the window in front it is stored as read and nothing pops up.
    pub fn post(&self, app: &AppHandle, source: &str, focused: Option<String>, new: NewNotice) {
        let seen = new.tab_active && focused.as_deref() == Some(source);
        let notice = Notice {
            id: self.next.fetch_add(1, Ordering::Relaxed) + 1,
            kind: new.kind,
            title: new.title,
            body: new.body,
            tab_id: new.tab_id,
            tab_title: new.tab_title,
            time: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
            read: seen,
        };
        {
            let mut list = self.list.lock().unwrap();
            list.insert(0, notice.clone());
            list.truncate(KEEP);
        }
        self.changed(app);
        if seen {
            return;
        }
        match focused {
            Some(front) => {
                let _ = app.emit_to(EventTarget::webview_window(&front), "notice-peek", notice);
            }
            None if new.banner => {
                let body = if notice.body.is_empty() { notice.tab_title.clone() } else { notice.body.clone() };
                let _ = app.notification().builder().title(&notice.title).body(body).show();
            }
            None => {}
        }
    }

    pub fn list(&self) -> Vec<Notice> {
        self.list.lock().unwrap().clone()
    }

    pub fn mark_read(&self, app: &AppHandle) {
        for notice in self.list.lock().unwrap().iter_mut() {
            notice.read = true;
        }
        self.changed(app);
    }

    pub fn remove(&self, app: &AppHandle, id: u64) {
        self.list.lock().unwrap().retain(|n| n.id != id);
        self.changed(app);
    }

    pub fn clear(&self, app: &AppHandle) {
        self.list.lock().unwrap().clear();
        self.changed(app);
    }

    /// Marks a notification read and asks the window with its tab to show it.
    pub fn open(&self, app: &AppHandle, id: u64) {
        let tab = {
            let mut list = self.list.lock().unwrap();
            let Some(notice) = list.iter_mut().find(|n| n.id == id) else { return };
            notice.read = true;
            notice.tab_id.clone()
        };
        self.changed(app);
        // Tabs move between windows, so every window checks whether it has it.
        let _ = app.emit("activate-tab", tab);
    }

    fn changed(&self, app: &AppHandle) {
        let _ = app.emit("notices", self.list());
    }
}

/// The start of Claude's last reply in a Claude Code transcript (a JSON line
/// per message), for the notification when Claude finishes. Only files under
/// ~/.claude are read.
pub fn claude_reply(path: &str) -> Option<String> {
    let home = dirs::home_dir()?;
    let path = Path::new(path).canonicalize().ok()?;
    if !path.starts_with(home.join(".claude")) || path.extension().is_none_or(|e| e != "jsonl") {
        return None;
    }
    // The reply is near the end; long transcripts are only read from there.
    let mut file = std::fs::File::open(&path).ok()?;
    let length = file.metadata().ok()?.len();
    let tail = 512 * 1024;
    if length > tail {
        file.seek(SeekFrom::Start(length - tail)).ok()?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    last_reply(&String::from_utf8_lossy(&bytes))
}

/// The text of the last assistant message that is not from a subagent,
/// shortened to one line of up to 180 characters.
pub fn last_reply(transcript: &str) -> Option<String> {
    transcript.lines().rev().find_map(|line| {
        let entry: serde_json::Value = serde_json::from_str(line).ok()?;
        if entry["type"] != "assistant" || entry["isSidechain"] == true {
            return None;
        }
        let text: Vec<&str> = entry["message"]["content"]
            .as_array()?
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect();
        let plain = text.join(" ").replace("**", "").replace('`', "");
        let words: Vec<&str> = plain.split_whitespace().filter(|w| !w.chars().all(|c| c == '#')).collect();
        if words.is_empty() {
            return None;
        }
        let line = words.join(" ");
        Some(if line.chars().count() > 180 { format!("{}…", line.chars().take(179).collect::<String>().trim_end()) } else { line })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_last_reply() {
        let transcript = [
            r#"{"type":"user","message":{"role":"user","content":"Fix the build"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Looking at it."}]}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"Subagent text"}]}}"#,
            r###"{"type":"assistant","message":{"content":[{"type":"text","text":"## Done\n\nThe **build** passes now with `pnpm build`."}]}}"###,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}"#,
            r#"{"type":"last-prompt","lastPrompt":"Fix the build"}"#,
            "not json",
        ]
        .join("\n");
        assert_eq!(last_reply(&transcript).as_deref(), Some("Done The build passes now with pnpm build."));
    }

    #[test]
    fn shortens_long_replies() {
        let long = format!(r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{}"}}]}}}}"#, "word ".repeat(100));
        let reply = last_reply(&long).unwrap();
        assert_eq!(reply.chars().count(), 180);
        assert!(reply.ends_with('…'));
    }

    #[test]
    fn no_reply_without_text() {
        assert_eq!(last_reply(r#"{"type":"assistant","message":{"content":[{"type":"thinking"}]}}"#), None);
    }
}
