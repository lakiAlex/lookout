mod error;
mod files;
mod git;
mod picker;
mod pty;
mod search;
mod shell;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

use error::{AppError, AppResult};
use files::{Entry, FileText};
use pty::{SessionInfo, Sessions};
use search::{SearchOptions, SearchResult, SearchState};

struct AppState {
    sessions: Sessions,
    picker: picker::Picker,
    /// Off in Settings: the ⌥⌘E shortcut does nothing.
    picker_enabled: std::sync::atomic::AtomicBool,
    search: SearchState,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    recent_path: PathBuf,
}

// ---- Terminal ----

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<AppState>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    run: Option<String>,
    on_data: Channel<InvokeResponseBody>,
) -> AppResult<String> {
    state.sessions.spawn(app, cwd, cols, rows, run, on_data)
}

#[tauri::command]
fn pty_write(state: State<AppState>, id: String, data: String) -> AppResult<()> {
    state.sessions.write(&id, &data)
}

#[tauri::command]
fn pty_resize(state: State<AppState>, id: String, cols: u16, rows: u16) -> AppResult<()> {
    state.sessions.resize(&id, cols, rows)
}

#[tauri::command]
fn pty_kill(state: State<AppState>, id: String) {
    state.sessions.kill(&id);
}

#[tauri::command]
fn pty_info(state: State<AppState>, id: String) -> AppResult<SessionInfo> {
    state.sessions.info(&id)
}

// ---- Element picker ----

/// Starts picking, or stops when already picking. Errors go to the window.
fn toggle_picker(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.picker.is_active() {
        state.picker.cancel();
        return;
    }
    if !state.picker_enabled.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    if let Err(e) = state.picker.start(app.clone()) {
        let _ = app.emit("picker-error", picker::PickerError { code: e.code, message: e.message });
    }
}

/// Puts text on the clipboard, for the terminal's copy on select.
#[tauri::command]
fn copy_text(text: String) -> AppResult<()> {
    use std::io::Write;
    let mut child = std::process::Command::new("pbcopy").stdin(std::process::Stdio::piped()).spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes())?;
    }
    child.wait()?;
    Ok(())
}

#[tauri::command]
fn open_accessibility_settings() {
    let _ = std::process::Command::new("open").arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").status();
}

#[tauri::command]
fn picker_start(app: AppHandle) {
    toggle_picker(&app);
}

#[tauri::command]
fn picker_set_enabled(state: State<AppState>, enabled: bool) {
    state.picker_enabled.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
fn picker_cancel(state: State<AppState>) {
    state.picker.cancel();
}

#[tauri::command]
fn picker_permission() -> bool {
    picker::has_permission()
}

// ---- Files ----

#[tauri::command]
async fn list_dir(path: String) -> AppResult<Vec<Entry>> {
    tauri::async_runtime::spawn_blocking(move || files::list_dir(&path)).await.map_err(|e| AppError::other(e.to_string()))?
}

#[tauri::command]
async fn list_files(root: String) -> AppResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || files::list_files(&root)).await.map_err(|e| AppError::other(e.to_string()))
}

#[tauri::command]
fn read_file(path: String) -> AppResult<FileText> {
    files::read_text(&path)
}

#[tauri::command]
fn write_file(path: String, text: String) -> AppResult<()> {
    files::write_text(&path, &text)
}

#[tauri::command]
fn create_path(path: String, dir: bool) -> AppResult<()> {
    files::create(&path, dir)
}

#[tauri::command]
fn rename_path(from: String, to: String) -> AppResult<()> {
    files::rename(&from, &to)
}

#[tauri::command]
fn trash_paths(paths: Vec<String>) -> AppResult<()> {
    files::move_to_trash(&paths)
}

#[tauri::command]
fn watch_folder(app: AppHandle, state: State<AppState>, path: String) -> AppResult<()> {
    let watcher = files::watch(app, &path)?;
    *state.watcher.lock().unwrap() = Some(watcher);
    Ok(())
}

#[tauri::command]
fn home_dir() -> String {
    dirs::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default()
}

// ---- Recent folders ----

fn read_recent(state: &AppState) -> Vec<String> {
    std::fs::read_to_string(&state.recent_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn recent_folders(state: State<AppState>) -> Vec<String> {
    read_recent(&state).into_iter().filter(|p| std::path::Path::new(p).is_dir()).collect()
}

#[tauri::command]
fn add_recent_folder(state: State<AppState>, path: String) -> Vec<String> {
    let mut list = read_recent(&state);
    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(15);
    let _ = std::fs::write(&state.recent_path, serde_json::to_string_pretty(&list).unwrap_or_default());
    list
}

// ---- Search ----

#[tauri::command]
async fn search_files(app: AppHandle, root: String, options: SearchOptions) -> AppResult<SearchResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        search::search(&root, &options, &state.search)
    })
    .await
    .map_err(|e| AppError::other(e.to_string()))?
}

// ---- Git ----

#[tauri::command]
async fn git_status(path: String) -> AppResult<Option<git::Status>> {
    git::status(&path).await
}

#[tauri::command]
async fn git_stage(root: String, paths: Vec<String>) -> AppResult<()> {
    git::stage(&root, &paths).await
}

#[tauri::command]
async fn git_unstage(root: String, paths: Vec<String>) -> AppResult<()> {
    git::unstage(&root, &paths).await
}

#[tauri::command]
async fn git_discard(root: String, tracked: Vec<String>, untracked: Vec<String>) -> AppResult<()> {
    git::discard(&root, &tracked, &untracked).await
}

#[tauri::command]
async fn git_commit(root: String, message: String, amend: bool) -> AppResult<String> {
    git::commit(&root, &message, amend).await
}

#[tauri::command]
async fn git_push(root: String) -> AppResult<String> {
    git::push(&root).await
}

#[tauri::command]
async fn git_pull(root: String) -> AppResult<String> {
    git::pull(&root).await
}

#[tauri::command]
async fn git_fetch(root: String) -> AppResult<()> {
    git::fetch(&root).await
}

#[tauri::command]
async fn git_branches(root: String) -> AppResult<git::Branches> {
    git::branches(&root).await
}

#[tauri::command]
async fn git_switch(root: String, branch: String, create: bool) -> AppResult<()> {
    git::switch(&root, &branch, create).await
}

#[tauri::command]
async fn git_show(root: String, rev: String, path: String) -> AppResult<String> {
    git::show(&root, &rev, &path).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            // Option+Command+E picks an element anywhere on screen.
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([Shortcut::new(Some(Modifiers::ALT | Modifiers::SUPER), Code::KeyE)])
                .map_err(|e| e.to_string())
                .expect("shortcut")
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_picker(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(AppState {
                sessions: Sessions::default(),
                picker: picker::Picker::default(),
                picker_enabled: std::sync::atomic::AtomicBool::new(true),
                search: SearchState::default(),
                watcher: Mutex::new(None),
                recent_path: dir.join("recent-folders.json"),
            });
            picker::log(app.handle(), &format!("launch: accessibility trusted = {}", picker::has_permission()));
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                picker::log_window_buttons(&handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            picker_start,
            picker_cancel,
            picker_permission,
            open_accessibility_settings,
            picker_set_enabled,
            copy_text,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_info,
            list_dir,
            list_files,
            read_file,
            write_file,
            create_path,
            rename_path,
            trash_paths,
            watch_folder,
            home_dir,
            recent_folders,
            add_recent_folder,
            search_files,
            git_status,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            git_push,
            git_pull,
            git_fetch,
            git_branches,
            git_switch,
            git_show,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
