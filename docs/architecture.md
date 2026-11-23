# Architecture

axn-term is one shared web "shell" frontend running on top of pluggable
session backends. The desktop app embeds it in Tauri with an in-process
Rust PTY stack; the browser app runs the same UI against remote session
hosts through a WebSocket gateway. This document is the map — the
exhaustive per-area conventions live in `AGENTS.md`, developer workflow in
[development.md](development.md).

## Monorepo layout

- pnpm workspace + nx (`pnpm-workspace.yaml`, `nx.json`) for all
  TypeScript projects.
- A Cargo workspace at the root with exactly one member: the Tauri crate
  `apps/desktop/src-tauri` (`axn-term`).
- `axn-term.slnx` + `Directory.Build.props` for the two .NET services
  (`apps/gateway`, `apps/session-host`).

## The big picture

```
                       ┌────────────────────────────────────┐
                       │   libs/shell-ui — the whole app UI │
                       │ (workspaces, sessions, terminals,  │
                       │  tabs, plugins, settings, menus)   │
                       └───────────────┬────────────────────┘
                         SessionBackend + ShellServices ports
                       ┌───────────────┴────────────────────┐
                       │        libs/session-backend        │
                       └─┬──────────────┬───────────────┬───┘
                  tauriBackend      WsBackend      RemoteBackend
                  (Tauri IPC)       (gateway /ws)  (Ramphastos hub)
                         │              │               │
              ┌──────────▼───┐   ┌──────▼──────┐  ┌─────▼──────┐
              │ desktop Rust │   │   gateway   │  │  remote    │
              │  PTY stack   │   │  (.NET WS)  │  │ session VM │
              │  in-process  │   └──────┬──────┘  └────────────┘
              └──────────────┘          │
                              per-user session-host
                              container (.NET PTY/WS)
```

`apps/desktop` and `apps/web` are thin shells: each binds `libs/shell-ui`
to a `SessionBackend` implementation plus a `ShellServices` implementation
(clipboard, open-external, reveal, notifications, key-value storage,
file reader). Components never call platform APIs directly — everything
platform-specific goes through the backend/services seam, and a missing
capability is expressed as an *absent optional method* (desktop-only
actions simply disappear on web), never a stubbed no-op.

## Frontend (`libs/shell-ui` + the two app shells)

- `libs/shell-ui` — protocol-agnostic UI: workspace/session model,
  `ShellTerminal`/`SubShellView` (xterm.js + shared `terminalRenderer`
  input writer and WebGL/canvas/DOM renderer selection), context menus,
  pickers, editor/browser/git/plugin tab views, settings, themes,
  i18n (Lingui), the in-process session-plugin host.
- `apps/desktop` — Vite/React entry binding the shell to `tauriBackend` /
  `tauriServices` (`libs/session-backend/tauri`). Adds the Tauri-specific
  surfaces: settings windows, `#axn-dev` (the hmr control window), menus.
- `apps/web` — the same shell bound to `WsBackend` + `browserServices`
  behind Keycloak OIDC login; `RemoteBackend` when `VITE_RAMPHASTOS_URL`
  is set.
- `libs/session-backend` — the port and its implementations:
  `SessionBackend` (create/write/resize/output/close + optional
  fs/cwd/tty/foreground-process/default-shell probes), `ShellServices`,
  `FileReader`, plus the remote-mirroring side (`RemoteAuthority`,
  `MirrorStateStore`).
- `libs/plugin-sdk`, `libs/ui` — the external-plugin contract and the
  shared theme CSS.

## Desktop host (`apps/desktop/src-tauri`)

The Rust side owns everything a browser can't do:

- `pty.rs` — native PTY sessions: spawn the login shell, reader/writer
  plumbing, the termios `write_when_raw` gate used by the ordered
  per-PTY input queue.
- `window.rs` — window lifecycle, native titlebar tinting, the navigation
  allowlist (`is_app_navigation` keeps windows inside the app;
  `is_dev_hmr_navigation` adds the vite origin `127.0.0.1:5914` for hmr).
- `persist.rs` — `~/.axn-term/state.json`: atomic `tmp`+rename writes,
  `.bak` rotation, `.failed` quarantine; in hmr mode the state dir is
  `~/.axn-term-hmr` and state is memory-only.
- `control.rs` / `cli.rs` — the `control.sock` local socket and the
  `axn-term` CLI subcommands (`session …`, `install --skills`, …) that
  let programs inside a terminal address their own session
  (`AXN_TERM_PTY_ID`/`AXN_TERM_PTY_SECRET`/`AXN_TERM_CLI` env), and
  `command …` for app-level lines (`appRun` commands only) from any local
  process.
