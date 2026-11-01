//! The element picker: point at anything on screen, in any app, and Claude
//! gets a description of it and a screenshot. Built on macOS Accessibility.
//!
//! While picking, an event tap sees the mouse and keys of the whole system.
//! Moves are handed to a worker thread that asks Accessibility for the element
//! under the pointer and moves a highlight window over it. A click picks the
//! element (and does not reach the app), Up and Down step to the parent and
//! back, Escape cancels.

use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFGetTypeID, CFRelease, CFRetain, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use core_foundation::string::{CFString, CFStringRef};
use core_foundation::url::CFURL;
use core_graphics::event::{CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType, CallbackResult, EventField};
use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};

type AXUIElementRef = *const c_void;
type AXError = i32;
const AX_OK: AXError = 0;
const AX_VALUE_CGPOINT: u32 = 1;
const AX_VALUE_CGSIZE: u32 = 2;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct Size {
    width: f64,
    height: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyElementAtPosition(app: AXUIElementRef, x: f32, y: f32, element: *mut AXUIElementRef) -> AXError;
    fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> AXError;
    fn AXUIElementSetAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: CFTypeRef) -> AXError;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> AXError;
    fn AXUIElementGetTypeID() -> usize;
    fn AXValueGetTypeID() -> usize;
    fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

/// An accessibility element, retained while held.
struct Ax(AXUIElementRef);

impl Ax {
    fn new_owned(raw: AXUIElementRef) -> Option<Ax> {
        (!raw.is_null()).then_some(Ax(raw))
    }

    fn attr(&self, name: &'static str) -> Option<CFTypeRef> {
        let key = CFString::from_static_string(name);
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(self.0, key.as_concrete_TypeRef(), &mut value) };
        (err == AX_OK && !value.is_null()).then_some(value)
    }

    /// A text attribute; numbers, booleans and URLs are written as text.
    fn text(&self, name: &'static str) -> Option<String> {
        let value = self.attr(name)?;
        let id = unsafe { CFGetTypeID(value) };
        let text = unsafe {
            if id == CFString::type_id() {
                Some(CFString::wrap_under_create_rule(value as CFStringRef).to_string())
            } else if id == CFURL::type_id() {
                Some(CFURL::wrap_under_create_rule(value as _).get_string().to_string())
            } else if id == CFNumber::type_id() {
                CFNumber::wrap_under_create_rule(value as _).to_f64().map(|n| n.to_string())
            } else if id == CFBoolean::type_id() {
                Some(bool::from(CFBoolean::wrap_under_create_rule(value as _)).to_string())
            } else {
                CFRelease(value);
                None
            }
        };
        text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
    }

    fn element(&self, name: &'static str) -> Option<Ax> {
        let value = self.attr(name)?;
        if unsafe { CFGetTypeID(value) } == unsafe { AXUIElementGetTypeID() } {
            Some(Ax(value))
        } else {
            unsafe { CFRelease(value) };
            None
        }
    }

    fn elements(&self, name: &'static str) -> Vec<Ax> {
        let Some(value) = self.attr(name) else { return Vec::new() };
        if unsafe { CFGetTypeID(value) } != CFArray::<CFTypeRef>::type_id() {
            unsafe { CFRelease(value) };
            return Vec::new();
        }
        let array: CFArray<CFTypeRef> = unsafe { CFArray::wrap_under_create_rule(value as CFArrayRef) };
        array
            .iter()
            .filter(|item| unsafe { CFGetTypeID(**item) } == unsafe { AXUIElementGetTypeID() })
            .map(|item| {
                unsafe { CFRetain(*item) };
                Ax(*item)
            })
            .collect()
    }

    fn strings(&self, name: &'static str) -> Vec<String> {
        let Some(value) = self.attr(name) else { return Vec::new() };
        if unsafe { CFGetTypeID(value) } != CFArray::<CFTypeRef>::type_id() {
            unsafe { CFRelease(value) };
            return Vec::new();
        }
        let array: CFArray<CFTypeRef> = unsafe { CFArray::wrap_under_create_rule(value as CFArrayRef) };
        array
            .iter()
            .filter(|item| unsafe { CFGetTypeID(**item) } == CFString::type_id())
            .map(|item| unsafe { CFString::wrap_under_get_rule(*item as CFStringRef) }.to_string())
            .collect()
    }

    fn frame(&self) -> Option<Rect> {
        let mut point = Point::default();
        let mut size = Size::default();
        let position = self.attr("AXPosition")?;
        let ok = unsafe { CFGetTypeID(position) == AXValueGetTypeID() && AXValueGetValue(position, AX_VALUE_CGPOINT, &mut point as *mut _ as *mut c_void) };
        unsafe { CFRelease(position) };
        let extent = self.attr("AXSize")?;
        let ok = ok && unsafe { CFGetTypeID(extent) == AXValueGetTypeID() && AXValueGetValue(extent, AX_VALUE_CGSIZE, &mut size as *mut _ as *mut c_void) };
        unsafe { CFRelease(extent) };
        (ok && size.width > 0.0 && size.height > 0.0).then_some(Rect { x: point.x, y: point.y, width: size.width, height: size.height })
    }

    fn pid(&self) -> Option<i32> {
        let mut pid = 0;
        (unsafe { AXUIElementGetPid(self.0, &mut pid) } == AX_OK).then_some(pid)
    }

    fn same(&self, other: &Ax) -> bool {
        unsafe { core_foundation_sys::base::CFEqual(self.0, other.0) != 0 }
    }

    fn role(&self) -> String {
        self.text("AXRole").unwrap_or_default()
    }

    /// The element's name: title, then description, then a short value.
    fn name(&self) -> Option<String> {
        self.text("AXTitle")
            .or_else(|| self.text("AXDescription"))
            .or_else(|| self.text("AXValue").filter(|v| v.chars().count() <= 60))
            .or_else(|| self.text("AXPlaceholderValue"))
    }

    fn short(&self) -> String {
        let role = self.role();
        match self.name() {
            Some(name) => format!("{role} \"{}\"", clip(&name, 50)),
            None => role,
        }
    }
}

