//! Terminal sessions: the user's login shell in a pseudo-terminal. Output is
//! sent to the window as raw bytes over a channel, and xterm.js draws it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    shell_pid: Option<i32>,
}

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Session>>);

fn err(e: impl std::fmt::Display) -> AppError {
    AppError::other(e.to_string())
}

/// Variables from the process that started Lookout in development (pnpm,
/// Tauri, a Claude Code session) that would confuse programs in the terminal.
fn inherited_noise(key: &str) -> bool {
    key.starts_with("npm_")
        || key.starts_with("PNPM_")
        || key.starts_with("TAURI_")
        || matches!(key, "INIT_CWD" | "CLAUDECODE" | "CLAUDE_CODE_ENTRYPOINT" | "CLAUDE_CODE_SSE_PORT")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// The shell's working directory.
    pub cwd: Option<String>,
    /// The program in the foreground: the shell, or what it runs (claude, vim).
    pub process: Option<String>,
}

impl Sessions {
    /// Starts a login shell in `cwd` (the home folder when missing) and sends
    /// its output to `on_data`. `run` is typed into the shell once it starts.
    pub fn spawn(
        &self,
        app: AppHandle,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        run: Option<String>,
        on_data: Channel<InvokeResponseBody>,
    ) -> AppResult<String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(err)?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into());
        cmd.cwd(cwd.filter(|d| Path::new(d).is_dir()).unwrap_or(home));
        for (key, _) in std::env::vars() {
            if inherited_noise(&key) {
                cmd.env_remove(key);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Lookout");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        if std::env::var("LANG").is_err() {
            cmd.env("LANG", "en_US.UTF-8");
        }
        // Colored ls output, unless the user picked their own colors.
        if std::env::var("CLICOLOR").is_err() {
            cmd.env("CLICOLOR", "1");
        }
        if std::env::var("LSCOLORS").is_err() {
            cmd.env("LSCOLORS", "Exgxfxdxcxegedabagacad");
        }
        if shell.ends_with("/zsh") {
            let dir = app.path().app_data_dir().map_err(err)?.join("shell");
            match crate::shell::install(&dir) {
                Ok(zdotdir) => {
                    match std::env::var("ZDOTDIR") {
                        Ok(user) if Path::new(&user) != zdotdir => cmd.env("LOOKOUT_USER_ZDOTDIR", user),
                        _ => cmd.env_remove("LOOKOUT_USER_ZDOTDIR"),
                    }
                    cmd.env("ZDOTDIR", zdotdir);
                }
                // Without the files zsh starts as it would anywhere else.
                Err(e) => eprintln!("shell setup failed: {e}"),
            }
        }
        let child = pair.slave.spawn_command(cmd).map_err(err)?;
        drop(pair.slave);
        let shell_pid = child.process_id().map(|p| p as i32);
        let mut reader = pair.master.try_clone_reader().map_err(err)?;
        let mut writer = pair.master.take_writer().map_err(err)?;
        if let Some(run) = run {
            writer.write_all(format!("{run}\r").as_bytes())?;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let exit_id = id.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = app.emit("pty-exit", exit_id);
        });
        self.0.lock().unwrap().insert(id.clone(), Session { master: pair.master, writer, child, shell_pid });
        Ok(id)
    }

    fn with<T>(&self, id: &str, f: impl FnOnce(&mut Session) -> AppResult<T>) -> AppResult<T> {
        let mut sessions = self.0.lock().unwrap();
        let session = sessions.get_mut(id).ok_or_else(|| AppError::new("closed", "This terminal has closed"))?;
        f(session)
    }

    pub fn write(&self, id: &str, data: &str) -> AppResult<()> {
        self.with(id, |s| {
            s.writer.write_all(data.as_bytes())?;
            s.writer.flush()?;
            Ok(())
        })
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        self.with(id, |s| s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(err))
    }

    pub fn kill(&self, id: &str) {
        if let Some(mut session) = self.0.lock().unwrap().remove(id) {
            let _ = session.child.kill();
        }
    }

    pub fn info(&self, id: &str) -> AppResult<SessionInfo> {
        self.with(id, |s| {
            let cwd = s
                .shell_pid
                .and_then(|pid| libproc::proc_pid::pidcwd(pid).ok())
                .map(|p| p.to_string_lossy().into_owned());
            let process = s.master.process_group_leader().and_then(process_name);
            Ok(SessionInfo { cwd, process })
        })
    }
}

/// The program name of a process. Claude Code's native install runs from
/// `.../claude/versions/<version>`, so its name is the version number, and an
/// npm install runs as `node`; both are reported as "claude".
fn process_name(pid: i32) -> Option<String> {
    let name = libproc::proc_pid::name(pid).ok()?;
    if let Ok(path) = libproc::proc_pid::pidpath(pid) {
        if path.contains("/claude/versions/") || path.ends_with("/claude") {
            return Some("claude".into());
        }
    }
    if name == "node" {
        let output = std::process::Command::new("ps").args(["-o", "command=", "-p", &pid.to_string()]).output().ok()?;
        if String::from_utf8_lossy(&output.stdout).contains("claude") {
            return Some("claude".into());
        }
    }
    Some(name)
}