- `remote.rs` — the token-gated remote-control HTTP server
  (`AXN_TERM_REMOTE_CONTROL_PORT`) the flow tests drive the app through.
- `procinfo.rs`, `exec.rs`, `files.rs`, `git.rs` — foreground-process/cwd
  probes and the fs/exec/git helpers behind backend commands.
- `devhmr.rs` — the axn-term-hmr dev variant: spawns
  `pnpm exec vite --port 5914 --strictPort` in a picked checkout, tracks
  its status/log, and points session windows at the external origin.
  Enabled by the `axn-term-hmr` binary name or `AXN_TERM_HMR=1`.
- `remote.rs`/frontend `RemoteAuthority` — optionally mirrors this
  window's PTYs onto a `/remote` hub so web viewers can attach (OIDC
  device-flow sign-in, refresh token in the OS keychain).

## The online path (`apps/web` → gateway → session host)

- `apps/gateway` (.NET) terminates the browser WebSocket at `/ws`:
  validates the JWT (`GatewayAuth`, JWKS via `JwkConfigurationRetriever`),
  resolves the user (`UserIdentity`, `UserCapabilities`), ensures a
  per-user session-host container exists
  (`SessionHostContainerService`, spawned through the container-engine
  socket), then proxies the socket verbatim (`WebSocketProxy`),
  forwarding close codes — the host closes with `4001` (`pty-exited`)
  when the shell exits, and the web app treats only that as session
  death.
- `apps/session-host` (.NET) runs inside the per-user container: `PtyHost`
  owns the PTYs, `WsControlRouter` routes the JSON control messages
  (`resize`, `fs-*`, `cwd`, `exec`, `fg-process`, `session`) alongside the
  raw PTY stream, `ControlListener`/`ControlBroker` implement the
  `axn-term session …` socket inside the container.
- `RemoteBackend` (`libs/session-backend/remote`) is an alternative web
  backend that speaks to a Ramphastos hub (`/ramphastos` on a session
  host): one multiplexed connection, `createPty` commands, PTY IO on
  server-announced `pty:<id>` duplex streams.

## Plugins

- **In-process session plugins** (TSX, shipped in `libs/shell-ui`) watch
  session output through lifecycle hooks (`onOutput`, `onSessionOpen`,
  `onClose`, `onCommand`), keep per-session `pluginState` inside
  `state.json`, render side-panel UI, and provide the hidden `axn-*`
  commands. Agent plugins (`devin`, `claude`, `codex`, …), `dev-workflow`,
  `worktrees`, `awesome`, preview plugins, …
- **External `.mjs` plugins** (`plugins/`, loaded at startup) use
  `libs/plugin-sdk`.
- Per-plugin settings live in `~/.axn-term/plugins.yaml` and hot-reload
  (`<plugin>.enabled`, plugin config).

## State, config, and identity

- `~/.axn-term/` — `state.json` (windows/workspaces/sessions/tabs),
  `config.yaml` (settings, live-reloaded), `plugins.yaml`, `kv.json`.
  Desktop file/config access goes through dedicated Tauri commands, not
  the fs plugin; `$HOME` is the fs scope, widened at runtime by
  `fileAccessRoots`.
- `axn-term-hmr` keeps `~/.axn-term-hmr` and never writes `state.json` —
  dev work can't corrupt the real app's state.
- Product identity: `axn-term` / `dev.axn-term.axn-term` ships; the dev
  variant is `axn-term-hmr` / `dev.axn-term.axn-term-hmr` with its own
  yellow icon set (`src-tauri/icons-hmr/`, rebuilt by
  `build/scripts/make-macos-icon.sh hmr`).

## Testing surface

- Unit tests run through nx/vitest (`npx nx run-many -t test`); desktop
  tests via `pnpm --filter @axn-term/desktop test`.
- `flows/` — `axn-dev flow` XML end-to-end tests: desktop flows drive the
  built app over the remote-control server
  (`flows/adapters/axn-term.js`), web flows drive the `axn-term-online`
  scenario with Playwright (`flows/orchestrators/playwright.ts`).
- `tests/` — Rust-side and end-to-end node harnesses (e.g. the
  Ramphastos raw-protocol e2e). `flows/check-agent-support.py` is the
  native agent-hook contract test.
- See [development.md](development.md) for how to run all of it.