impl Clone for Ax {
    fn clone(&self) -> Self {
        unsafe { CFRetain(self.0) };
        Ax(self.0)
    }
}

impl Drop for Ax {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}

/// Appends a line to the picker log, for finding out where picking stops.
pub fn log(app: &AppHandle, line: &str) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("picker.log")) {
        use std::io::Write;
        let _ = writeln!(file, "{} {line}", chrono_now());
    }
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("[{secs}]")
}

#[derive(Serialize, Clone)]
pub struct PickerError {
    pub code: &'static str,
    pub message: String,
}

const PERMISSION_MESSAGE: &str = "Lookout needs Accessibility access to see other apps. In System Settings, Privacy & Security, Accessibility, switch Lookout on. If it is already on, switch it off and on again: macOS asks again after every new build of the app.";

fn clip(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        format!("{}…", flat.chars().take(max).collect::<String>())
    }
}

#[derive(Serialize, Clone, Copy, Debug)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What a pick gives the frontend.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub id: String,
    /// Short text for the pill, like "Slack: button Send".
    pub label: String,
    pub app: String,
    /// Markdown description for Claude.
    pub report: String,
    pub image: Option<String>,
    pub frame: Rect,
    pub bundle_id: Option<String>,
}

enum Msg {
    Move(f64, f64),
    Parent,
    Child,
    Pick,
    Cancel,
}

#[derive(Default)]
pub struct Picker {
    active: Arc<AtomicBool>,
    run_loop: Arc<Mutex<Option<SendRunLoop>>>,
}

struct SendRunLoop(CFRunLoop);
// The run loop is only used to stop it, which is safe from any thread.
unsafe impl Send for SendRunLoop {}

/// Logs where macOS put the main window's close button, measured from the
/// window's top edge, to line the buttons up with the title bar.
pub fn log_window_buttons(app: &AppHandle) {
    if !has_permission() {
        return;
    }
    let pid = std::process::id() as i32;
    let Some(own) = Ax::new_owned(unsafe { AXUIElementCreateApplication(pid) }) else { return };
    for window in own.elements("AXWindows") {
        let (Some(frame), Some(close)) = (window.frame(), window.element("AXCloseButton").and_then(|b| b.frame())) else { continue };
        log(
            app,
            &format!(
                "window buttons: close button top {:.1}, height {:.1}, center {:.1} from the window top (window {:.0}x{:.0})",
                close.y - frame.y,
                close.height,
                close.y - frame.y + close.height / 2.0,
                frame.width,
                frame.height
            ),
        );
    }
}

pub fn has_permission() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Shows the system prompt that leads to the Accessibility setting.
pub fn request_permission() -> bool {
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as *const c_void) }
}

