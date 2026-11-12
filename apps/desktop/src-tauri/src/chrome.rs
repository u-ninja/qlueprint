//! Window chrome. Windows and Linux get no OS title bar: the UI draws its own, with the menu bar
//! and window buttons (src/components/shell/TopBar.tsx). macOS keeps its traffic lights, over
//! the UI's title bar, and gets a native menu bar from `menu` below.

use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime, WebviewWindowBuilder};

/// Emitted to the UI with the clicked item's id as payload.
pub const MENU_EVENT: &str = "menu";

/// Where the macOS traffic lights sit: centred in the UI's 44px title bar, at its 14px left padding
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: (f64, f64) = (14.0, 15.0);

/// Hides the OS title bar, keeping only the macOS window buttons.
pub fn title_bar<'a, R: Runtime, M: tauri::Manager<R>>(
    window: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "macos")]
    let window = window
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(
            TRAFFIC_LIGHTS.0,
            TRAFFIC_LIGHTS.1,
        ));
    #[cfg(not(target_os = "macos"))]
    let window = window.decorations(false);
    window
}

/// AppKit puts the traffic lights back at their default spot when the window's frame changes (a
/// restored size, maximize, a resize), and tao only re-places them on its own redraws. Re-place
/// them now and after every resize, the same way tao does.
#[cfg(target_os = "macos")]
pub fn keep_traffic_lights<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let place = |w: &tauri::WebviewWindow<R>| {
        if let Ok(ns_window) = w.ns_window() {
            // SAFETY: Tauri's NSWindow for this live window, used on the main thread (setup and
            // window events run there)
            place_traffic_lights(unsafe { &*ns_window.cast::<objc2_app_kit::NSWindow>() });
        }
    };
    place(window);
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Resized(_) = event {
            place(&handle);
        }
    });
}

/// tao's `inset_traffic_lights`: a title bar tall enough for the offset, then the buttons at x
#[cfg(target_os = "macos")]
fn place_traffic_lights(window: &objc2_app_kit::NSWindow) {
    use objc2_app_kit::NSWindowButton;
    let (x, y) = TRAFFIC_LIGHTS;
    let buttons = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .map(|b| window.standardWindowButton(b));
    let [Some(close), Some(minimize), Some(zoom)] = buttons else {
        return;
    };
    // SAFETY: AppKit's own button views, in the window that owns them
    let Some(title_bar) = (unsafe { close.superview().and_then(|v| v.superview()) }) else {
        return;
    };
    let close_rect = close.frame();
    let mut bar = title_bar.frame();
    bar.size.height = close_rect.size.height + y;
    bar.origin.y = window.frame().size.height - bar.size.height;
    title_bar.setFrame(bar);
    let gap = minimize.frame().origin.x - close_rect.origin.x;
    for (i, button) in [close, minimize, zoom].iter().enumerate() {
        let mut origin = button.frame().origin;
        origin.x = x + i as f64 * gap;
        button.setFrameOrigin(origin);
    }
}

/// One menu item. Ids are the UI's menu actions (src/components/shell/menu.ts); `None` for the
/// accelerator means no shortcut. Items whose feature isn't built yet are shown disabled.
fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
    built: bool,
) -> tauri::Result<MenuItem<R>> {
    let mut builder = MenuItemBuilder::with_id(id, text).enabled(built);
    if let Some(accelerator) = accelerator {
        builder = builder.accelerator(accelerator);
    }
    builder.build(app)
}

/// The macOS menu bar: the same items as the in-app menu on Windows and Linux, plus the
/// standard app and Window menus. Edit uses the native items so text shortcuts work everywhere.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = SubmenuBuilder::new(app, "QluePrint")
        .about(None)
        .separator()
        .item(&item(
            app,
            "settings",
            "Settings…",
            Some("CmdOrCtrl+,"),
            false,
        )?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item(
            app,
            "new-query",
            "New Query",
            Some("CmdOrCtrl+T"),
            true,
        )?)
        .item(&item(app, "new-connection", "New Connection…", None, true)?)
        .item(&item(
            app,
            "open-file",
            "Open SQL File…",
            Some("CmdOrCtrl+O"),
            false,
        )?)
        .separator()
        .item(&item(app, "save", "Save", Some("CmdOrCtrl+S"), true)?)
        .separator()
        // ⌘W closes the tab, as in a browser or editor; the window moves to ⇧⌘W
        .item(&item(
            app,
            "close-tab",
            "Close Tab",
            Some("CmdOrCtrl+W"),
            true,
        )?)
        .item(&item(
            app,
            "close-window",
            "Close Window",
            Some("CmdOrCtrl+Shift+W"),
            true,
        )?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let theme = SubmenuBuilder::new(app, "Theme")
        .item(&item(app, "theme-light", "Light", None, true)?)
        .item(&item(app, "theme-dark", "Dark", None, true)?)
        .item(&item(app, "theme-system", "Match System", None, true)?)
        .build()?;

    let motion = SubmenuBuilder::new(app, "Motion")
        .item(&item(app, "motion-spring", "Spring Physics", None, true)?)
        .item(&item(app, "motion-subtle", "Subtle", None, true)?)
        .item(&item(app, "motion-off", "Reduced", None, true)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item(
            app,
            "command-palette",
            "Command Palette…",
            Some("CmdOrCtrl+Shift+P"),
            true,
        )?)
        .separator()
        .item(&item(app, "view-workspace", "Workspace", None, true)?)
        .item(&item(app, "view-connections", "Connections", None, true)?)
        .item(&item(app, "view-queries", "Queries", None, true)?)
        .item(&item(app, "view-history", "History", None, true)?)
        .item(&item(app, "view-audit", "Audit Log", None, true)?)
        .separator()
        .item(&item(
            app,
            "toggle-sidebar",
            "Toggle Sidebar",
            Some("CmdOrCtrl+B"),
            true,
        )?)
        .item(&item(
            app,
            "toggle-inspector",
            "Toggle Inspector",
            None,
            true,
        )?)
        .separator()
        .item(&theme)
        .item(&motion)
        .separator()
        .fullscreen()
        .build()?;

    let query = SubmenuBuilder::new(app, "Query")
        .item(&item(app, "run", "Run", Some("CmdOrCtrl+Enter"), true)?)
        .item(&item(app, "stop", "Stop", None, false)?)
        .separator()
        .item(&item(app, "explain", "Explain", Some("CmdOrCtrl+E"), true)?)
        .item(&item(
            app,
            "explain-analyze",
            "Explain Analyze",
            Some("CmdOrCtrl+Shift+E"),
            true,
        )?)
        .item(&item(app, "format", "Format", Some("Alt+Shift+F"), true)?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&item(app, "shortcuts", "Keyboard Shortcuts", None, false)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &query, &window, &help])
        .build()
}

/// Hands menu clicks to the UI, which runs the action. Native items (Edit, Quit…) never get here.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn forward_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let _ = app.emit(MENU_EVENT, event.id().as_ref());
}
