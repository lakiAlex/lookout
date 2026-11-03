//! Local servers started from Lookout's terminals: TCP ports in the listening
//! state whose process descends from one of the terminal shells.

use std::collections::{HashMap, HashSet};
use std::process::Command;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub port: u16,
    pub pid: i32,
    /// The program's name, like node or php.
    pub process: String,
    /// The terminal session it runs in.
    pub session_id: String,
}

/// Ports listened on by processes under the given terminal shells, by port.
pub fn listening(shells: &[(String, i32)]) -> Vec<ListeningPort> {
    if shells.is_empty() {
        return Vec::new();
    }
    let parents = parents();
    let roots: HashMap<i32, &str> = shells.iter().map(|(id, pid)| (*pid, id.as_str())).collect();
    let session_of = |mut pid: i32| -> Option<String> {
        // Walk up the process tree until a terminal shell, or the top.
        for _ in 0..64 {
            if let Some(id) = roots.get(&pid) {
                return Some(id.to_string());
            }
            pid = *parents.get(&pid)?;
            if pid <= 1 {
                return None;
            }
        }
        None
    };

    let Ok(out) = Command::new("/usr/sbin/lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN", "-FpcnT"]).output() else { return Vec::new() };
    let mut ports = Vec::new();
    let mut seen = HashSet::new();
    let (mut pid, mut process) = (0, String::new());
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let (tag, value) = line.split_at(line.len().min(1));
        match tag {
            "p" => pid = value.parse().unwrap_or(0),
            "c" => process = value.to_string(),
            "n" => {
                let Some(port) = value.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else { continue };
                if !seen.insert(port) {
                    continue;
                }
                if let Some(session_id) = session_of(pid) {
                    ports.push(ListeningPort { port, pid, process: process.clone(), session_id });
                }
            }
            _ => {}
        }
    }
    ports.sort_by_key(|p| p.port);
    ports
}

/// Every process's parent, from ps.
fn parents() -> HashMap<i32, i32> {
    let Ok(out) = Command::new("/bin/ps").args(["-axo", "pid=,ppid="]).output() else { return HashMap::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
        })
        .collect()
}
