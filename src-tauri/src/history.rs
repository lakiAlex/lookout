//! Past Claude Code sessions for the history panel, read from the transcripts
//! in ~/.claude/projects (one folder per project, a .jsonl file per session).

use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::notices::{last_reply, read_transcript, session_title};

/// The most sessions the panel lists.
const LIMIT: usize = 60;
/// How much of the start of a transcript is read for its folder and first prompt.
const HEAD: u64 = 256 * 1024;
/// How much of the end is read for the session's name.
const TAIL: u64 = 512 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    /// The session id, for `claude --resume`.
    pub id: String,
    /// The folder Claude ran in; resuming has to start there.
    pub cwd: String,
    /// The name from /rename, or the one Claude Code made up.
    pub title: Option<String>,
    /// The first thing typed in the session.
    pub prompt: Option<String>,
    /// The git branch the session started on.
    pub branch: Option<String>,
    /// Last change, in milliseconds since 1970.
    pub modified: u64,
}

/// Recent sessions across all projects, newest first.
pub fn sessions() -> Vec<ClaudeSession> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let Ok(projects) = std::fs::read_dir(home.join(".claude/projects")) else { return Vec::new() };

    let mut files = Vec::new();
    for project in projects.flatten() {
        let Ok(entries) = std::fs::read_dir(project.path()) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else { continue };
            let millis = modified.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            files.push((millis, path));
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));

    files.into_iter().filter_map(|(modified, path)| session(&path, modified)).take(LIMIT).collect()
}

/// Session ids are UUIDs; anything else is not a session and must not reach the shell or a path.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Moves a session's transcript, and the folder with its subagent transcripts, to the Trash.
pub fn delete(id: &str) -> AppResult<()> {
    if !valid_id(id) {
        return Err(AppError::other("Not a Claude session id"));
    }
    let home = dirs::home_dir().ok_or_else(|| AppError::other("No home folder"))?;
    let projects = std::fs::read_dir(home.join(".claude/projects")).map_err(|e| AppError::other(e.to_string()))?;
    let mut paths = Vec::new();
    for project in projects.flatten() {
        for path in [project.path().join(format!("{id}.jsonl")), project.path().join(id)] {
            if path.exists() {
                paths.push(path.to_string_lossy().into_owned());
            }
        }
    }
    if paths.is_empty() {
        return Err(AppError::other("The conversation is already gone"));
    }
    crate::files::move_to_trash(&paths)
}

/// A session's transcript, found by its id in any project folder.
fn transcript(id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    let projects = std::fs::read_dir(dirs::home_dir()?.join(".claude/projects")).ok()?;
    projects.flatten().map(|p| p.path().join(format!("{id}.jsonl"))).find(|p| p.is_file())
}

/// Gives a session a name, the way /rename does: Claude Code and the history
/// panel use the last "custom-title" line in the transcript.
pub fn rename(id: &str, name: &str) -> AppResult<()> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(AppError::other("The name is empty"));
    }
    let path = transcript(id).ok_or_else(|| AppError::other("The conversation is gone"))?;
    let line = serde_json::json!({ "type": "custom-title", "customTitle": name, "sessionId": id });
    let mut file = OpenOptions::new().append(true).open(path).map_err(|e| AppError::other(e.to_string()))?;
    file.write_all(format!("{line}\n").as_bytes()).map_err(|e| AppError::other(e.to_string()))
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetails {
    /// Messages typed and replies from Claude, without tool calls and results.
    pub messages: u32,
    /// The branch of the last message.
    pub branch: Option<String>,
    pub last_reply: Option<String>,
    /// Input, output and cache tokens of all models.
    pub tokens: u64,
    /// What Claude Code counted the session as costing, in US dollars.
    pub cost: Option<f64>,
}

