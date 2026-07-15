# ⚡ KobeDB Studio — Desktop app

A native desktop shell (Electron) that boots the KobeDB + KobeDeploy server and opens the Studio dashboard in its own window — no terminal required.

- Launches the server using Electron's bundled Node (`ELECTRON_RUN_AS_NODE`), so end users don't need Node installed.
- Opens **Studio** once the server is healthy; shows a clear error screen if the database is unreachable.
- Menu actions: open Studio, restart server, open in browser, quit (stops the server).
- Stores storage/backups/functions under the OS user-data directory.

## Prerequisites

The server needs PostgreSQL. Point `DATABASE_URL` at it (defaults to the docker-compose DB `postgres://kobedb:kobedb@localhost:5432/kobedb`):

```bash
docker compose up -d db      # from the repo root
```

## Run in development

```bash
npm install                              # from repo root (needs internet for Electron)
npm run build --workspace @kobedb/server
npm start --workspace @kobedb/desktop    # opens the desktop window
```

## Build installers / executables

```bash
npm run build --workspace @kobedb/server   # server must be built first (bundled in)
npm run dist:win   --workspace @kobedb/desktop   # Windows  → release/*.exe (NSIS + portable)
npm run dist:mac   --workspace @kobedb/desktop   # macOS    → release/*.dmg
npm run dist:linux --workspace @kobedb/desktop   # Linux    → release/*.AppImage
```

Output lands in `packages/desktop/release/`. Building a Windows `.exe` from Linux/macOS
needs the standard electron-builder toolchain (e.g. Wine for Windows targets); the
simplest path is to run `dist:win` on Windows.

> Note: this app packages the **server**; it does not bundle PostgreSQL. Ship it alongside
> a Postgres instance (Docker, a managed DB, or a local install) reachable via `DATABASE_URL`.
