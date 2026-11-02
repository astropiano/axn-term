# axn-term

Terminal workspace app for axn-term: a Tauri desktop app and a browser
version backed by per-user remote session hosts.

## Status

**Pre-alpha.** The project is under active development and there are no
published releases — no signed DMGs, installers, or nightly builds. If you
want to try it, you build it yourself from source (see Getting started);
expect rough edges, breaking changes between commits, and no upgrade path
for persisted state yet.

Axn-term started as an exploration of developer experience rather than as
another terminal. It's an alternative take on what tools like
agterm or Warp are doing — a workspace built around an
HTML-based shell, where the terminal is the foundation but sessions,
agent workflows, code intelligence, Git review flows, and plugins are
first-class, and where humans and coding agents work in the same windows.
It continues an older idea: that a shell rendered in HTML can be far more
interactive than a classic grid of glyphs — hover cards, pickers, live
session plugins, cross-device mirrors.

Honest caveat: if what you want today is raw terminal performance,
agterm (built on Ghostty) is the better choice right now — a GPU-native
renderer with years of hardening. axn-term trades some of that speed for
the flexibility an HTML shell buys; whether that trade-off is worth it is
part of what this project is trying to find out.

## Layout

- `apps/desktop/` — Tauri desktop app.
  - `src/` — Vite/React entry that binds the shared UI (`libs/shell-ui`) to the Tauri backend.
  - `src-tauri/` — Rust Tauri host (`axn-term` crate; the only Cargo workspace member).
- `apps/web/` — browser app: the same shared UI over the gateway's `/ws` protocol, with Keycloak login.
- `apps/gateway/` — .NET WebSocket gateway: validates JWTs, spawns a session-host container per user and proxies to it.
- `apps/session-host/` — .NET PTY/WebSocket server running inside each per-user container.
- `libs/` — shared TS libraries: `shell-ui` (protocol-agnostic UI), `session-backend` (backend port + Tauri/WebSocket adapters), `plugin-sdk`, `ui` (theme CSS).
- `plugins/` — example external plugins.
- `flows/` — axn-dev flow tests (desktop restore flows, web Playwright flows).
- `scenarios/` — axn-dev scenarios: `axn-term-online` (web + gateway + session hosts behind Caddy), `axn-term-storybook`.
- `build/` — Docker builders and packaging scripts for the desktop app.

See `AGENTS.md` for the conventions in each area.

## Prerequisites

