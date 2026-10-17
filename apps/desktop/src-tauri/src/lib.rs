//! OmniForge RE desktop shell.
//!
//! Responsibilities (everything else lives in the web UI and the local engine):
//!  * start the local engine ("bridge" sidecar) on a random loopback port with a per-launch secret token,
//!  * hand that token only to the app's own web view (`bridge_info`),
//!  * native folder picker, macOS Keychain storage for API keys, native menus.

use std::{
    fs::OpenOptions,
    io::Write,
    sync::Mutex,
    time::Duration,
};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Emitter, Manager, RunEvent, State,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub url: String,
    pub ui_token: String,
    pub version: String,
    pub port: u16,
}

#[derive(Default)]
struct BridgeState {
    info: Mutex<Option<BridgeInfo>>,
    error: Mutex<Option<String>>,
    child: Mutex<Option<CommandChild>>,
}

#[derive(Deserialize)]
struct Ready {
    ready: bool,
    port: u16,
    url: String,
    #[serde(rename = "uiToken")]
    ui_token: String,
}

fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Appends a line to <app log dir>/engine.log. Never receives secrets (the ready line is logged without its token).
fn log_line(app: &AppHandle, line: &str) {
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(dir.join("engine.log")) {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn start_engine(app: &AppHandle) -> Result<(), String> {
    let token = random_hex(32);
    let version = env!("CARGO_PKG_VERSION");
    let mut origins = vec!["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
    if cfg!(debug_assertions) {
        origins.extend(["http://localhost:5173", "http://127.0.0.1:5173"]);
    }
    let pw = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("playwright-core");
    let mut cmd = app
        .shell()
        .sidecar("omniforge-bridge")
        .map_err(|e| format!("engine binary missing: {e}"))?
        .args(["--port", "0"])
        .env("OMNIFORGE_UI_TOKEN", &token)
        .env("OMNIFORGE_VERSION", version)
        .env("OMNIFORGE_ALLOWED_ORIGINS", origins.join(","));
    if pw.exists() {
        cmd = cmd.env("OMNIFORGE_PLAYWRIGHT", pw.to_string_lossy().to_string());
    }
    let (mut rx, child) = cmd.spawn().map_err(|e| format!("could not start the engine: {e}"))?;
    let state = app.state::<BridgeState>();
    *state.child.lock().unwrap() = Some(child);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let st = handle.state::<BridgeState>();
            match ev {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).trim().to_string();
                    if let Ok(r) = serde_json::from_str::<Ready>(&line) {
                        if r.ready && r.ui_token == token {
                            log_line(&handle, &format!("engine ready on {}", r.url)); // token deliberately not logged
                            *st.info.lock().unwrap() = Some(BridgeInfo { url: r.url, ui_token: r.ui_token, version: version.to_string(), port: r.port });
                        } else if r.ready {
                            *st.error.lock().unwrap() = Some("The engine reported an unexpected token; refusing to use it.".into());
                        }
                    } else if !line.is_empty() {
                        log_line(&handle, &format!("engine: {line}"));
                    }
                }
                CommandEvent::Stderr(bytes) => log_line(&handle, &format!("engine! {}", String::from_utf8_lossy(&bytes).trim())),
                CommandEvent::Error(e) => {
                    log_line(&handle, &format!("engine error: {e}"));
                    *st.error.lock().unwrap() = Some(e);
                }
                CommandEvent::Terminated(p) => {
                    log_line(&handle, &format!("engine exited (code {:?})", p.code));
                    if st.info.lock().unwrap().is_none() {
                        *st.error.lock().unwrap() = Some(format!("The local engine stopped during start-up (exit code {:?}). See Help → Open Log Folder.", p.code));
                    }
                    *st.info.lock().unwrap() = None;
                    *st.child.lock().unwrap() = None;
                    let _ = handle.emit("engine:stopped", ());
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/* ------------------------------ commands ------------------------------ */

/// The web view asks for the engine address + app token. Waits (up to ~20 s) for the engine to come up.
#[tauri::command]
async fn bridge_info(state: State<'_, BridgeState>) -> Result<BridgeInfo, String> {
    for _ in 0..200 {
        if let Some(i) = state.info.lock().unwrap().clone() {
            return Ok(i);
        }
        if let Some(e) = state.error.lock().unwrap().clone() {
            return Err(e);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("The local engine did not start in time.".into())
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().set_title("Choose a folder OmniForge may read").blocking_pick_folder();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()))
}

/// The web view can leave a diagnostic line in engine.log (no secrets: the UI never has any to log besides what it chooses to send).
#[tauri::command]
fn log_event(app: AppHandle, message: String) {
    let clean: String = message.chars().filter(|c| !c.is_control()).take(500).collect();
    log_line(&app, &format!("ui: {clean}"));
}

#[tauri::command]
fn reveal_logs(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::reveal_item_in_dir(dir).map_err(|e| e.to_string())
}

fn valid_name(n: &str) -> Result<(), String> {
    if !n.is_empty() && n.len() <= 80 && n.chars().all(|c| c.is_ascii_alphanumeric() || ":_.-".contains(c)) {
        Ok(())
    } else {
        Err("Invalid credential name".into())
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use keyring::Entry;
    const SERVICE: &str = "com.omniforge.re";
    const INDEX: &str = "__index__";
    fn entry(name: &str) -> Result<Entry, String> { Entry::new(SERVICE, name).map_err(|e| e.to_string()) }
    pub fn names() -> Result<Vec<String>, String> {
        match entry(INDEX)?.get_password() {
            Ok(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
            Err(keyring::Error::NoEntry) => Ok(vec![]),
            Err(e) => Err(e.to_string()),
        }
    }
    fn save_names(n: &[String]) -> Result<(), String> { entry(INDEX)?.set_password(&serde_json::to_string(n).unwrap()).map_err(|e| e.to_string()) }
    pub fn get(name: &str) -> Result<Option<String>, String> {
        match entry(name)?.get_password() { Ok(v) => Ok(Some(v)), Err(keyring::Error::NoEntry) => Ok(None), Err(e) => Err(e.to_string()) }
    }
    pub fn set(name: &str, value: &str) -> Result<(), String> {
        entry(name)?.set_password(value).map_err(|e| e.to_string())?;
        let mut n = names()?;
        if !n.iter().any(|x| x == name) { n.push(name.to_string()); save_names(&n)?; }
        Ok(())
    }
    pub fn delete(name: &str) -> Result<(), String> {
        match entry(name)?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => {} Err(e) => return Err(e.to_string()) }
        let n: Vec<String> = names()?.into_iter().filter(|x| x != name).collect();
        save_names(&n)
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    const MSG: &str = "The Keychain is only available in the macOS app.";
    pub fn names() -> Result<Vec<String>, String> { Err(MSG.into()) }
    pub fn get(_: &str) -> Result<Option<String>, String> { Err(MSG.into()) }
    pub fn set(_: &str, _: &str) -> Result<(), String> { Err(MSG.into()) }
    pub fn delete(_: &str) -> Result<(), String> { Err(MSG.into()) }
}

#[tauri::command]
fn keychain_names() -> Result<Vec<String>, String> { keychain::names() }
#[tauri::command]
fn keychain_get(name: String) -> Result<Option<String>, String> { valid_name(&name)?; keychain::get(&name) }
#[tauri::command]
fn keychain_set(name: String, value: String) -> Result<(), String> {
    valid_name(&name)?;
    if value.len() > 20_000 { return Err("Value too large".into()); }
    keychain::set(&name, &value)
}
#[tauri::command]
fn keychain_delete(name: String) -> Result<(), String> { valid_name(&name)?; keychain::delete(&name) }

/* ------------------------------ menus ------------------------------ */

fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let nav = |id: &str, label: &str, accel: Option<&str>| {
        let b = MenuItemBuilder::with_id(format!("nav:{id}"), label);
        match accel { Some(a) => b.accelerator(a).build(app), None => b.build(app) }
    };
    let app_menu = SubmenuBuilder::new(app, "OmniForge RE")
        .about(None)
        .separator()
        .item(&nav("/settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&nav("/analyze", "New Analysis", Some("CmdOrCtrl+N"))?)
        .item(&nav("/repo-rip", "Rip a GitHub Repo…", Some("CmdOrCtrl+Shift+R"))?)
        .item(&nav("/applications", "Projects…", Some("CmdOrCtrl+O"))?)
        .item(&MenuItemBuilder::with_id("action:export-project", "Export Project…").accelerator("CmdOrCtrl+E").build(app)?)
        .separator()
        .close_window()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&nav("/", "Dashboard", Some("CmdOrCtrl+1"))?)
        .item(&nav("/analyze", "Analyze", Some("CmdOrCtrl+2"))?)
        .item(&nav("/investigations", "Investigations", Some("CmdOrCtrl+3"))?)
        .item(&nav("/studio", "AI Studio", Some("CmdOrCtrl+4"))?)
        .item(&nav("/workspace", "Code Workspace", Some("CmdOrCtrl+5"))?)
        .item(&nav("/models", "Local Models", Some("CmdOrCtrl+6"))?)
        .item(&nav("/integrations", "Integrations", Some("CmdOrCtrl+7"))?)
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("url:https://github.com/CartyChris/omniforge-re", "OmniForge RE on GitHub").build(app)?)
        .item(&MenuItemBuilder::with_id("url:https://github.com/CartyChris/omniforge-re/issues/new", "Report an Issue").build(app)?)
        .separator()
        .item(&nav("/settings", "View Diagnostics…", None)?)
        .item(&MenuItemBuilder::with_id("action:open-logs", "Open Log Folder").build(app)?)
        .build()?;
    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &window, &help]).build()
}

/* ------------------------------ app ------------------------------ */

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(BridgeState::default())
        .invoke_handler(tauri::generate_handler![bridge_info, pick_folder, log_event, reveal_logs, keychain_names, keychain_get, keychain_set, keychain_delete])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(e) = start_engine(&handle) {
                log_line(&handle, &format!("engine failed to start: {e}"));
                *handle.state::<BridgeState>().error.lock().unwrap() = Some(e);
            }
            app.set_menu(build_menu(&handle)?)?;
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref().to_string();
                if let Some(p) = id.strip_prefix("nav:") {
                    let _ = app.emit("menu:navigate", p);
                } else if let Some(a) = id.strip_prefix("action:") {
                    if a == "open-logs" { let _ = reveal_logs(app.clone()); } else { let _ = app.emit("menu:action", a); }
                } else if let Some(u) = id.strip_prefix("url:") {
                    if u.starts_with("https://github.com/CartyChris/omniforge-re") { let _ = tauri_plugin_opener::open_url(u, None::<&str>); }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building OmniForge RE")
        .run(|app, event| {
            // make sure the engine never outlives the window
            if let RunEvent::Exit = event {
                if let Some(child) = app.state::<BridgeState>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