impl Picker {
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    pub fn start(&self, app: AppHandle) -> AppResult<()> {
        let trusted = has_permission();
        log(&app, &format!("start: accessibility trusted = {trusted}"));
        if !trusted {
            request_permission();
            return Err(AppError::new("permission", PERMISSION_MESSAGE));
        }
        if self.active.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        if let Err(e) = ensure_highlight_window(&app) {
            self.active.store(false, Ordering::SeqCst);
            log(&app, &format!("highlight window failed: {}", e.message));
            return Err(e);
        }
        let (tx, rx) = mpsc::channel::<Msg>();
        let active = self.active.clone();
        let run_loop = self.run_loop.clone();

        // The event tap runs on its own thread with its own run loop.
        let tap_tx = tx.clone();
        let fail_tx = tx.clone();
        let tap_active = active.clone();
        let tap_loop = run_loop.clone();
        let tap_app = app.clone();
        std::thread::spawn(move || {
            let swallow_up = Arc::new(AtomicBool::new(false));
            let up_flag = swallow_up.clone();
            let tap = CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::Default,
                vec![
                    CGEventType::MouseMoved,
                    CGEventType::LeftMouseDragged,
                    CGEventType::LeftMouseDown,
                    CGEventType::LeftMouseUp,
                    CGEventType::RightMouseDown,
                    CGEventType::KeyDown,
                ],
                move |_proxy, kind, event| {
                    if !tap_active.load(Ordering::SeqCst) {
                        return CallbackResult::Keep;
                    }
                    match kind {
                        CGEventType::MouseMoved | CGEventType::LeftMouseDragged => {
                            let p = event.location();
                            let _ = tap_tx.send(Msg::Move(p.x, p.y));
                            CallbackResult::Keep
                        }
                        CGEventType::LeftMouseDown => {
                            let p = event.location();
                            let _ = tap_tx.send(Msg::Move(p.x, p.y));
                            let _ = tap_tx.send(Msg::Pick);
                            up_flag.store(true, Ordering::SeqCst);
                            CallbackResult::Drop
                        }
                        CGEventType::LeftMouseUp if up_flag.swap(false, Ordering::SeqCst) => CallbackResult::Drop,
                        CGEventType::RightMouseDown => {
                            let _ = tap_tx.send(Msg::Cancel);
                            CallbackResult::Drop
                        }
                        CGEventType::KeyDown => {
                            let code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                            let msg = match code {
                                53 => Some(Msg::Cancel), // Escape
                                126 => Some(Msg::Parent), // Up
                                125 => Some(Msg::Child), // Down
                                36 | 76 => Some(Msg::Pick), // Return, Enter
                                _ => None,
                            };
                            match msg {
                                Some(m) => {
                                    let _ = tap_tx.send(m);
                                    CallbackResult::Drop
                                }
                                None => CallbackResult::Keep,
                            }
                        }
                        _ => CallbackResult::Keep,
                    }
                },
            );
            let refused = |what: &str| {
                log(&tap_app, &format!("event tap failed: {what}"));
                let _ = tap_app.emit("picker-error", PickerError { code: "permission", message: PERMISSION_MESSAGE.into() });
                let _ = fail_tx.send(Msg::Cancel);
            };
            let Ok(tap) = tap else {
                refused("CGEventTapCreate returned nothing");
                return;
            };
            let Ok(source) = tap.mach_port().create_runloop_source(0) else {
                refused("no run loop source");
                return;
            };
            let current = CFRunLoop::get_current();
            current.add_source(&source, unsafe { kCFRunLoopCommonModes });
            tap.enable();
            log(&tap_app, "event tap running");
            let _ = tap_app.emit("picker-started", ());
            *tap_loop.lock().unwrap() = Some(SendRunLoop(current));
            CFRunLoop::run_current();
        });

        // Start at the pointer's current position.
        if let Ok(event) = core_graphics::event::CGEvent::new(
            core_graphics::event_source::CGEventSource::new(core_graphics::event_source::CGEventSourceStateID::HIDSystemState)
                .map_err(|_| AppError::other("Could not read the pointer position"))?,
        ) {
            let p = event.location();
            let _ = tx.send(Msg::Move(p.x, p.y));
        }

