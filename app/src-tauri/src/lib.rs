mod api;
mod core;
mod organizer;
mod renamer;

use tauri::AppHandle;

use std::sync::atomic::Ordering;

use core::config::Config;
use core::state::AppState;

use tauri::{
  Manager,
  menu::{Menu, MenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  WebviewWindowBuilder,
};


fn get_or_create_main_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
  if let Some(w) = app.get_webview_window("main") {
    return Some(w);
  }

  let cfg = app
    .config()
    .app
    .windows
    .iter()
    .find(|w| w.label == "main")?;

  WebviewWindowBuilder::from_config(app, cfg).ok()?.build().ok()
}

fn show_main(app: &AppHandle) {
  let Some(w) = get_or_create_main_window(app) else { return; };
  let _ = w.unminimize();
  let _ = w.show();
  let _ = w.set_focus();
}

fn toggle_main(app: &tauri::AppHandle) {
  let Some(w) = get_or_create_main_window(app) else { return; };

  let visible = w.is_visible().unwrap_or(false);
  if visible {
    let _ = w.hide();
  } else {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
  }
}

fn close_splash_after_start(app: tauri::AppHandle) {
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    for _ in 0..60 {
      if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
        break;
      }
      tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
  });
}

pub fn run() {
  let cfg = match Config::from_env() {
    Ok(c) => c,
    Err(e) => {
      eprintln!("[FATAL] configuration error: {e}");
      eprintln!("Hint: check UTUBEHOLIC_BIND, UTUBEHOLIC_DOWNLOAD_DIR, UTUBEHOLIC_SQLITE_PATH");
      std::process::exit(1);
    }
  };

  let (state, rx) = match AppState::new(cfg.clone()) {
    Ok(v) => v,
    Err(e) => {
      eprintln!("[FATAL] state initialization failed: {e}");
      eprintln!("Hint: ensure download directory and SQLite path are accessible");
      std::process::exit(1);
    }
  };

  let bind = cfg.bind;
  
  let mut builder = tauri::Builder::default();

  #[cfg(desktop)]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      show_main(&app);
    }));
  }

  builder
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .manage(state.clone())
    .setup(move |app| {
      // make handle available for event stream + sidecar path resolution
      state.set_app_handle(app.handle().clone());

      // --- Tray icon (system tray) ---
      // Right-click: menu (Show/Hide, Quit)
      // Left-click: toggle window
      let toggle_i = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
      let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&toggle_i, &quit_i])?;

      TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
          "toggle" => toggle_main(app),
          "quit" => {
            let st = app.state::<std::sync::Arc<AppState>>();
            st.quitting.store(true, Ordering::SeqCst);
            app.exit(0);
          }
          _ => {}
        })
        .on_tray_icon_event(|tray, event| {
          if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
          } = event
          {
            toggle_main(&tray.app_handle());
          }
        })
        .build(app)?;
      // --- /Tray icon ---

      // startup: show splash -> close -> tray-only
      close_splash_after_start(app.handle().clone());

      // start API server (extension compatibility)
      let api_state = state.clone();
      tauri::async_runtime::spawn(async move {
        api_state.log_line(format!("[api] binding http://{bind}"));
        if let Err(e) = api::server::serve(api_state, bind).await {
          eprintln!("api server error: {e}");
        }
      });

      // start downloader worker
      let worker_state = state.clone();
      tauri::async_runtime::spawn(async move {
        core::downloader::start_worker(worker_state, rx).await;
      });

      // initial status push
      state.emit_status_throttled(std::time::Duration::from_millis(0));

      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main" {
          let _ = window.hide();
          api.prevent_close();
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      organizer::scan_folder,
      organizer::start_move,
      renamer::open_path,
      renamer::load_settings,
      renamer::save_settings,
      renamer::renamer_expand_inputs,
      renamer::renamer_preview_names,
      renamer::renamer_apply_rename,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      if let tauri::RunEvent::ExitRequested { api, .. } = event {
        let st = app.state::<std::sync::Arc<AppState>>();
        if !st.quitting.load(Ordering::SeqCst) {
          api.prevent_exit();
        }
      }
    });
}