- Node.js 22+
- pnpm 10
- Rust + Cargo (install from https://rustup.rs)
- Tauri system dependencies: https://tauri.app/start/prerequisites/
- .NET 10 SDK (gateway / session host; only for running them outside containers)

## Getting started

```bash
# Install JS/TS dependencies
pnpm install --frozen-lockfile

# Run the desktop app in development mode
pnpm dev:desktop

# Run the unit tests
npx nx run-many -t test
```

## Scripts

- `pnpm dev:desktop` — start the Tauri desktop app.
- `pnpm build:desktop` — build the desktop app for release.
- `pnpm build:desktop:docker` — build the desktop app in the Docker builder.
- `pnpm serve:web` — serve the web app (`nx serve web`).
- `pnpm dev:gateway` — run the .NET gateway.
- `pnpm build:dotnet` — build the gateway and session host.

### Linux Wayland startup

If WebKitGTK exits with `Error 71 (Protocol error) dispatching to Wayland
display`, try the per-launch renderer workaround:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 pnpm dev:desktop
```

This keeps Wayland enabled but disables WebKit's DMA-BUF renderer for this
process. It may reduce rendering performance. Tauri's JavaScript API and
plugin versions must also match their Rust counterparts; install the checked-in
lockfile with `pnpm install --frozen-lockfile` after pulling dependency updates.

An SELinux denial is a separate issue: check the affected path's label with
`matchpathcon` before changing policy. A checkout inherited from a privately
relabelled container mount may need its normal labels restored; preserve the
labels on paths still used as container bind mounts.

## Running the online scenario on rootless podman / SELinux

`scenarios/axn-term-online` (web UI + .NET gateway + per-user session hosts
behind Caddy, default `http://axn-term.localhost:18092`) starts with
`axn-dev start -s axn-term-online`. On a rootless-podman/SELinux host
(Fedora) three things differ from Docker:

1. **Engine socket.** The gateway spawns session hosts through the engine
   socket. Enable the user socket and point the scenario at it:

   ```bash
   systemctl --user enable --now podman.socket
   cp scenarios/axn-term-online/.env.example scenarios/axn-term-online/.env
   ```

   `.env` (gitignored) sets `DOCKER_SOCK=/run/user/1000/podman/podman.sock`
   — adjust the UID. The gateway runs with `label=disable` because SELinux
   otherwise denies the container access to the socket.
2. **Session-host image.** The `session-host` service has `scale: 0`, and
   podman-compose never builds services it doesn't start, so on a fresh
   machine the gateway has no `axn-term-host` image to spawn. Build it once
   (and after changing `apps/session-host` or `session-host/`):

   ```bash
   CONTAINER_ENGINE=podman scenarios/axn-term-online/build-session-host.sh
   # equivalent to:
   podman build --build-context axn-term=. -t axn-term-host \
     -f scenarios/axn-term-online/session-host/Dockerfile \
     scenarios/axn-term-online/session-host
   ```
3. **Shared nx workspace.** The `shell` container serves `nx serve web` from
   the bind-mounted checkout, so it shares `.nx` with the host. It runs with
   `NX_DAEMON=false` and `restart: unless-stopped` so host nx commands no
   longer kill the dev server for good, and installs with
   `--frozen-lockfile` so it never rewrites the host's `pnpm-lock.yaml` —
   keep the lockfile in sync (`pnpm install --frozen-lockfile` on the host).

Desktop flows (`flows/axn-term-restore*.xml` etc.) on Wayland need
`WEBKIT_DISABLE_DMABUF_RENDERER=1` (see above).

The web flows drive the scenario with Playwright (`playwright-core` from
`pnpm install`, plus a Playwright Chromium in `~/.cache/ms-playwright` or
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`). Run them from inside this checkout —
`axn-term-online` is a project scenario, which axn-dev only finds as a
fallback from the repo it is invoked in:

```bash
axn-dev flow -f flows/axn-term-login.xml
axn-dev flow -f flows/axn-term-shortcuts.xml
```

## Reproducible Docker builders

The `docker-compose.build.yml` and `build/` directory share a common Docker builder pattern:

- `build/desktop/Dockerfile` — Node + Rust + Tauri Linux build environment.
- `build/windows/Dockerfile` — Node + Rust + cargo-xwin + NSIS, cross-compiles the Windows app.
- `build/init-builders.sh` — build the builder images once.
- `build/build-desktop.sh` — compile the desktop app and place artifacts in `./artifacts/`.
- `build/build-desktop-windows.sh` — cross-compile the Windows installer into `./artifacts/windows/`.
- `build/build-server.sh` — build the online server images (`server` profile).
- `build/build-all.sh` — both of the above.

```bash
# Set up builder images (one-time)
./build/init-builders.sh

# Build everything in Docker
./build/build-all.sh

# Or run the desktop builder directly
docker compose -f docker-compose.build.yml run --rm desktop-build
```

Desktop output lands in `artifacts/desktop/{bin,bundle}/`. The online server
(.NET `apps/gateway` + `apps/session-host`) ships as container images, not
host binaries: `build/build-server.sh` builds `axn-term-gateway:latest` and
`axn-term-host:latest` from the same Dockerfiles and tags the
`axn-term-online` scenario uses, so the scenario runs what it builds. Build
them into the engine the gateway's `DOCKER_SOCK` points at.

## Releases

Versions follow [SemVer](https://semver.org) and come from git tags
(`vMAJOR.MINOR.PATCH`, optionally with a pre-release part like `-rc.1`). The
version in `package.json`/`tauri.conf.json`/`Cargo.toml` stays at its
development value; release builds stamp the tag's version in
(`build/scripts/set-version.sh`).

To cut a release:

1. Tag the commit on the branch you release from and push the tag:

   ```bash
   git tag v1.4.0
   git push origin v1.4.0
   ```

2. In GitLab: **Build → Pipelines → Run pipeline**, select the tag `v1.4.0`,
   **Run pipeline**.

The pipeline (`.gitlab-ci.yml`) checks the tag is a SemVer release tag,
builds the builder images from `build/desktop` and `build/windows`, builds
the Linux (deb, rpm, AppImage, Arch package) and Windows (NSIS installer)
apps, uploads them to the project's package registry and publishes a GitLab
release for the tag with download links. Pushing a tag alone does not start
a build, and no pipeline runs for branches or MRs.

## Building the desktop app locally

### Option A — Docker builder (recommended, no host Rust needed)

```bash
# Build the desktop app in a container
./build/build-desktop.sh

# Or use the pnpm wrapper
pnpm build:desktop:docker
```

This writes the artifacts to `./artifacts/desktop/`:

- `artifacts/desktop/bin/axn-term` — raw Linux binary
- `artifacts/desktop/bundle/` — installer packages (`.deb`, `.AppImage`, etc.)
- `artifacts/desktop/axn-term-*.pkg.tar.zst` — Arch Linux pacman package

### Windows build

The Windows app is cross-compiled on Linux (target `x86_64-pc-windows-msvc`,
via [cargo-xwin](https://github.com/rust-cross/cargo-xwin)), so no Windows
machine is needed:

```bash
./build/build-desktop-windows.sh
# or: pnpm build:desktop:windows
```

This writes:

- `artifacts/windows/bundle/axn-term_<version>_x64-setup.exe` — NSIS installer
  (per-user install; downloads the WebView2 runtime if it is missing)
- `artifacts/windows/bin/axn-term.exe` — raw executable

The first run downloads the MSVC CRT and Windows SDK (~700 MB) into the
`desktop-xwin-cache` volume. Only NSIS is built — MSI needs WiX, which only
runs on Windows. The installer is unsigned, so SmartScreen warns on first
launch.

On Windows new terminals open PowerShell 7 (`pwsh`) if installed, else
Windows PowerShell; `$SHELL` or the configured shell still wins. Not yet
available on Windows: `axn-term session …` from inside a terminal (needs the
Unix control socket), foreground-process and cwd tracking, and the
login-shell PATH lookup.

### Arch Linux install

Install the built package directly with `pacman`:

```bash
sudo pacman -U artifacts/desktop/axn-term-*.pkg.tar.zst
```

This places the binary at `/usr/bin/axn-term` and a `.desktop` entry under `/usr/share/applications/`, with dependencies declared on the Tauri runtime libraries.

Run the built app:

```bash
# Option 1: run the AppImage
chmod +x artifacts/desktop/bundle/appimage/*.AppImage
./artifacts/desktop/bundle/appimage/*.AppImage

# Option 2: run the raw binary (Tauri/WebKitGTK system libs must be installed)
./artifacts/desktop/bin/axn-term
```

### Option B — host toolchain (faster iterative dev)

Requires Rust, Cargo, the Tauri Linux system dependencies, and pnpm installed locally:

```bash
pnpm install
pnpm dev:desktop      # hot-reload dev mode
# or
pnpm build:desktop    # release build
```