        std::thread::spawn(move || {
            work(app.clone(), rx);
            active.store(false, Ordering::SeqCst);
            if let Some(rl) = run_loop.lock().unwrap().take() {
                rl.0.stop();
            }
            if let Some(w) = app.get_webview_window("highlight") {
                let _ = w.hide();
            }
        });
        Ok(())
    }

    pub fn cancel(&self) {
        self.active.store(false, Ordering::SeqCst);
        if let Some(rl) = self.run_loop.lock().unwrap().take() {
            rl.0.stop();
        }
    }
}

fn ensure_highlight_window(app: &AppHandle) -> AppResult<()> {
    if app.get_webview_window("highlight").is_some() {
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, "highlight", WebviewUrl::App("highlight.html".into()))
        .title("Lookout highlight")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|e| AppError::other(e.to_string()))?;
    window.set_ignore_cursor_events(true).map_err(|e| AppError::other(e.to_string()))?;
    Ok(())
}

/// Chromium and Electron apps (Chrome, Slack, VS Code) only build the
/// accessibility tree of their web content when asked.
fn enable_web_accessibility(handle: &AppHandle, pid: i32, done: &mut Vec<i32>) {
    if done.contains(&pid) {
        return;
    }
    done.push(pid);
    if let Some(app) = Ax::new_owned(unsafe { AXUIElementCreateApplication(pid) }) {
        let key = CFString::from_static_string("AXManualAccessibility");
        let err = unsafe { AXUIElementSetAttributeValue(app.0, key.as_concrete_TypeRef(), CFBoolean::true_value().as_CFTypeRef()) };
        log(handle, &format!("AXManualAccessibility for pid {pid}: {}", if err == AX_OK { "on".to_string() } else { format!("error {err}") }));
    }
}

fn element_at(system: &Ax, x: f64, y: f64) -> Option<Ax> {
    let mut raw: AXUIElementRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyElementAtPosition(system.0, x as f32, y as f32, &mut raw) };
    if err == AX_OK { Ax::new_owned(raw) } else { None }
}

fn show_highlight(app: &AppHandle, element: &Ax, label: &str) {
    let Some(window) = app.get_webview_window("highlight") else { return };
    let Some(frame) = element.frame() else {
        let _ = window.hide();
        return;
    };
    let pad = 3.0;
    let _ = window.set_position(LogicalPosition::new(frame.x - pad, frame.y - pad));
    let _ = window.set_size(LogicalSize::new(frame.width + pad * 2.0, frame.height + pad * 2.0));
    let label = serde_json::to_string(label).unwrap_or_default();
    let _ = window.eval(format!("window.setLabel && window.setLabel({label})"));
    let _ = window.show();
}

fn work(app: AppHandle, rx: Receiver<Msg>) {
    let Some(system) = Ax::new_owned(unsafe { AXUIElementCreateSystemWide() }) else { return };
    unsafe { AXUIElementSetMessagingTimeout(system.0, 0.3) };
    let own_pid = std::process::id() as i32;
    let mut web_enabled: Vec<i32> = Vec::new();
    // chain[0] is the element under the pointer; Up adds its parents.
    let mut chain: Vec<Ax> = Vec::new();
    let mut level = 0usize;
    let mut pending: Option<Msg> = None;
    loop {
        let msg = match pending.take() {
            Some(m) => m,
            None => match rx.recv_timeout(Duration::from_secs(120)) {
                Ok(m) => m,
                Err(_) => return,
            },
        };
        // Only the latest pointer position matters; anything else after it waits its turn.
        let msg = match msg {
            Msg::Move(mut x, mut y) => {
                while let Ok(next) = rx.try_recv() {
                    match next {
                        Msg::Move(nx, ny) => (x, y) = (nx, ny),
                        other => {
                            pending = Some(other);
                            break;
                        }
                    }
                }
                Msg::Move(x, y)
            }
            other => other,
        };
        match msg {
            Msg::Move(x, y) => {
                let Some(mut hit) = element_at(&system, x, y) else { continue };
                let Some(mut pid) = hit.pid() else { continue };
                if pid == own_pid {
                    // Probably the highlight box itself: still inside the shown element, nothing changes.
                    let inside = chain.get(level).and_then(Ax::frame).is_some_and(|f| x >= f.x && x <= f.x + f.width && y >= f.y && y <= f.y + f.height);
                    if inside {
                        continue;
                    }
                    if let Some(w) = app.get_webview_window("highlight") {
                        let _ = w.hide();
                    }
                    std::thread::sleep(Duration::from_millis(20));
                    let Some(again) = element_at(&system, x, y) else { continue };
                    let Some(again_pid) = again.pid() else { continue };
                    if again_pid == own_pid {
                        continue;
                    }
                    (hit, pid) = (again, again_pid);
                }
                if chain.is_empty() {
                    log(&app, &format!("first element: {} in pid {pid}", hit.short()));
                }
                enable_web_accessibility(&app, pid, &mut web_enabled);
                if chain.first().is_some_and(|c| c.same(&hit)) {
                    continue;
                }
                chain = vec![hit];
                level = 0;
            }
            Msg::Parent => {
                if level + 1 < chain.len() {
                    level += 1;
                } else if let Some(parent) = chain.last().and_then(|e| e.element("AXParent")) {
                    if parent.role() != "AXApplication" {
                        chain.push(parent);
                        level += 1;
                    }
                }
            }
            Msg::Child => level = level.saturating_sub(1),
            Msg::Cancel => return,
            Msg::Pick => {
                let Some(element) = chain.get(level).cloned() else { return };
                if let Some(w) = app.get_webview_window("highlight") {
                    let _ = w.hide();
                }
                // Let the highlight disappear before the screenshot.
                std::thread::sleep(Duration::from_millis(80));
                let pick = describe(&app, &element);
                log(&app, &format!("picked: {} (image: {})\n{}", pick.label, pick.image.is_some(), pick.report));
                let _ = app.emit("picked", pick);
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.set_focus();
                }
                return;
            }
        }
        if let Some(element) = chain.get(level) {
            let label = format!("{}{}", element.short(), if level > 0 { format!("  ↑{level}") } else { String::new() });
            show_highlight(&app, element, &label);
        }
    }
}

