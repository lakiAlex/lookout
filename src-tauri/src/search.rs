//! The Search panel: ripgrep's libraries over the open folder, respecting
//! .gitignore. A newer search stops an older one that is still running.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::overrides::OverrideBuilder;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const MAX_MATCHES: usize = 20_000;
const MAX_LINE: usize = 300;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub query: String,
    #[serde(default)]
    pub match_case: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
    /// Comma separated globs, like "src/**, *.ts".
    #[serde(default)]
    pub include: String,
    #[serde(default)]
    pub exclude: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    pub line: u64,
    /// The line, shortened around the first match when long.
    pub text: String,
    /// Matches in `text` as [start, end) in UTF-16 units, for the frontend.
    pub ranges: Vec<(usize, usize)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub rel: String,
    pub matches: Vec<LineMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<FileMatches>,
    pub total: usize,
    pub truncated: bool,
    /// Superseded by a newer search before it finished.
    pub cancelled: bool,
}

#[derive(Default)]
pub struct SearchState(pub AtomicU64);

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Shortens a long line to a window around the first match and converts the
/// match ranges from bytes to UTF-16 units.
fn shape_line(line: &str, byte_ranges: &[(usize, usize)]) -> (String, Vec<(usize, usize)>) {
    let line = line.trim_end_matches(['\n', '\r']);
    let mut start = 0;
    if line.chars().count() > MAX_LINE {
        if let Some(&(first, _)) = byte_ranges.first() {
            start = line[..first.min(line.len())].char_indices().rev().nth(40).map_or(0, |(i, _)| i);
        }
    }
    let shown: String = line[start..].chars().take(MAX_LINE).collect();
    let ranges: Vec<(usize, usize)> = byte_ranges
        .iter()
        .filter(|(s, e)| *s >= start && *e <= start + shown.len())
        .map(|(s, e)| (utf16_len(&line[start..*s]), utf16_len(&line[start..*e])))
        .collect();
    let prefix = if start > 0 { "…" } else { "" };
    let ranges = if prefix.is_empty() { ranges } else { ranges.into_iter().map(|(s, e)| (s + 1, e + 1)).collect() };
    (format!("{prefix}{shown}"), ranges)
}

pub fn search(root: &str, options: &SearchOptions, state: &SearchState) -> AppResult<SearchResult> {
    let generation = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!options.match_case)
        .word(options.whole_word)
        .fixed_strings(!options.regex)
        .build(&options.query)
        .map_err(|e| AppError::new("bad_pattern", e.to_string()))?;
    let mut overrides = OverrideBuilder::new(root);
    for glob in options.include.split(',').map(str::trim).filter(|g| !g.is_empty()) {
        overrides.add(glob).map_err(|e| AppError::new("bad_glob", e.to_string()))?;
    }
    for glob in options.exclude.split(',').map(str::trim).filter(|g| !g.is_empty()) {
        overrides.add(&format!("!{glob}")).map_err(|e| AppError::new("bad_glob", e.to_string()))?;
    }
    let overrides = overrides.build().map_err(|e| AppError::new("bad_glob", e.to_string()))?;
    let mut searcher = SearcherBuilder::new().binary_detection(BinaryDetection::quit(0)).line_number(true).build();

    let mut result = SearchResult { files: Vec::new(), total: 0, truncated: false, cancelled: false };
    let walker = ignore::WalkBuilder::new(root).hidden(false).overrides(overrides).build();
    for entry in walker.filter_map(|e| e.ok()) {
        if state.0.load(Ordering::SeqCst) != generation {
            result.cancelled = true;
            return Ok(result);
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) || entry.path().components().any(|c| c.as_os_str() == ".git") {
            continue;
        }
        let path = entry.path();
        let mut matches = Vec::new();
        let _ = searcher.search_path(
            &matcher,
            path,
            UTF8(|line_number, line| {
                let mut ranges = Vec::new();
                let _ = matcher.find_iter(line.as_bytes(), |m| {
                    ranges.push((m.start(), m.end()));
                    true
                });
                let (text, ranges) = shape_line(line, &ranges);
                matches.push(LineMatch { line: line_number, text, ranges });
                Ok(result.total + matches.len() < MAX_MATCHES)
            }),
        );
        if matches.is_empty() {
            continue;
        }
        result.total += matches.len();
        let rel = path.strip_prefix(Path::new(root)).unwrap_or(path).to_string_lossy().into_owned();
        result.files.push(FileMatches { path: path.to_string_lossy().into_owned(), rel, matches });
        if result.total >= MAX_MATCHES {
            result.truncated = true;
            break;
        }
    }
    result.files.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_and_shapes() {
        let dir = std::env::temp_dir().join(format!("lookout-search-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.ts"), "const Foo = 1;\nfoo(Foo);\n").unwrap();
        std::fs::write(dir.join("b.md"), "nothing here\nzürich foo\n").unwrap();
        let state = SearchState::default();
        let root = dir.to_string_lossy();
        let found = search(&root, &SearchOptions { query: "foo".into(), match_case: false, whole_word: true, regex: false, include: String::new(), exclude: String::new() }, &state).unwrap();
        assert_eq!(found.total, 3);
        let md = found.files.iter().find(|f| f.rel == "b.md").unwrap();
        assert_eq!(md.matches[0].ranges, vec![(7, 10)], "UTF-16 positions after ü");
        let ts_only = search(&root, &SearchOptions { query: "Foo".into(), match_case: true, whole_word: false, regex: false, include: "*.ts".into(), exclude: String::new() }, &state).unwrap();
        assert_eq!(ts_only.files.len(), 1);
        assert_eq!(ts_only.total, 2);
        let _ = std::fs::remove_dir_all(dir);
    }
}
