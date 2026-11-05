//! Terminal sessions: the user's login shell in a pseudo-terminal. Output is
//! sent to the window as raw bytes over a channel, and xterm.js draws it.
//! A session belongs to a window and ends when that window closes. When its
//! tab is dragged to another window, output is held until the new window
//! attaches its own channel.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

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
    /// The shell runs under /usr/bin/login, so shell_pid is login's and the
    /// shell is its child.
    via_login: bool,
    /// The label of the window the tab is in.
    owner: String,
    output: Arc<Mutex<Output>>,
}

/// Held output stops growing here, keeping the newest bytes.
const MAX_HELD: usize = 4 * 1024 * 1024;

/// Where a session's output goes: the window's channel, or held while the
/// tab is between windows.
struct Output {
    channel: Option<Channel<InvokeResponseBody>>,
    held: Vec<u8>,
}

impl Output {
    fn send(&mut self, bytes: &[u8]) {
        if let Some(channel) = &self.channel {
            if channel.send(InvokeResponseBody::Raw(bytes.to_vec())).is_ok() {
                return;
            }
            self.channel = None;
        }
        self.held.extend_from_slice(bytes);
        if self.held.len() > MAX_HELD {
            let cut = self.held.len() - MAX_HELD;
            self.held.drain(..cut);
        }
    }
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
    /// With `login` the shell starts through /usr/bin/login as in Terminal,
    /// which prints "Last login: ..." (unless ~/.hushlogin exists) and records
    /// the login for next time.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        app: AppHandle,
        owner: &str,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        run: Option<String>,
        login: bool,
        on_data: Channel<InvokeResponseBody>,
    ) -> AppResult<String> {
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(err)?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let user = std::env::var("USER").ok().filter(|u| !u.is_empty());
        let via_login = login && user.is_some() && Path::new("/usr/bin/login").exists();
        let mut cmd = if let (true, Some(user)) = (via_login, &user) {
            // -f: no password for the user who is already logged in, -p: keep
            // this environment, -l: stay in cwd. The shell's own -l keeps it a
            // login shell.
            let mut cmd = CommandBuilder::new("/usr/bin/login");
            cmd.args(["-pfl", user, &shell, "-l"]);
            cmd
        } else {
            let mut cmd = CommandBuilder::new(&shell);
            cmd.arg("-l");
            cmd
        };
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
        // Claude Code's hooks leave their JSON here and send Lookout only the
        // file's path (see shell/claude-settings.json).
        if let Ok(dir) = crate::hooks_dir(&app) {
            cmd.env("LOOKOUT_HOOKS", dir);
        }
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
        let output = Arc::new(Mutex::new(Output { channel: Some(on_data), held: Vec::new() }));
        let reader_output = output.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => reader_output.lock().unwrap().send(&buf[..n]),
                }
            }
            let _ = app.emit("pty-exit", exit_id);
        });
        let session = Session { master: pair.master, writer, child, shell_pid, via_login, owner: owner.to_string(), output };
        self.0.lock().unwrap().insert(id.clone(), session);
        Ok(id)
    }

    /// Holds the output from now on, while the tab moves to another window.
    pub fn detach(&self, id: &str) -> AppResult<()> {
        self.with(id, |s| {
            s.output.lock().unwrap().channel = None;
            Ok(())
        })
    }

    /// Sends the output to a new window: first what was held, then the rest.
    pub fn attach(&self, id: &str, owner: &str, on_data: Channel<InvokeResponseBody>) -> AppResult<()> {
        self.with(id, |s| {
            s.owner = owner.to_string();
            let mut output = s.output.lock().unwrap();
            let held = std::mem::take(&mut output.held);
            if !held.is_empty() {
                let _ = on_data.send(InvokeResponseBody::Raw(held));
            }
            output.channel = Some(on_data);
            Ok(())
        })
    }

    /// Hands a session to a window that is opening, so closing the window the
    /// tab came from does not end it.
    pub fn set_owner(&self, id: &str, owner: &str) {
        if let Some(session) = self.0.lock().unwrap().get_mut(id) {
            session.owner = owner.to_string();
        }
    }

    /// Every session's id and shell pid, for finding what runs in the terminals.
    pub fn shell_pids(&self) -> Vec<(String, i32)> {
        self.0.lock().unwrap().iter().filter_map(|(id, s)| Some((id.clone(), s.shell_pid?))).collect()
    }

    /// Ends the sessions of a window that closed.
    pub fn kill_owned_by(&self, owner: &str) {
        let mut sessions = self.0.lock().unwrap();
        let ids: Vec<String> = sessions.iter().filter(|(_, s)| s.owner == owner).map(|(id, _)| id.clone()).collect();
        for id in ids {
            if let Some(mut session) = sessions.remove(&id) {
                let _ = session.child.kill();
            }
        }
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
            // login forks the shell and waits for it.
            if s.via_login {
                let child = s.shell_pid.and_then(|pid| {
                    libproc::processes::pids_by_type(libproc::processes::ProcFilter::ByParentProcess { ppid: pid as u32 })
                        .ok()?
                        .into_iter()
                        .next()
                });
                if let Some(child) = child {
                    s.shell_pid = Some(child as i32);
                    s.via_login = false;
                }
            }
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
