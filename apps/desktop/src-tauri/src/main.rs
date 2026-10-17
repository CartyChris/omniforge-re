// Prevents an extra console window on Windows release builds (harmless elsewhere).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    omniforge_re_lib::run()
}
