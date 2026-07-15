# ⚡ KobeDB Studio — Tauri desktop app

A **native, lightweight** desktop app (Tauri 2 + Rust) that boots the KobeDB + KobeDeploy server and opens the Studio dashboard in its own window. Produces a **~10 MB** binary (vs ~100 MB for Electron) and uses the OS webview — inspired by [Terax](https://github.com/crynta/terax-ai)'s Tauri approach.

Two desktop options ship in this repo:
- **`@kobedb/desktop`** — Electron (bundles its own Node; heavier, most familiar).
- **`@kobedb/desktop-tauri`** — Tauri (tiny binary, uses system webview; needs Node on the host to run the server).

## How it works

On launch the Rust shell:
1. Starts the built server (`packages/server/dist/index.js`) with Node (override the path with `KOBEDB_SERVER_ENTRY`, DB with `DATABASE_URL`).
2. Waits for the server to accept connections, then opens a native window at `http://localhost:8000/studio/`.
3. Kills the server process when the app exits.

## Prerequisites

- **Rust** toolchain and the Tauri **system dependencies** (Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`; macOS: Xcode CLT; Windows: WebView2 + MSVC).
- **Node** (to run the server) and a reachable **PostgreSQL** on `DATABASE_URL`.
- The server built first: `npm run build --workspace @kobedb/server`.

## Develop

```bash
npm run build --workspace @kobedb/server
cd packages/desktop-tauri && cargo tauri dev
```

## Build a binary / installer

```bash
npm run build --workspace @kobedb/server
cd packages/desktop-tauri
cargo tauri build          # → src-tauri/target/release + bundles (.deb/.AppImage/.msi/.dmg per OS)
```

Windows `.msi`/`.exe` and macOS `.dmg` are produced when you run `cargo tauri build` on the
respective OS. On Linux you get `.deb` and `.AppImage`.

> Icons are generated from `app-icon.png` with `cargo tauri icon app-icon.png`.
