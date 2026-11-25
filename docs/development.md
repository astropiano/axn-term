# Developing axn-term

Day-to-day iteration, the tooling that drives it (`axn-dev`), the flow
tests used to verify work, and the `axn-term-hmr` hot-reload dev variant.

## The everyday loop

```bash
pnpm install --frozen-lockfile
pnpm dev:desktop          # Tauri dev: vite dev server + cargo run
npx nx run-many -t test   # unit tests
pnpm typecheck            # app sources + libs tests/stories
```

`pnpm dev:desktop` already hot-reloads the frontend — but it runs *your*
checkout. To exercise frontend changes against a different
checkout/worktree without rebuilding anything, use `axn-term-hmr` below.

## axn-dev

Most dev tooling around axn-term goes through
[`axn-dev`](https://github.com/astropiano/axn-dev), a modular development
CLI for Docker Compose scenarios, flow tests, and git worktrees. Install
and `build-link.sh` instructions are in its README.

For this repo it provides:

- **Scenarios** — `axn-dev start -s axn-term-online` runs the full online
  stack (web UI + gateway + per-user session hosts behind Caddy,
  `http://axn-term.localhost:18092`); `axn-dev start -s axn-term-storybook`
  serves the component catalog on `http://localhost:8098`. Both live under
  `scenarios/` and are discovered because the command runs inside this
  checkout.
- **Flows** — `axn-dev flow -f flows/<file>.xml` runs the flow tests
  described below.
- **Worktrees** — `axn-dev git worktree add axn-term <branch>` creates a
  linked worktree under `worktrees/`, which is also the checkout
  `axn-term-hmr` can serve from.

## Flows — the way to verify development work

`flows/` holds XML-defined end-to-end tests run by `axn-dev flow`. **Run
the flows that cover the area you changed before calling work done** —
they exercise the real built app, not mocks, and catch the regressions
unit tests cannot (window restore, terminal input, OSC sequences,
file-drop, remote sign-in, …).

Desktop flows drive the built app through its remote-control HTTP server
and need the adapter registered explicitly:

```bash
axn-dev flow -f flows/axn-term-restore.xml \
  --adapter axn-term=flows/adapters/axn-term.js
```

Notes:

- They launch `target/release/axn-term` — build once first (`pnpm
  build:desktop`, or `tauri build --bundles app` for a lighter package
  step). On macOS the adapter picks the bundled `.app` binary because a
  bare binary cannot host WKWebView. A plain `cargo build` binary points
  at the vite dev URL and no frontend appears without `pnpm dev`.
- Flows run with isolated temporary state — your real `~/.axn-term` is
  untouched.
- On Wayland put `WEBKIT_DISABLE_DMABUF_RENDERER=1` in the environment.
- `flows/axn-term-hmr.xml` verifies the hmr variant end-to-end (spawned
  vite origin passes the IPC ACL, PTY writes round-trip).
- The `*-real-devin` / `*-real-claude` flows use the installed, logged-in
  agent CLIs — opt into them deliberately (see the file headers).

Web flows (`axn-term-login`, `axn-term-shortcuts`, `axn-term-remote-*`)
drive the `axn-term-online` scenario with Playwright and run without the
adapter flag. `flows/check-agent-support.py` is a separate native
contract test for the Claude/Codex hook integration (see
docs/agents.md).

## axn-term-hmr — the hot-reload dev variant

`axn-term-hmr` is a separate build product of the desktop app: the same
Rust backend and PTY stack, but session windows load the frontend from a
vite dev server it spawns inside a **checkout you pick** — a repo clone or
a worktree. Frontend edits hot-reload inside the real app (real windows,
real menus, real PTYs), while the Rust side stays whatever the dev binary
was built with.

Build and run it:

```bash
pnpm build:hmr   # → target/release/bundle/macos/axn-term-hmr.app
```

The app gets its own identity — product/bundle `axn-term-hmr`,
`dev.axn-term.axn-term-hmr` — and a dedicated **yellow icon**
(`src-tauri/icons-hmr/`, rgb(227 179 65)) so the dev build is unmistakable
next to a real axn-term in the Dock and on the taskbar.

Inside the app, the **`#axn-dev` settings window** (repo picker, vite
status/log tail, start/stop/install) controls the spawned `pnpm exec vite
--port 5914 --strictPort` in the picked checkout's `apps/desktop`. The
port is fixed because the IPC ACL pins the exact origin
`http://127.0.0.1:5914` (the hmr conf's `frontendDist`, plus the hmr-only
`capabilities/dev-hmr.json` remote url and
`window.rs::is_dev_hmr_navigation` for navigation). The shipped
`tauri.conf.json` enables only the `default` capability, so a release
build never trusts a localhost dev origin. Running the same code path
under `tauri dev` with `AXN_TERM_HMR=1` needs `-c
src-tauri/tauri.term-hmr.conf.json` for that grant.

Isolation is deliberate: state lives under `~/.axn-term-hmr` and window
state is kept **in memory** — no `state.json` is written, so the dev app
can never clobber the real app's state, while a page reload still finds
its state. `AXN_TERM_HMR=1` exercises the same code path under a plain
`pnpm dev:desktop` run.

The HMR settings window also has an opt-in **Use real axn-term state and
configuration** setting. It makes the HMR session use `~/.axn-term` for
window/session state, plugins, config, themes, KV data, and external plugins;
isolated HMR data remains the default. The setting is stored in HMR's own
control directory, and changing it requires stopping Vite first. HMR checks
the normal application's control socket before starting and refuses to start
real-state mode while the normal app is running. The warning remains visible
while the setting is enabled because both applications must not share the
same data directory concurrently.

**Use axn-term-hmr when:**

- You are iterating on the frontend (`libs/shell-ui`, `apps/desktop/src`,
  `apps/web`) and want the real app around it — actual PTYs, window
  management, plugins — instead of Storybook isolation or a rebuilt
  bundle per change.
- You work in a **git worktree**: point the repo picker at the worktree
  and its branch's frontend hot-reloads immediately — no rebuild per
  branch switch, no touching your main checkout's running app.

**Don't use it when:**

- You changed Rust code (`src-tauri/`): the spawned binary is frozen at
  build time — rebuild `pnpm build:hmr`.
- You are verifying the production frontend bundle or packaging: build
  and test the real `pnpm build:desktop` artifact.

## Developing against local ramphastos checkouts

By default everything builds against **published packages** — the
`ramphastos-client` npm package for the web/mobile frontends and the
`Ramphastos.*` NuGet packages for the .NET gateway/session host. No
sibling checkouts are needed.

To develop against freshly built local checkouts instead (e.g. a
ramphastos protocol change that has to land here and there together), set
`RAMPHASTOS_LOCAL_DEPS=1` and point `AXN_LIBS_ROOT` at the directory
**containing** the sibling checkouts (default `..` — the ramphastos
checkout sits next to axn-term):

```bash
RAMPHASTOS_LOCAL_DEPS=1 axn-dev start -s axn-term-online   # containers
RAMPHASTOS_LOCAL_DEPS=1 pnpm dev:desktop                  # vite dev server
RAMPHASTOS_LOCAL_DEPS=1 apps/mobile/build/android/build.sh # Android APK
```

With the flag on:

- MSBuild swaps `Ramphastos.*` package refs for `ProjectReference`s into
  `../ramphastos` (root overridable via `RamphastosLocalDepsRoot`;
  `totalserializer`/`reflectiontools` swap transitively through the
  ramphastos build).
- vite/vitest alias `ramphastos-client` to the sibling package —
  **rebuild its `dist/` when the client sources change**, the alias
  resolves to the built package, not the sources.
- The `axn-term-online` compose feeds `AXN_LIBS_ROOT` into the
  `libraries` build context and mounts the checkout at `/ramphastos`
  inside the shell container (see the scenario README for the plumbing
  detail and the buildx `fs.read` entitlement gotcha).
- The Android container build mounts it the same way and warns when the
  checkout is behind its upstream — a stale client ships old
  hub-protocol bugs.

The flag is deliberately opt-in: without it nothing reads, mounts, or
stats a sibling path, so worktrees and CI need no neighbouring checkouts.

## More docs

- [docs/architecture.md](architecture.md) — component map and data flow.
- [docs/agents.md](agents.md) — what the terminal exposes to AI agents.
- [docs/dev-workflow.md](dev-workflow.md) — the dev-workflow plugin.
- [docs/macos-packaging.md](macos-packaging.md) — signing & Local
  Network permission on macOS.
- `AGENTS.md` — the exhaustive per-area conventions.