/// Message count, branch, last reply and usage, for a session's id or transcript path.
pub fn details(id_or_path: &str) -> Option<SessionDetails> {
    let path = if id_or_path.ends_with(".jsonl") { PathBuf::from(id_or_path) } else { transcript(id_or_path)? };
    let text = read_transcript(path.to_str()?, None)?;
    let mut details = SessionDetails { last_reply: last_reply(&text), ..Default::default() };
    // Claude Code writes one line per content block, all with the message's id.
    let mut replies = HashSet::new();
    let mut counted = HashSet::new();
    let mut summed_tokens = 0u64;
    let mut state_tokens = None;
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if entry["isSidechain"] == true {
            continue;
        }
        if let Some(branch) = entry["gitBranch"].as_str().filter(|b| !b.is_empty() && *b != "HEAD") {
            details.branch = Some(branch.to_string());
        }
        match entry["type"].as_str() {
            Some("user") if entry["isMeta"] != true && typed_text(&entry["message"]["content"]).is_some() => details.messages += 1,
            Some("assistant") => {
                let message = &entry["message"];
                let id = message["id"].as_str().unwrap_or_default().to_string();
                let has_text = message["content"].as_array().is_some_and(|c| c.iter().any(|b| b["type"] == "text"));
                if has_text && replies.insert(id.clone()) {
                    details.messages += 1;
                }
                if counted.insert(id) {
                    let u = &message["usage"];
                    summed_tokens += ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
                        .iter()
                        .filter_map(|k| u[*k].as_u64())
                        .sum::<u64>();
                }
            }
            Some("cost-state") => {
                details.cost = entry["totalCostUSD"].as_f64();
                state_tokens = entry["modelUsage"].as_object().map(|models| {
                    models
                        .values()
                        .map(|m| {
                            ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]
                                .iter()
                                .filter_map(|k| m[*k].as_u64())
                                .sum::<u64>()
                        })
                        .sum()
                });
            }
            _ => {}
        }
    }
    details.tokens = state_tokens.unwrap_or(summed_tokens);
    Some(details)
}

fn session(path: &Path, modified: u64) -> Option<ClaudeSession> {
    let id = path.file_stem()?.to_str()?.to_string();
    if !valid_id(&id) {
        return None;
    }
    let mut head = Vec::new();
    File::open(path).ok()?.take(HEAD).read_to_end(&mut head).ok()?;
    let head = String::from_utf8_lossy(&head);

    let mut cwd = None;
    let mut branch = None;
    let mut prompt = None;
    for line in head.lines() {
        if !line.contains("\"user\"") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if entry["type"] != "user" || entry["isMeta"] == true || entry["isSidechain"] == true {
            continue;
        }
        if cwd.is_none() {
            cwd = entry["cwd"].as_str().map(str::to_string);
        }
        if branch.is_none() {
            branch = entry["gitBranch"].as_str().filter(|b| !b.is_empty() && *b != "HEAD").map(str::to_string);
        }
        if let Some(text) = typed_text(&entry["message"]["content"]) {
            prompt = Some(text);
            break;
        }
    }
    // A session nobody typed in (Claude opened and closed) is not worth resuming.
    let prompt = prompt?;
    let title = path.to_str().and_then(|p| read_transcript(p, Some(TAIL))).and_then(|t| session_title(&t)).or_else(|| session_title(&head));
    Some(ClaudeSession { id, cwd: cwd?, title, prompt: Some(prompt), branch, modified })
}

/// What the person typed, from a user message's content. Skips command output,
/// tool results and other text Claude Code adds itself.
fn typed_text(content: &serde_json::Value) -> Option<String> {
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter(|p| p["type"] == "text")
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() || text.starts_with('<') || text.starts_with("Caveat:") || text.starts_with("[Request interrupted") {
        return None;
    }
    Some(text.chars().take(240).collect())
}

#[cfg(test)]
mod tests {
    use super::typed_text;
    use serde_json::json;

    #[test]
    fn typed_text_skips_generated_messages() {
        assert_eq!(typed_text(&json!("  list   servers\n")), Some("list servers".into()));
        assert_eq!(typed_text(&json!([{ "type": "text", "text": "fix it" }])), Some("fix it".into()));
        assert_eq!(typed_text(&json!("<command-name>/clear</command-name>")), None);
        assert_eq!(typed_text(&json!([{ "type": "tool_result", "content": "ok" }])), None);
    }
}
