# OMNI-CELL desktop shell (Tauri 2)

The web UI in `web/app` runs unchanged inside a native window. The shell adds an installer,
a dock/taskbar icon, the `.omni` file association, native open/save dialogs and atomic
project writes (`write_project`: temp file + rename). Ciphertext only: decryption stays in the
webview, the shell never holds K_m or K_d.

## Build (on your PC, not done in the sandbox)

Prerequisites: Rust stable, Node 20+, and the Tauri 2 platform prerequisites
(Windows: WebView2 runtime + Visual Studio Build Tools with the C++ workload).

```
npm install
cargo install tauri-cli --version "^2"
cd desktop/src-tauri
cargo tauri dev        # window around http://localhost:5173
cargo tauri build      # installers under desktop/src-tauri/target/release/bundle
```

`icons/icon.png` is a 512x512 placeholder; replace it and run `cargo tauri icon icons/icon.png`
to generate the platform icon set.

## What the shell does not do yet

- Native tablet input (DirectInput / Wintab / IOKit / libinput, Phase 3): the webview still
  receives pointer events from WebView2, so pressure and tilt come through the browser path.
  The next step is a Rust `tablet` module that reads the OS HID stack and emits samples to the
  webview at 200 Hz; the UI already accepts external samples through `StrokeDriver`.
- Auto-update and code signing.