/// The app bundle that a process runs from, and its bundle identifier.
fn bundle_of(pid: i32) -> (Option<String>, Option<String>) {
    let Ok(path) = libproc::proc_pid::pidpath(pid) else { return (None, None) };
    let Some(end) = path.find(".app/") else { return (None, None) };
    let bundle = &path[..end + 4];
    let plist = format!("{bundle}/Contents/Info.plist");
    let id = std::process::Command::new("plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-", &plist])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    (Some(bundle.to_string()), id)
}

/// Visible text inside an element, gathered breadth first.
fn visible_text(element: &Ax, max_chars: usize) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut queue = std::collections::VecDeque::from([element.clone()]);
    let mut seen = 0;
    let mut total = 0;
    while let Some(e) = queue.pop_front() {
        seen += 1;
        if seen > 400 || total > max_chars {
            break;
        }
        let role = e.role();
        if role == "AXStaticText" || role == "AXTextField" || role == "AXTextArea" || role == "AXLink" || role == "AXButton" {
            if let Some(text) = e.text("AXValue").or_else(|| e.text("AXTitle")).or_else(|| e.text("AXDescription")) {
                total += text.len();
                out.push(clip(&text, 300));
                continue;
            }
        }
        queue.extend(e.elements("AXChildren"));
    }
    out.join(" | ")
}

