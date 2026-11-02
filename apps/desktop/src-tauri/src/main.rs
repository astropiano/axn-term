// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // CLI subcommands (`axn-term install --skills …`) run without starting the
    // app; no arguments, options and paths fall through to the GUI.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = axn_shell_lib::cli::run_cli(&args) {
        std::process::exit(code);
    }
    axn_shell_lib::run()
}
