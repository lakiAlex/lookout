//! Lookout's windows. The first is "main" from tauri.conf.json; ⌘N and tabs
//! dragged out of the tab bar open more, labeled "w-1", "w-2" and so on. Each
//! window has its own folder, tabs and file watcher.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindowBuilder, Window};

use crate::error::{AppError, AppResult};

/// True for Lookout's own windows, false for the picker's highlight box.
pub fn is_app_window(label: &str) -> bool {
    label == "main" || label.starts_with("w-")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewWindow {
    /// What the window opens with (its folder, and a tab moved from another
    /// window), handed to its page as it is.
    pub start: Value,
    /// The terminal session of a moved tab, which the new window then owns.
    pub session: Option<String>,
    /// Where a dragged tab was dropped, in screen points. The window opens
    /// with its tab bar under the pointer.
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Default)]
pub struct Windows {
    next: AtomicU32,
    /// Start data of windows that are opening, until their page asks for it.
    pending: Mutex<HashMap<String, Value>>,
    /// The Lookout window in front, or None while another app is active.
    focused: Mutex<Option<String>>,
    /// The Lookout window used last.
    last: Mutex<Option<String>>,
}

impl Windows {
    /// Opens a window with the size of `from`, a little below and to the right
    /// of it, or at the drop point. Without `from` it opens as the first
    /// window does.
    pub fn open(&self, app: &AppHandle, from: Option<&Window>, request: &NewWindow) -> AppResult<String> {
        let label = format!("w-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let mut config = app.config().app.windows.first().cloned().ok_or_else(|| AppError::other("No window configuration"))?;
        config.label = label.clone();
        if let Some(from) = from {
            let scale = from.scale_factor().unwrap_or(1.0);
            if let Ok(size) = from.inner_size() {
                config.width = size.width as f64 / scale;
                config.height = size.height as f64 / scale;
            }
            if let (None, Ok(position)) = (request.x, from.outer_position()) {
                config.x = Some(position.x as f64 / scale + 28.0);
                config.y = Some(position.y as f64 / scale + 28.0);
            }
        }
        if let (Some(x), Some(y)) = (request.x, request.y) {
            config.x = Some(x - 300.0);
            config.y = Some(y - 19.0);
        }
        self.pending.lock().unwrap().insert(label.clone(), request.start.clone());
        let built = WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build());
        if let Err(e) = built {
            self.pending.lock().unwrap().remove(&label);
            return Err(AppError::other(format!("Could not open a window: {e}")));
        }
        Ok(label)
    }

    /// The start data for a window's page, given once.
    pub fn take_start(&self, label: &str) -> Option<Value> {
        self.pending.lock().unwrap().remove(label)
    }

    pub fn set_focus(&self, label: &str, focused: bool) {
        let mut current = self.focused.lock().unwrap();
        if focused {
            *current = Some(label.to_string());
            *self.last.lock().unwrap() = Some(label.to_string());
        } else if current.as_deref() == Some(label) {
            *current = None;
        }
    }

    pub fn closed(&self, label: &str) {
        self.set_focus(label, false);
        self.pending.lock().unwrap().remove(label);
        let mut last = self.last.lock().unwrap();
        if last.as_deref() == Some(label) {
            *last = None;
        }
    }

    pub fn focused(&self) -> Option<String> {
        self.focused.lock().unwrap().clone()
    }

    /// The window used last, or else any open Lookout window.
    pub fn front(&self, app: &AppHandle) -> Option<String> {
        let last = self.last.lock().unwrap().clone();
        last.filter(|label| app.get_webview_window(label).is_some())
            .or_else(|| app.webview_windows().into_keys().filter(|l| is_app_window(l)).min())
    }
}

/// Sends an event to the window used last, for picks and picker messages.
/// Returns its label.
pub fn emit_front<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) -> Option<String> {
    let label = app.state::<Windows>().front(app)?;
    let _ = app.emit_to(EventTarget::webview_window(&label), event, payload);
    Some(label)
}

/// The id of the Dock menu's New Window item, in menu events.
pub const NEW_WINDOW_ITEM: &str = "dock-new-window";

/// New Window in the Dock menu: the window used last opens one on its folder,
/// as with ⌘N. With no window open, a fresh one opens.
pub fn new_window_from_dock(app: &AppHandle) {
    if emit_front(app, "new-window", ()).is_none() {
        let request = NewWindow { start: serde_json::json!({ "folder": null, "tab": null }), session: None, x: None, y: None };
        let _ = app.state::<Windows>().open(app, None, &request);
    }
}

/// The menu macOS shows when the Dock icon is right-clicked. tao, under Tauri,
/// has no setting for it, so the method AppKit asks for, applicationDockMenu:,
/// is added to tao's app delegate. The item is a muda menu item, so a click
/// arrives as a Tauri menu event. Call on the main thread.
#[cfg(target_os = "macos")]
pub fn install_dock_menu() {
    use std::ffi::c_void;
    use std::sync::atomic::AtomicPtr;

    use muda::ContextMenu;
    use objc2::runtime::{AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel};

    static MENU: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    unsafe extern "C-unwind" fn dock_menu(_delegate: *mut AnyObject, _cmd: Sel, _app: *mut AnyObject) -> *mut AnyObject {
        MENU.load(Ordering::Relaxed).cast()
    }

    let item = muda::MenuItem::with_id(NEW_WINDOW_ITEM, "New Window", true, None);
    let menu = muda::Menu::new();
    if menu.append(&item).is_err() {
        return;
    }
    MENU.store(menu.ns_menu(), Ordering::Relaxed);
    // AppKit asks for the menu on every right-click, for as long as the app runs.
    std::mem::forget((menu, item));

    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![app, delegate];
        let Some(delegate_ref) = delegate.as_ref() else { return };
        let imp: Imp = std::mem::transmute(dock_menu as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut AnyObject);
        let class = delegate_ref.class() as *const _ as *mut objc2::runtime::AnyClass;
        objc2::ffi::class_addMethod(class, sel!(applicationDockMenu:), imp, c"@@:@".as_ptr());
        // AppKit checks what the delegate answers to when it is set.
        let _: () = msg_send![app, setDelegate: delegate];
    }
}