fn describe(app: &AppHandle, element: &Ax) -> Pick {
    let frame = element.frame().unwrap_or(Rect { x: 0.0, y: 0.0, width: 0.0, height: 0.0 });
    let pid = element.pid().unwrap_or(0);
    let (bundle, bundle_id) = bundle_of(pid);
    let app_name = bundle
        .as_deref()
        .and_then(|b| b.rsplit('/').next())
        .map(|n| n.trim_end_matches(".app").to_string())
        .unwrap_or_else(|| libproc::proc_pid::name(pid).unwrap_or_default());

    // Ancestors, from the element up to the window.
    let mut ancestors: Vec<Ax> = Vec::new();
    let mut current = element.element("AXParent");
    let mut web_area: Option<Ax> = None;
    while let Some(e) = current {
        let role = e.role();
        if role == "AXApplication" {
            break;
        }
        if role == "AXWebArea" && web_area.is_none() {
            web_area = Some(e.clone());
        }
        current = e.element("AXParent");
        ancestors.push(e);
        if ancestors.len() > 40 {
            break;
        }
    }
    let window = element.element("AXWindow").and_then(|w| w.text("AXTitle"));

    let role = element.role();
    let role_description = element.text("AXRoleDescription").unwrap_or_else(|| role.clone());
    let name = element.name();
    let mut lines = vec![format!("## Element picked on screen ({app_name})"), String::new()];
    lines.push(format!("- **App:** {app_name}{}", bundle_id.as_deref().map(|b| format!(" (`{b}`)")).unwrap_or_default()));
    if let Some(w) = &window {
        lines.push(format!("- **Window:** {w}"));
    }
    if let Some(web) = &web_area {
        if let Some(url) = web.text("AXURL") {
            lines.push(format!("- **Page URL:** {url}"));
        }
        if let Some(title) = web.text("AXTitle") {
            lines.push(format!("- **Page title:** {title}"));
        }
    }
    lines.push(format!(
        "- **Element:** {role_description}{} (`{role}`{})",
        name.as_deref().map(|n| format!(" \"{}\"", clip(n, 120))).unwrap_or_default(),
        element.text("AXSubrole").map(|s| format!(", `{s}`")).unwrap_or_default()
    ));
    for (label, attr) in [("Value", "AXValue"), ("Description", "AXDescription"), ("Help", "AXHelp"), ("Placeholder", "AXPlaceholderValue"), ("Identifier", "AXIdentifier"), ("Link", "AXURL")] {
        if let Some(text) = element.text(attr) {
            if Some(&text) != name.as_ref() {
                lines.push(format!("- **{label}:** {}", clip(&text, 600)));
            }
        }
    }
    if let Some(id) = element.text("AXDOMIdentifier") {
        lines.push(format!("- **DOM id:** `{id}`"));
    }
    let classes = element.strings("AXDOMClassList");
    if !classes.is_empty() {
        lines.push(format!("- **DOM classes:** `{}`", classes.join(" ")));
    }
    lines.push(format!(
        "- **On screen:** {}×{} points at x {}, y {}",
        frame.width.round(),
        frame.height.round(),
        frame.x.round(),
        frame.y.round()
    ));
    if !ancestors.is_empty() {
        let path: Vec<String> = ancestors.iter().rev().filter(|a| a.name().is_some() || a.role() == "AXWindow").map(Ax::short).collect();
        lines.push(format!("- **Inside:** {}", path.join(" > ")));
    }
    let children = element.elements("AXChildren");
    if !children.is_empty() {
        let list: Vec<String> = children.iter().take(12).map(Ax::short).collect();
        lines.push(format!("- **Contains ({}):** {}{}", children.len(), list.join(", "), if children.len() > 12 { ", …" } else { "" }));
    }
    let text = visible_text(element, 2000);
    if !text.is_empty() {
        lines.push(String::new());
        lines.push(format!("**Visible text:** {}", clip(&text, 2000)));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let image = screenshot(app, &id, frame);
    if let Some(path) = &image {
        lines.push(String::new());
        lines.push(format!("Screenshot of the element: {path}"));
    }
    let label = format!("{app_name}: {}", clip(&format!("{role_description}{}", name.map(|n| format!(" {n}")).unwrap_or_default()), 48));
    Pick { id, label, app: app_name, report: lines.join("\n"), image, frame, bundle_id }
}

/// Captures the element's area with the system `screencapture` tool. Needs
/// Screen Recording permission; without it the capture shows only the desktop.
fn screenshot(app: &AppHandle, id: &str, frame: Rect) -> Option<String> {
    if frame.width < 1.0 || frame.height < 1.0 {
        return None;
    }
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        log(app, "screenshot skipped: no Screen Recording access");
        // Adds Lookout to the Screen Recording list and shows the system prompt the first time.
        unsafe { CGRequestScreenCaptureAccess() };
        let _ = app.emit(
            "picker-error",
            PickerError {
                code: "screen",
                message: "The pick was sent without a screenshot. For screenshots, switch Lookout on in System Settings, Privacy & Security, Screen & System Audio Recording, then quit and reopen Lookout.".into(),
            },
        );
        return None;
    }
    let dir: PathBuf = app.path().app_cache_dir().ok()?.join("picks");
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join(format!("pick-{id}.png"));
    let region = format!("{},{},{},{}", frame.x.round(), frame.y.round(), frame.width.round(), frame.height.round());
    let output = std::process::Command::new("screencapture").args(["-x", "-R", &region, "-t", "png"]).arg(&file).output().ok()?;
    if !output.status.success() || !file.exists() {
        log(app, &format!("screencapture failed ({}): {}", output.status, String::from_utf8_lossy(&output.stderr).trim()));
        return None;
    }
    Some(file.to_string_lossy().into_owned())
}
