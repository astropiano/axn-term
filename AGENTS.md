# Project conventions for axn-term

## Apps and shared libraries

- `apps/desktop` — Tauri desktop app; binds the shared UI to `tauriBackend` /
  `tauriServices` from `@axn-term/session-backend/tauri`. A dev variant,
  **axn-term-hmr** (`pnpm build:hmr` → `tauri build -c
  src-tauri/tauri.term-hmr.conf.json`, product/binary `axn-term-hmr`, or
  `AXN_TERM_HMR=1` for the same code path under `tauri dev`), spawns
  `pnpm exec vite` inside a user-picked checkout/worktree and loads its
  session windows from that server (`WebviewUrl::External`, capabilities
  `remote.urls` `http://localhost:*`/`127.0.0.1:*`, navigation allowlist in
  `window.rs::is_dev_hmr_navigation`) — frontend edits hot-reload in the
  real app while the PTY/Rust side stays whatever the dev binary was built
  with. `devhmr.rs` owns the spawn/state/commands and the `#axn-dev`
  settings window (`apps/desktop/src/app/DevHmr.tsx`): repo picker, vite
  status/log, start/stop/install. In dev mode `state_dir()` is
  `~/.axn-term-hmr` and `save/load/delete_window_state` go through the
  in-memory `AppState.mem_shell_state` — no `state.json` is ever written,
  but a page reload still finds its state. The bundle carries its own
  yellow icon set (`src-tauri/icons-hmr/`, the glyph plated on
  `rgb(227 179 65)`, listed under `bundle.icon` in the hmr conf;
  `build/scripts/make-macos-icon.sh hmr` regenerates it), so the dev
  build is unmistakable next to a real axn-term.
- `apps/web` — browser/online app; binds the same shared UI to `WsBackend`
  (gateway `/ws` protocol: raw PTY frames + JSON `resize`, `fs-read`,
  `fs-write`, `fs-stat`, `fs-list`, `fs-mkdir`, `cwd`, `exec`, `fg-process`,
  `session`) and `browserServices`. `fg-process` reports the terminal's
  foreground pgrp leader comm (session host reads `/proc/<pid>/stat` tpgid →
  `/proc/<tpgid>/comm`, `null` while the shell itself is foreground).
  The session host closes `/ws` with code `4001` (`pty-exited`) when the
  shell exits and the gateway forwards close codes unchanged; `WsBackend`
  treats only `4001` as a session exit (`PTY_EXITED_CLOSE_CODE`). Any other
  close (network drop, gateway restart) keeps the session and prints a
  "connection lost" notice into its terminal — there is no auto-reconnect yet.
- `libs/session-backend` — the `SessionBackend` port (create/write/resize/
  output/close, optional `readFile`/`writeFile`/`statPath`/`getCwd`/
  `getTty`/`getForegroundProcess`/`getDefaultShell` — `getTty` reports the
  session PTY's controlling terminal so plugins can correlate tty-keyed
  out-of-band events like agent hooks; desktop-only) plus `ShellServices`
  (clipboard — `copyText` + optional `copyImage` RGBA pixels → desktop:
  `clipboard_write_image` arboard command, web: PNG `ClipboardItem` —,
  open-external, reveal, open-directory, optional `notify` —
  desktop: `tauri-plugin-notification`, web: Web `Notification`) plus an
  optional key-value `storage`
  (get/set — desktop: `kv_get`/`kv_set` Tauri commands over
  `~/.axn-term/kv.json`, web: `localStorage` under `axn-kv:`) and `FileReader`.
  Desktop file ops go through `tauri-plugin-fs` scoped to `$HOME` (see
  `src-tauri/capabilities/default.json`); tauri.conf.json sets
  `plugins.fs.requireLiteralLeadingDot: false` because the Unix default
  (`true`) makes `*`/`**` never match dot components — `.env`, `~/.config`,
  `~/.axn-term` would all be `forbidden path` errors for `axn-edit`/
  `axn-browse`/`axn-preview` and friends. Paths outside `$HOME` (e.g. repos
  on an external volume) are granted at runtime from the `fileAccessRoots`
  list in `config.yaml` — desktop `App.tsx` passes it to the
  `allow_file_roots` command, which widens the fs scope; grants are
  additive, so a removed root stays allowed until restart.
  Web-capability gaps
  are expressed as absent optional methods — don't stub them with no-ops.
- `@axn-term/session-backend/remote` — `RemoteBackend`, a `SessionBackend` over
  the Ramphastos hub (`/ramphastos` on session-host, proxied raw-WS by the
  gateway): one multiplexed connection; `createSession`/`createSubshell` map to
  `createPty` commands, PTY IO rides server-announced `pty:<id>` duplex streams,
  fs/exec/cwd/fg/tty map to VM commands. Kept behind a subpath export so the
  desktop build doesn't need the ramphastos-client dependency. Selected in
  `apps/web` via `VITE_RAMPHASTOS_URL` (absent → `WsBackend`). Client dep is
  the published `ramphastos-client` npm package (unscoped name), and the .NET
  apps consume the published `Ramphastos.*` NuGet packages — sibling-checkout
  builds are opt-in via `RAMPHASTOS_LOCAL_DEPS=1`: MSBuild swaps the package
  refs for ProjectReferences into `../ramphastos` (root overridable
  via `RamphastosLocalDepsRoot`), the vite/vitest configs alias
  `ramphastos-client` to the sibling (mounted at `/ramphastos` in containers,
  `AXN_LIBS_ROOT` points the docker `libraries` context at it), and the node
  e2e scripts take `RAMPHASTOS_CLIENT_DIST`; rebuild the client package's
  `dist/` when its sources change. End-to-end: `tests/ramphastos-e2e.mjs` (raw protocol)
  and `tests/remote-backend-e2e.mjs` (backend surface; run with
  `node --experimental-strip-types`), both against a locally running
  session-host (`SESSION_HOST_PORT=7682 dotnet run --project apps/session-host`).
- `libs/shell-ui` — protocol-agnostic UI: `SearchPickerModal` (the shared
  searchable list picker — grouped, disabled/badged rows, optional create
  row; behind "Move to workspace…", and behind `pickFromList()` from
  `app/pickerHost.tsx`, which in-process plugins await from a menu row to
  pick a persona/workflow — `PickerHost` is mounted once in `ShellApp`),
  `ShellTerminal`, `ContextMenu`
  (shared fixed-position popup portalled into `document.body` — so the
  panel's CSS `zoom` and ancestor overflow cannot offset or clip it —
  placed by `placeMenu`: opens at the click, flips up/left near the
  bottom/right window edge, clamps otherwise, re-placed via ResizeObserver
  when its content grows, capped to the window height with scrolling;
  outside-mousedown/Escape dismissal, optional `className` for the surface,
  `menuItemClass`/`menuDividerClass` row styles — the shell every right-click
  menu in the app wraps its items in, including the workspace, session and
  tab menus; any right-click no view handles itself opens `AppContextMenu`
  instead of the webview's native menu — Copy/Paste/Select all for the
  terminal under the pointer (`terminalAt`, `registerTerminalElement` in
  `terminalRegistry.ts`; paste goes through `term.paste`; Copy reads
  `terminalSelection` — xterm's live selection, else the user's last one,
  forgotten on a left click or typing — and terminals honour OSC 52 clipboard
  writes via `handleClipboardWrites`, because TUIs with their own mouse
  selection such as Claude Code copy that way and leave xterm with no
  selection; reads (`?`) are refused — and OSC 10/11/12 color reports that
  xterm.js emits on the input channel are routed by the per-PTY ordered
  writer `createTerminalInput` (`terminalRenderer.ts`, shared by
  `ShellTerminal` and `SubShellView`; *every* write to that PTY — keys,
  hidden-command writes, Shift+Enter — goes through it): a fresh
  `getForegroundProcess` probe decides — a shell comm or dead foreground
  = dead letter → dropped (beats every real terminal, which echoes the
  reply at the prompt) — then the write itself goes through the backend's
  `writeWhenRaw`/`write_when_raw` termios gate *inside* the queue: the
  command resolves only after the bytes land (or drop still-cooked at
  `OSC_REPORT_RAW_WAIT_MS` = 2 s), so the reply is written at the
  cooked→raw flip — the first thing devin's raw reader sees inside its
  probe window. Writing straight into a still-cooked tty echoes the
  reply and canonical-buffers it into the asker's input as typed
  `10;rgb:…` at the next mode flip — the devin-restore leak. A hung probe
  (>1 s) falls through to the raw gate rather than delivering blind;
  with no gate or no probe the fallbacks are the raw gate alone or a
  ~75 ms delay. Input after a pending report queues behind it: devin sends
  `ESC]10;? ESC]11;? ESC[c` and treats the DA1 answer as its sentinel,
  so a DA1 reply overtaking a report still in its async probe made
  devin type `10;rgb:…11;rgb:…` into its input on every launch — the
  `devin --osc` flow fixture models exactly that sentinel), Cut/Copy/Paste/
  Select all for text fields, plus "Reload window" (also `⌘⇧R`/`Ctrl+Shift+R`,
  `isReloadShortcut` — terminals let it through; it saves state first and,
  running no React cleanup, keeps the PTYs, which the reloaded window
  reattaches; every live terminal's serialized screen is stashed in
  sessionStorage first (`stashTerminalReplays`, `takeReloadReplay` in
  `terminalRegistry.ts`), so the reloaded window repaints scrollback and
  the alt screen of a running TUI instead of coming back blank —
  sessionStorage dies with the app session, same as the PTYs, so a fresh
  start never replays a dead terminal)), `PathActionMenu` /
  `FileHoverPreview`, themes, `SettingsProvider`, session types, terminal
  links/registry, platform labels. Tooltips are the shared `TooltipHost`
  (`app/Tooltip.tsx`, mounted once in `ShellApp`): put `data-tip="..."` on an
  element — never the native `title` attribute — and the host renders a
  fixed, viewport-clamped bubble on hover/focus. Disabled controls swallow
  pointer events, so put `data-tip` on a wrapper when the control may be
  disabled (`IconButton` does this internally). Components must never import
  Tauri APIs directly; everything platform-specific goes through the
  backend/services seam (desktop-only actions like Reveal simply disappear
  when the service is absent). Errors are contained by `ErrorBoundary`
  (`app/ErrorBoundary.tsx`): one per session sub-view tab (error panel with
  Reload view / Close tab) and a root one in `ShellApp` (Reload window —
  a page reload runs no React cleanup, so PTYs survive and reattach).
  Drags from outside the window are cancelled in capture by
  `app/dropGuard.ts` (installed once in `ShellApp`), so neither the webview
  nor any view's drop target sees them; only `application/x-axn-*` drags and
  drags that started in the window pass. The guard hands the foreign ones to
  `app/fileDrop.ts`: files and links dropped on a terminal are pasted,
  shell-quoted, at the prompt (how Claude Code picks up images); anywhere
  else nothing happens and the cursor shows no-drop. WebKitGTK hides a
  dropped file's path from the page, so on Linux the desktop keeps Tauri's
  native drop handler and `services.onFileDrop` delivers the paths (terminal
  = the last `dragover` target); macOS/Windows disable it and the page's
  `drop` carries the files — saved via `backend.saveDroppedFile` (desktop:
  the `save_dropped_file` command, raw IPC body + `x-file-name` header, into
  `<runtime dir>/axn-term-drops/`). Web and remote viewers have no
  `saveDroppedFile`, so file drops there paste nothing. As a backstop the
  Tauri windows refuse any navigation away from the app
  (`is_app_navigation` in `window.rs`): a page replaced by an opened file
  also loses the close handler, so the window could not be closed.
  Terminal unmount cleanups (`ShellTerminal`, `SubShellView`) wrap every
  teardown step in `safely()` (`terminalRenderer.ts`) and dispose the
  renderer addon before the xterm — an exception escaping an effect
  cleanup would otherwise blank the whole window.

## Repository vs. application name

- Repository / directory name: `axn-term`
- Shipped application name: `axn-term`
- macOS bundle identifier: `dev.axn-term.axn-term`

## State and config location

Application state is stored under the user's home directory:

- Linux/macOS: `~/.axn-term/`
  - `state.json` — persisted windows, workspaces, sessions, and selections.
    Structural changes (session/workspace add, close, rename, move, reorder,
    tab open/close, plugin data) call `saveNow` eagerly; runtime churn
    (status/progress/tasks/output, `pluginState`) stays on the ~2s dirty
    flush. Saves are serialized through `saveChainRef` so bursts never write
    `state.json.tmp` concurrently.
  - `state.json.bak` — backup of the last previously valid `state.json`, rotated on each successful save (writes go through `state.json.tmp` + rename, so a failed save never clobbers the good state)
  - `state.json.failed` — a `state.json` that could not be parsed is quarantined here for diagnosis (`.failed.1`, `.failed.2`, … when the name is taken — an earlier quarantined file is never overwritten); on startup the backup is loaded instead and the window state carries `restoredFromBackup`/`failedStateFile` markers (stripped again on save) so the frontend can show a banner. Any other read error (EMFILE, permissions) is not corruption: load/save/delete return the error and write nothing, so a save never merges into empty or older state
  - `sessions.json` — legacy single-window state (migrated into `state.json` on first read)
  - `kv.json` — generic key-value store behind `services.storage` (e.g. agent
    review explanations); desktop only, web uses `localStorage`. A missing
    file is an empty store; an unparseable one is quarantined as
    `kv.json.failed[.<n>]`; any other read error fails `kv_get`/`kv_set`
    without writing
  - `themes/` — user themes: every `*.yaml`/`*.yml`/`*.json` file directly in
    it, in the same format as the built-in `libs/shell-ui/themes/*.yaml`
    (`id`, `name`, `mode`, `colors`, optional `ui`/`tagColors`). Desktop reads
    them with the `list_user_themes` command (files over 256 KB are skipped);
    `SettingsProvider`'s `loadUserThemes` polls the folder every 3 s and
    `setUserThemes` (`themes.ts`) merges them into the theme list — a user
    file with a built-in's `id` replaces that theme, a file that does not
    parse raises an `Invalid theme` app-attention flag. No rebuild needed;
    web has no themes folder.
  - `plugins.yaml` — per-plugin configuration (e.g. `devin.restore-session`)
    via `platform.pluginSettingsStore` → `PluginSettingsProvider` (desktop:
    `read_plugins`/`write_plugins` Tauri commands). Like config.yaml, the
    desktop store polls `read_plugins` (~1.5 s `watch`) and live-reloads
    external edits — enable toggles and plugin config (e.g. dev-workflow
    workflow definitions) apply without a restart; the provider skips its
    own write echo and never writes back, so user formatting survives;
    invalid YAML keeps the last valid settings and raises an `Invalid
    plugin settings` app-attention flag; while the file on disk is invalid,
    UI changes stay in memory and are not written back (same for
    config.yaml). External `.mjs` plugin *files* are still startup-only. Web has
    no `watch` (localStorage is app-owned).
  - `config.yaml` — app settings (theme, fonts, `sessionIcons`,
    `terminalRenderer`: `auto` (WebGL → canvas → DOM fallback, incl. WebGL
    context loss) / `webgl` / `canvas` / `dom` — applied by
    `terminalRenderer.ts` to ShellTerminal and SubShellView terminals, and
    hot-swapped on the live terminal when the setting changes since
    recreating the PTY would kill the session, …) via
    `platform.configStore` → `SettingsProvider` (desktop: `read_config`/
    `write_config` Tauri commands over `~/.axn-term/config.yaml` — same seam
    as `state.json`/`plugins.yaml`, no fs-plugin permissions needed); on
    first desktop launch a legacy webview-localStorage blob is migrated into
    the file and removed. The desktop `configStore.watch` polls `read_config`
    (~1.5 s) and live-reloads external edits — the provider skips its own
    write echo and suppresses the write-back so user formatting/comments
    survive; an invalid file raises an `Invalid settings` app-attention flag
    (orange warning; clicking it opens the Settings modal) and keeps the
    last valid settings.
    Web has no `configStore` and keeps `localStorage` (`axn-term:settings`).
    Settings → General → "Config file" offers Import/Export through
    `platform.configFileStorage` (desktop: native dialogs, web: download +
    file input).

Remote publishing (Settings → Remote): `remoteAuthorityUrl` (+ optional
`remoteAuthoritySession`/`remoteAuthorityToken`) mirrors this window's PTYs
onto a `/remote` hub via `RemoteAuthority`; `platform.remoteAuthorityStatus`
exposes idle/connecting/connected/failed for the status line. Account
sign-in is OIDC **device flow** (`apps/desktop/src/app/remoteAuth.ts`):
`remoteAuthIssuer` + `remoteAuthClientId` settings, browser-side
authorization, the refresh token lives in the OS keychain via the
`secure_get`/`secure_set` Tauri commands (keyring crate — macOS Keychain,
Windows CM, Linux Secret Service), access tokens are refreshed in memory by
`getAccessToken()`. `platform.remoteAuth` exposes
state/subscribe/signIn/signOut/getAccessToken; the signed-in JWT wins over
the static `remoteAuthorityToken` dev fallback and a sign-in flip restarts
the authority so its hello carries the token. The gateway binds the
mirrored session to the JWT `sub` — viewers must authenticate as the same
account; `RemoteAuthority__AllowAnonymous=true` bypasses this for dev
(off by default). Hello tokens must come from an allowed OIDC client
(`azp`): `RemoteAuthority__ClientIds` (comma list), unset =
`Authentication:ClientId` plus the desktop's `axn-term-desktop`.

Session plugins can declare per-session state, which is stored inside `state.json`
under `sessions[].pluginState.<plugin-id>`. Plugin lifecycle hooks (`onOutput`,
`onSessionOpen`, `onClose`, `onCommand`) receive a `pluginState`/`updatePluginState`
API and a `writeToSession` helper for sending input to the session PTY.
`onCommand` can observe/intercept a submitted input line and replace or
swallow it (the devin plugin uses it to arm its `/exit` capture and to
invalidate the remembered session when the user launches `devin -r <name>`
manually). Handlers may return a Promise; the replacement line is written
once it resolves. The outcome of a hidden-command line follows one
procedure (`applySessionCommandResult` in `app/hiddenCommands.ts`): a
handler returning `undefined` submits the line to the shell unchanged;
`false` swallows it silently; a plain string replaces the line and runs in
the shell (e.g. `devin -r <name>`); and the `echo "<msg>"` shape is the
feedback convention — a message for the user, not a command. With the
terminal's `writeDisplay` channel the typed line stays on screen and
`<msg>` is drawn below it like real command output (the `\x15` kill goes
to the PTY after the display write so the shell's line erase lands on the
empty line underneath); without it the `echo` is typed into the shell as
a fallback. The remote `axn-term session command` path (`controlReply` in
`app/controlCommands.ts`) parses the same `echo` shape back into the CLI's
reply text. Covered by the `command feedback (display channel)` cases in
`hiddenCommands.test.ts`.

Plugins can colour the session panel: `sessionColors(ctx)` (a session card) and
`workspaceColors({ workspace, pluginSettings })` (a workspace header — no session
needed) return hex colours. `SessionPanel` combines every enabled plugin's colours
(plugin order) into equal left-to-right bands via `resolveTint`
(`session-plugins/tint.ts`; a colour is a hex or a theme tag slot — `red`,
`orange`, `yellow`, `green`, `cyan`, `blue`, `violet`, `magenta` — resolved
through `themeTagPalette(activeTheme)` in `themes.ts`: a theme's optional
`tagColors:` block, else its terminal colours, orange/violet mixed when absent;
`applyTheme` also sets them as `--tag-<slot>` for CSS) — the host owns the shades (`TINT_INTENSITY`): one
colour mixed with `--chrome` (solid, so a card hides its workspace's tint):
workspace block 20%, session card 32%, selected card 50%, selected card's title
row 100% with dark/light text picked by contrast (`tintTextVars`); tints are set
through a `--tint` custom property (`tintStyle`); non-hex values are dropped and a
throwing hook contributes nothing. `Workspace.pluginState[<settingsKey>]` is the
workspace counterpart of a session's `pluginState` (written via the panel's
`updateWorkspace`). `sessionMenuItems(ctx, scope)` also receives a `MenuScope`
(`targets` = the multi-selection when the clicked session is in one, plus all
sessions/workspaces), and `workspaceActions(ctx)` contributes workspace-menu rows
without needing a session (empty workspaces included). The built-in `tagging`
plugin (`session-plugins/tagging.tsx`) uses all of it: a tag is a typed string
stored only on its session (`pluginState.tagging.tags`) or workspace, its colour
a theme tag slot hashed from the string (`tagColor`) unless set in the plugin's
`colors` map in plugins.yaml (a slot name, which follows the theme, or a raw hex) (edited in Settings → Plugins → Tags,
`TagColorSettings`, which lists every tag in use — `PluginSettingsViewContext`
carries the window's `sessions`/`workspaces`, empty in the macOS Preferences
window — or by clicking a tag's dot in `TagModal`, saved at once via `TagHost`;
hex can be typed or pasted, `parseHexColor`); a workspace's tint paints the whole workspace block; picked/created through `TagModal`
(`openTagModal` in `app/tagHost.tsx`, mounted as `TagHost` in `ShellApp`); the
`tagging.tags` card field shows only where `sessionCard` places it (the default
layout shows no tag name; the tint stays). Design: `docs/superpowers/specs/2026-11-17-tagging-plugin-design.md`.

Plugins can declare hidden commands via `commands?: (string | PluginCommand)[]`
— they join the built-in `axn-*` names for Tab completion. A plain string is
completion-only (handled via `onCommand`); a `PluginCommand` object
`{ name, run, takesArg?, argCompletion?, completeArg? }` owns the command: a
submitted line whose first word matches `name` is dispatched to
`run(ctx, arg, line)` before
any `onCommand` sees it. `run` may return a replacement command, `false` to
swallow, or a Promise thereof. `takesArg` appends a space on completion;
`argCompletion: 'workspace' | 'dir' | 'file'` gives built-in argument
completion, `completeArg(ctx, prefix)` a dynamic list of argument candidates
(workflow/state names for `axn-workflow-*`). `axn-devin-resume` (devin
plugin → `devin -r <remembered>`), `axn-worktree [name]` (worktrees plugin →
`git worktree add` + session, see below),
`axn-claude-resume` (claude plugin → `claude -c`),
`axn-codex-resume` (codex plugin → `codex resume --last`),

`axn-agy-resume` (antigravity plugin → `agy --conversation <id>` once the
exit hint was captured, else `agy -c`), `axn-awesome` (awesome

`axn-opencode-resume` (opencode plugin → `opencode -s <id>`/`opencode -c`), `axn-awesome` (awesome
list), `axn-git [ref]` (git-inspect plugin → opens the repo's `git` tab at the
session cwd's toplevel — with a ref argument the tab diffs merge-base vs
HEAD as a "Changes vs <ref>" section; echoes an error outside a repo) and
`axn-workflow status|start|set|move|run|stop` (dev-workflow plugin), `axn-agent
<persona>` (agents plugin → the persona's launch line) and
`axn-scratch`/`axn-draft` (scratchpad plugin → `ls|dir|new|open|browse|hint|tell`
— see below) are implemented this
way.

Plugins declare `logo` — a Lucide icon name or an inline `<svg>` tag
(the `sessionIcons` value format) — as the has-an-icon capability: only
plugins that declare it get the Logo field on their Settings → Plugins page
and resolve bag overrides in `PluginIcon`/`resolvePluginIcon`
(`SessionPanel.tsx`); undeclared plugins render a generic Puzzle and the bag
is not consulted. Users override a declared logo per plugin through the
flat icon bag (`customIcons`, or legacy `pluginIcons`, keyed by plugin id) —
that is how brand marks axn-term does not ship (Docker, GitHub, GitLab) can
be restored locally. A `logo` on a plugin that also declares
`processPattern` doubles as the session-icon fallback for matching
foreground processes (`resolveProcessIcon`, `app/iconModel.ts`), so for the
agent plugins whose id is the process name (`devin`, `claude`, `codex`,
`opencode`, `vibe`; `antigravity` covers `agy` via its pattern) the Logo
field and the Session-icons row edit the same icon.

Custom icons live in one flat bag: `customIcons` in config.yaml keyed by
process name or plugin id (the `sessionIcons`/`pluginIcons` maps still merge
in underneath — `collectIconBag`, `app/iconModel.ts`). Session rows resolve
`bag[process]` first, then the logo of the registered plugin whose
`processPattern` matches (`bag[plugin.id]` override, else the declared
`logo`), then the terminal glyph — `registerSessionViewPlugin` feeds that
lookup via `registerIconPlugin`, so external plugins join the same
resolution. The bag is a shared
setting: ShellApp publishes it as `app:icons` through `platform
.publishSharedState` (desktop authority → `RemoteAuthority.setSharedState`
replica patch; a remote viewer → `/vm/setPluginState` upstream), and the
authority applies client writes back into its own config via
`onSharedState`. Viewers resolve icons from the synced bag overlaid on their
local settings (`IconBagContext`/`useIconBag`), so every screen shows the
same icons while theme/plugins/zoom stay per-device.

Every `PluginApi` ctx comes from one builder, `createPluginApi(session,
plugin, deps)` (`session-plugins/plugin.ts`): ShellApp's lifecycle dispatch
passes live lookups (`getLiveSession`, `getSessionCount`) and `onAttention`
(OS notification), the panel/card call sites pass snapshots — the
behaviour is otherwise identical, so the two can no longer drift.

Plugin ctx (`PluginApi`) also exposes `appState`/`updateAppState` — the
app-level counterpart of `pluginState`, backed by window state
`pluginData.<settingsKey>` and shared across sessions. That's how
`axn-awesome` reads/writes the bookmark list outside the plugin view.

Built-in hidden session/workspace commands (intercepted before plugins):

- `axn-session <subcommand>` — session management. `create` opens a new
  session (`axn-session create [path] [-w|--workspace <name>]
  [-n|--name <name>] [--background] [--summary <text>]`); the bare legacy
  spelling `axn-session [flags] [path]` is an implicit `create`. No
  argument or `.` starts it in the current session's cwd; an absolute or
  relative path starts it there (validated via `stat_path`, echoes an
  error otherwise). `-w`/`--workspace` targets a workspace by name —
  created when absent, like `axn-session-mv`; `-n`/`--name` names the
  session; `--background` opens it without selecting it or dismissing a
  covering plugin view (agents spawning sessions don't steal focus);
  `--summary` sets the new session's `summary` field.
  `axn-session set` mutates the *current* session:
  `axn-session set [--summary <text>] [--name|--title <name>]` — at least
  one flag required (usage error otherwise); an empty quoted value clears
  the field (same convention as bare `axn-rename`/`axn-session-summary`).
  Feedback echoes as command output (`renamed to '…'`/`name cleared`,
  `summary updated`/`summary cleared`). `axn-session select <name|id>`
  focuses another session ('go to session' — same as the broadcast tile
  button); `axn-session list` echoes every session in panel order, `*` on
  the one it ran in and the workspace in parens — the session-addressing
  counterpart of `axn-workspaces`, so agents can discover peers to message.
- `axn-session-mv <workspace>` — move the current session to another
  workspace, creating the workspace if it does not exist. The session
  context menu's "Move to workspace…" opens `MoveToWorkspaceModal`: every
  workspace of every open window, grouped by window ("This window", "Main
  window", "Window N" — numbered globally by window id, `windowPeers.ts`),
  searchable, with a "New workspace '<query>'" row. Windows exchange their
  workspace lists over `platform.peers` (desktop: Tauri app-wide events,
  `useWorkspaceDirectory`; absent on web). Picking another window's
  workspace hands the session over (`requestAdopt` → `axn:adopt-session`):
  the source keeps its PTYs alive (`keepPtyAlive` for the main shell and
  every sub-shell tab), the target `adoptSession`s the full record (tabs,
  pluginState, scrollback) and acks; only then the source drops the session
  — output is broadcast to every window, so the target's terminals simply
  reattach. No ack within 3 s → the move is undone and an error banner
  shows.
- `axn-session-window` — move the current session into a new window of its
  own (also "Move to new window" in the session context menu; hidden for a
  window's only session). Session rows also tear off Chrome-tab style
  (`app/sessionTearOff.ts`): a row dragged out of the window and dropped
  where no window takes it opens a new window for it, and a row dropped on
  another window's panel (or anywhere in that window) moves there — before
  the row it lands on, else appended to the selected workspace. All of it
  rides the adopt hand-over above (PTYs, tabs, plugin state, scrollback).
  Every cross-window hand-over (also "Move to workspace…") carries the
  terminals' history: the PTYs only stream new output, so the source
  serializes each xterm (`serializeTerminal` in `terminalRegistry.ts`,
  `@xterm/addon-serialize` — colors, modes and a TUI's alternate screen
  included) into the adopt request's `replay`, and the target's
  `ShellTerminal`/`SubShellView` write it (`takePendingReplay`) before any
  live output. The receiving window takes focus (`platform.window.focus`,
  capability `core:window:allow-set-focus`). A secondary window emptied that
  way while other windows remain deletes its saved state instead of being
  restored empty at the next launch — unless it holds per-window data
  (`pluginData`/`pluginTabs`); `main` and the last window always keep theirs.
  Mechanics: the new window is created through `create_window` with
  `options` (`boot` — the `encodeBootIntent` URL fragment `#axn-boot=…`,
  validated URL-safe by `boot_fragment` in `lib.rs`; `x`/`y`/`width`/
  `height` — the source window's size and, when known, the drop point;
  Wayland compositors place windows themselves). `platform.window.bootIntent`
  hands it to the new window, which boots *empty* (`useShellSessions`
  `startEmpty`: one workspace named after the source's, no default shell;
  only without saved state, so a reload is a normal restore), suspends the
  empty-window auto-close and repeats `axn:window-ready` until it adopted
  the session (20 s, then it closes again). The source waits for that
  announcement (`openTearOffWindow`) before sending the adopt request.
  Cross-window drops: the dragging window announces `axn:session-drag`/
  `axn:session-drag-end`; other windows accept the HTML5 drop while one is
  active (a window-level dragover/drop listener plus the panel's own
  handlers) and claim it with `axn:session-drop`, which the source turns
  into an adopt request with `beforeSessionId`. Whether the drag left the
  window comes from `createDragExitTracker` (a lone `dragleave` — no
  coordinates, which Wayland does not report outside the window); a
  `dropEffect: 'none'` dragend outside waits `TEAR_OFF_CLAIM_GRACE_MS` for a
  drop claim before opening a new window. Esc-cancelling a drag outside the
  window is indistinguishable from dropping there, so it tears off too.
- `axn-session-up` / `axn-session-down` — reorder the current session within
  its workspace.
- `axn-workspace-up` / `axn-workspace-down` — reorder the current workspace.
- `axn-sh [command|dir]` — open a sub-shell tab. No argument (or an argument
  that resolves to a directory, like `.` or `src`) opens an interactive shell
  in that directory — defaulting to the session's live cwd; any other argument
  runs `sh -c` as a one-shot command. Also available as "New sub-shell" on the
  session right-click menu.
- `axn-preview <path>` — open a read-only preview tab for the file. The first
  enabled preview plugin claiming the path renders it (image, svg, markdown,
  asciidoc, mermaid, text fallback); the tab is named after the file.
- `axn-rename [name]` — rename the current context. In a session shell it
  renames the session (no argument clears the override → back to the
  process-reported name, same as the reset icon in the context menu); in a
  sub-shell it renames only that tab (no argument restores the default label).
- `axn-session-summary [text]` — set the session's `summary` field — a
  short description rendered clamped to 3 lines under the session title in
  the panel (behind the `sessionSummaries` setting) and under the title on
  dev-workflow kanban cards; full text stays in the tooltip. Matching
  outer quotes are stripped, text is capped at 400 chars
  (`SESSION_SUMMARY_MAX` in `app/hiddenCommands.ts`), and no argument
  clears it. `axn-session set --summary <text>` is the equivalent spelling
  on the `axn-session` umbrella command (also reachable as
  `axn-term session set --summary …` over the control socket). Agents use
  it to keep the session's displayed description current. The session
  context menu's "Edit summary…" (`app/EditSessionSummaryModal.tsx`) edits
  the same field: a textarea sized to the session row's width so wraps
  match the panel, with a warning once the text runs past the three-line
  clamp (measured on a hidden mirror of the panel's summary element).
- `axn-install [args]` — runs `axn-term install <args>` in the shell (the
  running binary's path is resolved via `current_exe_path`, so it also works
  in dev builds where `axn-term` is not on PATH).
- `axn-focus [tab]` — bring a session view to the front: bare or `shell`
  selects the main terminal; otherwise the first sub-view tab matching a
  1-based index, kind (`git`, `editor`, `shell`, `preview`, `browser`),
  id prefix, or label/path basename. Selecting the tab also selects the
  session and dismisses a covering plugin view — workflow `command:`
  actions use it as an on-enter "switch the view" (e.g. `axn-focus` on a
  human-gate state).
- `axn-broadcast [-t|--to <session>] <line>` — write the line (with Enter)
  to every session in the broadcast set, or to a single named session with
  `-t`/`--to` (same id/exact-name/prefix resolution as `axn-broadcast-add`;
  the line goes verbatim — transport, not a message). The set is a
  per-window runtime set of session ids
  (`app/broadcastSet.ts`): `axn-broadcast-add [name]`/`axn-broadcast-rm
  [name]` mark/unmark (current session with no arg, else name or id —
  prefix match), `axn-broadcast-clear` empties it, `axn-broadcasts`
  lists it (`*` on the current session). The session context menu's
  "Add/Remove from broadcast" toggles the same set and marked rows show
  a radio badge (`useBroadcastMarked`). Fan-out is a plain
  `backend.write(ptyId, line + "\r")` per target — the same bytes path
  as typing, so agents can drive it too via
  `"$AXN_TERM_CLI" session command "axn-broadcast <line>"`. The deck's
  composer gates dangerous buffers through a confirm dialog
  (`app/broadcastDanger.ts`): built-in rules (rm -rf, dd/mkfs, reboot,
  git push --force/--delete, git reset --hard/clean -f, DROP/TRUNCATE/
  DELETE FROM, kubectl delete/drain, systemctl stop/disable, chmod -R,
  killall/pkill, fork bombs) plus user regexes from
  `broadcastDangerPatterns` in config.yaml — each is matched
  case-insensitively against every line of a multi-line buffer, invalid
  patterns are skipped with a console warning. The gate only fronts the
  interactive composer; the `axn-broadcast` command path writes
  directly.
- `axn-tell <session> <message>` — agent↔agent messaging over the same PTY
  input path: delivers `[axn-tell from "<sender>"] <message>` typed into
  the target (the sender name comes from the session, not the text, so it
  can't be spoofed). When the target's foreground is a shell (or the
  backend reports none) the envelope is prefixed `# ` — it lands in
  scrollback/history instead of failing as `command not found`; any other
  foreground gets the raw envelope since typed input is the only universal
  way into a running agent TUI. Discover peers with `axn-session list`;
  agents use `"$AXN_TERM_CLI" session command "axn-tell <name> <msg>"`.

The session-level dispatch behind it — built-ins, plugin-owned commands,
`onCommand` hooks, Tab completion, and the out-of-band entry points
(`PluginApi.runCommand`, remote-control lines, `axn-term session …`) — is
`useSessionCommands` (`app/useSessionCommands.ts`), fed by ShellApp. The
built-ins are the `BUILTIN_COMMANDS` registry in `app/builtinCommands.ts`
(one entry = name + `run` + optional `takesArg`/`completeArg` — the same
table drives dispatch and Tab-completion); the shared parsing, session/
workspace resolution and path-completion helpers sit in
`app/shellCommandSupport.ts`.

Input interception for all of this lives in `createHiddenCommandInput`
(`app/hiddenCommands.ts`) — a per-view line-buffer tracker shared by
`ShellTerminal` and `SubShellView`. It gates on a `mode()` callback
(`'full'` at a bare shell prompt, `'agent'` while a plugin declaring
`agentInput` matches the foreground process — only `/exit` is observed, for
the plugin's `onCommand` — `'off'` while any other foreground process owns
input), dispatches `axn-edit`/`axn-browse`/`axn-preview` and
Tab-completion locally, and forwards everything else to the session-level
`onSessionCommand`. Views may register an `onLocalCommand` hook that runs
first — `SubShellView` uses it so `axn-rename` renames the tab rather than
the session. `ShellApp` handlers take an optional `ptyId` so paths and cwd
resolve against the PTY the command was typed into (a sub-shell's live cwd
can differ from the session's stored cwd).

Sub-shell tabs (`editors[].kind === 'shell'` in `state.json`) are sibling PTYs
spawned via `create_subshell` (`src-tauri/src/lib.rs`), keyed by their own tab
id in the backend `sessions` map with `parent_id` linking them to the owning
session (closing a session kills its sub-shells). They emit `shell-output`
like normal sessions but exit via `subshell-exited` (carries the exit code);
the `SubShellView` (`app/SubShellView.tsx`) holds the output on exit — Enter
re-runs, Esc closes the tab. Sub-shell tabs persist across restarts and
re-spawn lazily on first activation (command tabs re-run their command).
Tabs hosting an agent conversation (git-inspect "talk" tabs) carry `agent`
and `resumeCommand`: once the tab has run, every later spawn — restart or
Enter re-run — runs `resumeCommand` instead of the seed `command` (`devin -r
<name>` once the exit-time resume hint was captured from the tab's own
output — plugin `onOutput` only sees the main PTY — else `devin -c` /
`claude -c`), so the conversation is continued rather than re-seeded.
`/exit` typed inside a sub-shell never reaches session-level dispatch — the
devin plugin's exit capture is bound to the session's main PTY. Instead the
tab captures its agent itself (`app/subShellAgents.ts`): the exit hint of
claude (`claude --resume <id>`) or devin (`devin -r <name>`) is parsed from
the tab's own output — a talk tab stores it as `resumeCommand`. Plain tabs
where the user starts an agent follow the sessions' running-at-close rule:
the 1 s foreground poll records `agentActive` (a fresh start forgets the
previous `agentResume`; an exit the app did not drive clears it), the exit
hint lands in `agentResume`, and `subShellSpawnCommand` resumes exactly that
conversation (fallback `claude -c`/`devin -c`) only when the agent was still
running when the app went away. On app close `runSubShellClosers` (awaited
in `ShellApp`'s collect-and-close path) sends each running agent the same
Ctrl-C pairs as the plugins' `onClose`, so the hint lands before the save.
The session context menu and a sub-shell tab's context menu offer "Copy path" —
the live working directory of that shell (`backend.getCwd` on the session's
`ptyIdOf` / the tab's PTY; it is the shell's cwd, so it works while a program
runs in the foreground; the recorded cwd is the fallback, and the row is
absent where the backend cannot read a cwd).
They carry an optional `label` override (right-click a tab → Rename…, or
`axn-rename` inside it) — an empty rename clears it back to the default
command/dir label. Sub-shells intercept the same `axn-*` commands as the
main terminal (gated on a 1 s `getForegroundProcess` poll of the sub-shell
PTY), so `axn-edit`/`axn-browse`/`axn-session`/plugin commands work inside
them too.

A sub-shell can be promoted to the session's main shell (right-click a
sub-shell tab → "Make main shell", planned by `app/subshellPromote.ts`): the
session keeps its id but gains `mainPtyId` = the sub-shell's PTY id — every
PTY-bound operation (`ptyIdOf(session)`: ShellTerminal binds/writes/polls,
plugin `writeToSession`/`getCwd`/`waitForSessionOutput`, `axn-*` cwd
resolution) targets it while names/pluginState/output stay on `id`. The
demoted main PTY becomes a `kind: 'shell'` tab in its place. The backend
decides `session-exited` vs `subshell-exited` by the live `parent_id` link,
updated via `set_subshell_parent` (promotion re-parents the demoted shell to
the promoted one). `create_session`/`create_subshell` reattach to a live PTY
under the requested id instead of respawning (create_session reports
`spawned=false`, so plugin `onSessionOpen` hooks do not fire), and
`terminalRegistry.keepPtyAlive` flags PTYs whose views unmount during the
swap. "Turn into workspace" on a session with sub-shells (session context
menu) detaches every sub-shell PTY and adopts it as a standalone session —
main shell first — in a new workspace named after the session. The context
menu's "Close session" runs every enabled plugin's `onClose` (devin's
graceful interrupt + resume-hint capture) before tearing the PTY down —
an inline confirm appears first when `session.process` reports a live
foreground process.

Session views mount plugin-style: only the selected session renders a
`ShellTerminal` — unselected sessions have no xterm view at all. PTY
lifetime is session-owned, not view-owned: `acquirePty`
(`ptyLifetime.ts`) holds a permanent session-level owner for each session's
main PTY (sub-shell tab PTYs are covered by `syncRetainedPtys`), so a view
unmount can never reach the last owner and kill the process — closes are
explicit (`closeSessionGracefully`, `closeTab`, `killWindowSessions`). The
session layer also owns the pieces views used to carry: a per-session
`backend.onOutput` subscription in `ShellApp` drives output retention and
plugin `onOutput` hooks regardless of mounts; each session's main PTY is
spawned eagerly (background agents and devin restores keep running with no
view — the view claims the spawn instead when it mounts first); and a
headless xterm buffer per session (`trackSessionBuffer` in
`terminalRegistry.ts`) keeps `getScreenLines`/`serializeTerminal` seeing a
live screen for unmounted sessions, which is also the freshest repaint
source on remount.

The session tab strip keeps `shell` pinned leftmost; sub-view tabs (editor,
browser, shell, preview, git) are drag-and-drop reorderable. `Ctrl/⌘+Alt+←/→`
cycles tabs of the selected session, `↓/↑` sessions, `Shift+↓/↑` workspaces.

Git inspect tabs (`editors[].kind === 'git'` in `state.json`, view
`app/GitInspectView.tsx`) are a GitKraken-style workbench for the repo root
recorded in `path`: staged/unstaged/untracked/conflicted file lists with
per-file and bulk stage/unstage, a commit box with an amend toggle, a
read-only Monaco diff editor (HEAD/index blobs vs. disk for the working
copy, parent-vs-commit blobs for history), and a resizable lane-graph
history strip (every ref, or only HEAD and the compare base when the tab has
one — `historyRefs`: a review worktree shares its clone's refs, and `--all`
showed unrelated branches as if they were the MR's) (`app/GitGraph.tsx` + `assignLanes` in `app/gitClient.ts`)
where selecting a commit lists its files and shows their diffs. Hovering a
commit row opens an interactive card (a portal, not `data-tip` — it must be
clickable) with the full hash (click to copy), author, absolute commit time
and subject. Right-click
is everywhere: file rows offer stage/unstage, open file (an editor tab; a
deleted file instead offers restoring the recorded state) + copy path,
commit rows offer copy-hash, and history file rows offer "Restore this
state" (`git restore --source=<sha>`, the parent for deletions), and the
diff editor replaces Monaco's built-in menu
(`contextmenu: false` — "Go to Definition" makes no sense read-only) with a
DOM `ContextMenu` offering copy-selection/copy-old/copy-new plus — with a
`review-agent` configured — "Discuss this change" on the selected diff text
(opens an agent talk sub-shell seeded with the selection). All git I/O
goes through the backend `git_exec` command (`src-tauri/src/lib.rs`) —
`git` with an explicit argv,
no shell — wrapped by `git(cwd, args)` in `app/gitClient.ts` together with
the pure `git status --porcelain -z`, `git log`, and `--name-status -z`
parsers. The view refreshes on visibility change, on a 600 ms-quiet
`shell-output` debounce (repo state changes through the shell), and via a
manual refresh button. Git tabs are session-bound: like sub-shells they are
excluded from "Move to" plugin-view hosting.

The git-inspect plugin's `review-agent` setting (select: off / Devin /
Claude / Gemini / Codex, `gitInspect.tsx`) enables agent review rows in those menus —
"Explain this change" and "Talk about this change" (`app/gitReview.ts`,
pure helpers + tests). Explain runs `<agent> -p "<prompt>"` via backend
`exec` in the repo root — the prompt travels inside the command as a
quoted heredoc (no temp file, no fs capability, nothing to clean up) —
then stores the answer in `services.storage` keyed by `commit:<sha>` /
`commit:<sha>:<path>` / `wt:<path>` (with a `diffHash` staleness hint;
bounded to 200 entries). Rows show a spinning hourglass while pending and
a sparkles badge once stored; the badge opens a popover with the text,
"Talk about this" (opens a sub-shell seeded with the prompt — `devin --`/
`claude` interactive, then `exec $SHELL -l` keeps the tab usable; the tab
is marked `agent` so re-spawns resume the conversation, see above), and
"Forget".

`ctx.openSubShell(command?, cwd?, label?, agent?)` on `PluginApi` (also in
`RepoMenuContext`) opens a session sub-shell tab — one-shot `sh -c` with a
command, interactive shell without — so plugins can spawn terminal work
the same way `axn-sh` does. `label` sets the tab's display name, `agent`
(`'devin' | 'claude' | 'agy' | 'codex'` — `AgentCli` in types.ts) marks the
tab as hosting an agent conversation so re-spawns resume it. The return value is the tab/PTY id — the same id the
plugin hook `onSubShellExit(ctx, tabId, exitCode)` reports when the
sub-shell exits (desktop carries the real exit code, web reports `null`;
dev-workflow correlates it to record `run-in: sub-shell` check results).

`ctx.openSession(cwd?, name?, workspaceId?)` on `PluginApi` opens a new
session rooted at `cwd` (default: the shell default; a given `name` becomes
the session's custom name, so the terminal title does not replace it) — in the ctx
session's workspace unless `workspaceId` targets another — selects it,
and dismisses a covering plugin view so the user lands on the new
session. `ctx.getWorkspace()` returns the session's `Workspace` (carrying
`defaultFolder`); `ctx.getWorkspaces()` lists all workspaces in panel
order. Both are also exposed to sandboxed plugins
(`axn.session(id).openSession()`/`getWorkspace()`/`getWorkspaces()`).

`ctx.runCommand(line)` dispatches a line through the session's
hidden/plugin command pipeline — the same path a typed `axn-*` line takes
(`axn-git`, plugin `commands`, `onCommand` hooks), resolving `false` when
swallowed, a replacement command string, or `undefined` for pass-through.
It's how plugin code invokes hidden commands without faking PTY input —
`writeToSession` writes go straight to the shell and never reach the
interception layer. Host (ShellApp) registers the dispatch in a
module-level holder (`registerSessionCommandDispatch` in `plugin.ts`), so
apis built by SessionPanel/SessionView get it too; sandboxed plugins call
`axn.session(id).runCommand(line)`.

`ctx.activateTab(tabId)` brings one of the session's views to the front —
`'shell'` for the main terminal, else a sub-view tab by id, kind, index or
label — selecting the session and dismissing a covering plugin view. It's
sugar for dispatching `axn-focus <tabId>` through `runCommand` (resolves
`true` when a tab was activated); sandboxed plugins get
`axn.session(id).activateTab(tabId)`.

Workspaces carry an optional `defaultFolder` (persisted in `state.json`):
set/clear it from the workspace context menu — "Set default folder…" opens
`SetDefaultFolderModal`, a free path input seeded with the current value
(empty = home directory, never validated on save), and "Set default folder to
session dir" snapshots the representative session's live cwd (hidden when the
workspace is empty). The workspace "+" button then spawns sessions rooted
there instead of the default cwd, checking the path first via `statPath` when
a live session can answer it — a path that doesn't resolve to a directory
raises `InvalidDefaultFolderModal` (fix the path, or open in the home folder)
instead of a dead terminal. Workspace-scoped plugin actions (e.g. worktrees)
resolve their repository from it.

The session-panel header also has a filter input (`PanelSearch`) right of the
workspace buttons: a case-insensitive substring match on workspace names and on
what a session's card shows — its name (custom or terminal-reported
`autoName`) plus every *placed* session field whose plugin declares a
search string (see **Session card**; `app/sessionSearch.ts`) — a workspace
stays listed when its own name matches or it hosts a matching session, matched substrings are accent-highlighted
(`Highlight`), collapsed workspaces force-expand while the filter is active,
and Esc/✕ clears it.

Tab on an `axn-*` line completes the command name, a workspace name for
`axn-session-mv`, or a filesystem path for `axn-edit`/`axn-browse`/
`axn-session`/`axn-preview` (dirs only except for `axn-edit`/`axn-preview`).

The `axn-browse` view supports an editable path bar (click the path, type a
new one with directory autocomplete), back/forward/up navigation buttons
(the history is in-memory per tab, capped at 20 entries — going back or
up highlights the folder just left), a "show hidden files" checkbox under
the path bar, an expandable tree (a folder's chevron or →/← expands/
collapses it in place — expanded listings load on demand and re-list on
refresh, `app/browserTree.ts` flattens them into rows; double-click/Enter
still navigates into a folder), arrow-key/Backspace navigation, and right-click context
menus built on the shared `ContextMenu` (`libs/shell-ui`) — per entry it
hosts `PathActionMenu` (Open, Edit, Preview, Reveal in the OS file
manager, Copy Path, and a content preview — plus Copy, which puts the
image itself on the clipboard via `services.copyImage`, shown once the
preview decoded an image); on empty space it offers New
file/New folder (inline name input in the listing, created via
`writeTextFile`/`mkdir`), Copy path, Reveal, and Refresh. Clicking an
image thumbnail in the hover card opens it in a preview tab.

## File preview plugins

Preview tabs (`editors[].kind === 'preview'` in `state.json`, view
`app/PreviewView.tsx`) are rendered by `FilePreviewPlugin`s
(`libs/shell-ui/src/app/preview-plugins/`): `id`, `title`, `settingsKey`,
`defaultEnabled`, `matches(path)`, `render(ctx)`. `ctx` provides `path`,
`resolvedPath`, `cwd`, `readFile()`/`readBytes()`/`readSibling(rel)` (resolves
against the previewed file's directory), `pluginSettings`, and `isVisible`.
`render` returns a ReactNode; a plain string is treated as HTML, sanitized
with DOMPurify, and injected (that's the form external plugins use).
`resolveFilePreviewPlugin` picks the first enabled matching plugin — the
`text` fallback is registered last so it claims anything unhandled.

Built-ins: `svg`, `image` (raster — also overlays a Copy button that puts
the image itself on the clipboard via `services.copyImage`), `markdown`,
`asciidoc`, `mermaid`
(.mmd/.mermaid), `text` (fallback). marked/asciidoctor/mermaid/dompurify are
lazy-loaded via dynamic `import()`. Markup post-processing
(`preview-plugins/html.tsx`) renders `code.language-mermaid` blocks as
mermaid diagrams — covering mermaid fences inside markdown and
`[source,mermaid]`/`[mermaid]` listings inside asciidoc — and rewrites
relative `img[src]` to blob URLs. Mermaid follows the active theme's
light/dark mode; `securityLevel: 'strict'`.

External `.mjs` plugins can attach a `preview` capability to their default
export: `preview: { extensions: ['foo'] | match(path), title?, render(ctx) }`.
It registers as a `FilePreviewPlugin` sharing the plugin's plugins.yaml
section, so `<plugin>.enabled: true` enables the preview too (still opt-in).

## CLI subcommands and agent skills

`main.rs` routes argv before Tauri starts (`src-tauri/src/cli.rs`): bare
`axn-term` launches the app — one instance per `$AXN_TERM_STATE_DIR`: a
launch that finds a live control socket asks the running app to focus a
window and exits (a stale socket is replaced), so `pnpm tauri dev` from an
axn-term terminal needs its own `AXN_TERM_STATE_DIR`; an unknown subcommand
prints usage and exits 2. `axn-term command [--window <label>] <axn-…>` runs an
app-level line from any local process — the socket's secret-free `app` message
(like `activate`), delivered as `control-app-command` to the named window or the
focused one (`window::app_command_window`); only plugin commands declaring
`appRun` (e.g. `axn-views open|select|close|current`) run, plus the built-in
`axn-session create` (in the window's selected session's context); everything else
is refused (`dispatchAppCommand` in `app/controlCommands.ts`, `appSessionCreate` in
`app/useSessionCommands.ts`). `axn-session create --command <line>` /
`--command-b64 <base64>` types the line into the new session once its shell has
printed; on the app-level path that needs the `allowExternalCommands` setting
(default off) — agterm's `session new --command` model behind a switch. `axn-term session summary|rename|focus|command …`
runs an `axn-*` command for the terminal it is invoked from — over the
control socket (`src-tauri/src/control.rs`, `$AXN_TERM_STATE_DIR/control.sock`,
0600): every PTY gets `AXN_TERM_PTY_ID` + a random `AXN_TERM_PTY_SECRET` +
`AXN_TERM_CLI` (the app binary), the socket verifies the secret minted for that
PTY and emits `control-command`; the window owning the PTY
(`sessionForPty` in `app/controlCommands.ts`) runs the line through
`handleSessionCommand` and answers via `control_reply` (`controlReply`: swallowed
→ ok, `echo "<msg>"` → message, any other replacement → refused, 5 s timeout);
on the web the session host plays the app's part: `ControlListener`
(`apps/session-host`, its own minimal Kestrel app on
`$AXN_STATE_DIR/control.sock` — 0600, chowned to the PTY user — never the
gateway-facing listener) checks `X-Axn-Pty`/`X-Axn-Pty-Secret` (PTYs get
`AXN_TERM_PTY_SECRET`, `AXN_TERM_CONTROL_SOCKET` and `AXN_TERM_CLI` =
the host-written `sh` + `curl` script `$AXN_STATE_DIR/bin/axn-term`; the id is
the existing `AXN_SESSION_ID` — `AXN_TERM_PTY_ID` stays unset so hook event
files keep their names), and `ControlBroker` delivers the line to exactly one
browser channel — the PTY's /ws connection (`control-command` frame →
`control-reply`) or else the most recently attached Ramphastos session (duplex
`control` stream) — where `SessionBackend.onControlCommand` hands it to the same
dispatch (`tests/control-e2e.mjs` covers both transports);
`axn-term install`/`uninstall` copy the bundled
agent skills (embedded via `include_str!` from `src-tauri/skills/<name>/`) into
agent skill dirs — same scheme as `axn-dev install` (`--skills`, `--skill`,
`--project`, `--repo`, `--devin`, `--agent`, `--all-agents`). Agent-facing
conventions for programs running inside axn-term are documented in
`docs/agents.md`.

The terminal link provider (`libs/shell-ui/src/terminalLinks.ts`, used by
`libs/shell-ui/src/ShellTerminal.tsx`) reconstructs URLs split across a line break — a soft
wrap on a narrow terminal or a hard wrap inside a table cell. A `scheme://`
token that reaches the line edge or sits flush against a cell border is
extended into continuation rows (column 0 for soft wraps; the same column
under a matching border/blank prefix for table cells), and the link range
spans all fragment rows so any fragment activates the full URL. A token
padded by spaces up to a cell's right border also counts as cut off: the
continuation is the first token of the same cell on the next row, which is
only trusted when the row shares the table's border layout and every other
cell is blank (single-cell tables additionally need an unmatched `(` before
the URL — e.g. `!6 (https://…` continuing `merge_requests/6)` below). Hovering a
reconstructed URL shows the hover card with the joined link (Open / Copy
URL); plain single-line URLs stay click-only. Selecting text also opens the
card: a one-word selection resolves as a path/URL; a selection spanning rows
is rejoined without its wrap indentation (`wrappedSelectionCandidates` in
`terminalLinks.ts` — agent TUIs hard-wrap long paths onto an indented
continuation row) and its longest path/URL-like word that resolves gets the
card; otherwise a copy-only card. The hover card is placed from
its measured size (`placeHoverCard` in `hoverCardPlacement.ts`, re-run via
ResizeObserver as its preview loads): below/right of the pointer, flipped
above near the bottom edge and to the left near the right edge.

## Online session hosts (gateway env)

`apps/gateway/SessionHostContainerService.cs` spawns one container per user.
Env knobs (passed through `scenarios/axn-term-online/compose.yaml`):

- `SESSION_HOST_RUNTIME=kata` + `SESSION_HOST_DIND=1` + `SESSION_HOST_USER=0:0` —
  per-user VM with an inner dockerd.
- `SESSION_HOST_HOME_VOLUME=<prefix>` — named volume `<prefix>-<user>` mounted
  at `/home/<user>`; `$HOME` persists across session-host recreation.
- `SESSION_HOST_NIX_VOLUME=<prefix>` — named volume `<prefix>-<user>` mounted
  at `/nix`, seeded once from the image's `/opt/nix-seed` (a full single-user
  nix install baked into the session-host image). Entrypoint writes
  `/etc/nix/nix.conf` (unsandboxed builds, flakes enabled) and puts
  `~/.nix-profile/bin` + the default nix profile on PATH via
  `/etc/profile.d/nix.sh` and `/etc/bash.bashrc`.
- `SESSION_HOST_PREFIX` — container name prefix (default `axn-term-host`);
  `SESSION_HOST_HOSTNAME` — in-guest hostname (default `axn-machine`).
- `AXN_NIX_FLAKE` — deployment-wide default home-manager flake ref.
- `SESSION_HOST_MEMORY` / `SESSION_HOST_PIDS` / `SESSION_HOST_CPUS` —
  per-container limits (defaults `4g` / `4096` / `2`; `0` lifts a limit).
- `SESSION_HOST_ALLOW_UNSAFE_RUNC=1` — permit `SESSION_HOST_DIND`/
  `SESSION_HOST_PRIVILEGED` without kata (otherwise the gateway refuses to
  start; DIND under runc is effectively host root).
- `AXN_EXEC_TIMEOUT_SECONDS` — session-host `exec` timeout (default 120;
  the process tree is killed on timeout or cancel).

Session hosts only accept requests carrying the per-container secret the
gateway generates at create time (`AXN_SESSION_HOST_SECRET` in the container
env, sent as `X-Axn-Session-Secret`). The entrypoint moves it into a
root-only file (`AXN_SESSION_HOST_SECRET_FILE`) before starting the host,
so no PTY or exec child can inherit it. A host
without the env refuses to start unless `AXN_SESSION_HOST_INSECURE=1`
(local runs only); the gateway recreates pre-secret containers. Containers
are keyed by the token's username when it is already a clean ASCII name
(`[a-z0-9_-]`), else `<ascii-prefix>-<8 hex of sha256(name)>` so distinct
names never share a container or home volume; tokens without an identity
claim are rejected (no `?user=` fallback).

Per-user environment sources live in the persistent home (applied on every
spawn, in the background — see `scenarios/axn-term-online/session-host/entrypoint.sh`):

- `~/.config/axn-term/nix-flake` — home-manager flake ref (wins over
  `AXN_NIX_FLAKE`); applied via `nix run home-manager/master -- switch`.
- `~/.config/axn-term/nix-packages` — one `nix profile install` arg per line.
- `~/.axn-term/bootstrap.sh` — imperative escape hatch.

Setup output lands in `~/.local/state/axn-term/{nix-setup,bootstrap}.log`.
`POST /session/recreate` (gateway, authenticated) force-removes the caller's
session host; the next `/ws` connect respawns it with volumes reattached —
that's the user-facing "re-apply my environment" trigger. Spawns are
serialized per user in the gateway (StrictMode double-mounts race otherwise).

## Build commands

```bash
# Local development
pnpm install
pnpm dev:desktop

# Release build (produces target/release/bundle/)
pnpm build:desktop

# Dev variant: axn-term-hmr.app (yellow icon, HMR frontend, own state dir)
pnpm build:hmr

# Storybook (component catalog for apps/desktop)
pnpm --filter @axn-term/desktop storybook

# …or containerized with HMR through the published port:
axn-dev start -s axn-term-storybook   # http://localhost:8098
```

`src-tauri/build.rs` stamps `AXN_BUILD_DATE` (UTC, re-run when `../dist`
or `src` change); `lib.rs` swaps the default menu's macOS "About axn-term"
item for one showing "Version <x.y.z> (built <date>)".

Native menu bar (`app_menu` in `lib.rs`): macOS keeps Tauri's default menu
set (About shows version + build date, Preferences…, added View submenu).
Linux/Windows get a small custom menu — &File (Preferences…, Quit),
&View (Zoom In/Out/Actual Size — emit `menu-zoom` → `uiZoom` setting — and
Reload — `menu-reload` → the state-saving window reload), &Help (About).
The stock `Menu::default` is avoided there because only its About works
and its Edit accelerators (Ctrl+C/X/V/A/Z/Y/M) would be swallowed before
the PTY sees them; Quit is a custom `axn-quit` item for the same reason
(the predefined one binds Ctrl+Q, needed for XON). The bar starts hidden
per window (`hide_menu` in `create_window_with`); the frontend toggles it
on a solo Alt tap via `toggle_menu` (Thunderbird-style, Alt-as-modifier
does not toggle), accelerators stay live while hidden, and `on_menu_event`
re-hides it after any item is picked (which also covers a just-opened
settings window).

Built macOS artifacts:

- `target/release/bundle/macos/axn-term.app`
- `target/release/bundle/dmg/axn-term_0.1.0_aarch64.dmg`

`build:desktop` runs `tauri build --bundles app` and then
`build/scripts/make-dmg.sh`, which packages the .app into the DMG with a
single `hdiutil create -srcfolder ... -format UDZO` step (app +
`/Applications` symlink in a staging dir). It deliberately avoids
tauri-bundler's create-dmg fork: its read-write image + Finder-prettifying
AppleScript regularly fails on unmount ("resource busy") and leaves stale
`rw.*` volumes mounted.

App icons: `src-tauri/icons/icon.icns` is **not** generated by `tauri icon`
— it comes from `src-tauri/icons/icon-macos.svg`, a plated variant
(axn-dark `#141110` squircle plate, Apple 824/1024 grid) of the transparent
axn-term glyph the PNGs/.ico use, rebuilt by
`build/scripts/make-macos-icon.sh` (rsvg-convert + iconutil). macOS
composites Dock icons over the translucent Dock, so the transparent
interior shows through as white/gray there. Regenerating the shared icon
set with `tauri icon` would restore the transparent `.icns` — re-run
`make-macos-icon.sh` afterwards. The axn-term-hmr dev variant has its own
set in `src-tauri/icons-hmr/`: the same plated glyph on the dev yellow
`rgb(227 179 65)` — unlike the production set, every raster asset there
(PNGs, `.ico`, `.icns`) is rendered from the plated
`icons-hmr/icon-macos.svg` so the yellow identifies the dev build on all
platforms. `tauri.term-hmr.conf.json` points `bundle.icon` at it and
`build/scripts/make-macos-icon.sh hmr` regenerates the whole set.

## Internationalization (Lingui)

UI strings are localized with [Lingui](https://lingui.dev) 6 (macros via
`@lingui/babel-plugin-lingui-macro`, configured in `apps/desktop`,
`apps/web` vite configs and `libs/shell-ui/vitest.config.ts`).

- Catalogs: `libs/shell-ui/src/locales/{locale}/messages.po` — `en` is the
  source locale, `ko` is translated. Compiled `messages.ts` files sit next
  to the .po files and are committed. `lingui.config.ts` at the repo root
  scans `libs/shell-ui/src`, `apps/desktop/src`, `apps/web/src`.
- After changing wrapped strings: `pnpm i18n:extract` (updates .po files)
  → translate new `msgstr` entries → `pnpm i18n:compile` (regenerates
  `messages.ts`).
- In components use `const { t } = useLingui()` and
  `import { Trans, useLingui } from '@lingui/react/macro'`; wrap JSX text
  in `<Trans>…</Trans>` and attribute/dynamic strings in `t\`…\``. For
  module-level message tables use `msg` from `@lingui/core/macro` and
  translate at render time with `t(descriptor)` — a `t` received as a
  function parameter is NOT a macro binding and is silently skipped by
  extraction.
- `libs/shell-ui/src/i18n.ts` owns the global `i18n` instance and loads
  all compiled catalogs statically; `SettingsProvider` wraps children in
  `I18nProvider` and calls `activateLanguage(settings.language)` on change.
- `@lingui/cli` 6.9 gates its subcommands on `import.meta.main`, which Node
  22 lacks (added in Node 24) — `extract`/`compile`/`check` silently exit 0
  doing nothing. `patches/@lingui__cli@6.9.0.patch` replaces the gate with a
  `process.argv[1]` comparison so `pnpm i18n:extract`/`i18n:compile` work on
  Node 22.
- `libs/shell-ui/src/i18n.test.ts` fails when a compiled catalog misses an
  `en` message id or a non-`en` `.po` entry has an empty `msgstr` — a missing
  translation surfaces in the UI as untranslated English (or a raw hash id
  where no `message` fallback exists). The same file also runs
  `lingui check sync` (`pnpm i18n:check`), which fails when a wrapped string
  was added to the code but never extracted — the catalog-vs-catalog checks
  cannot see a msgid that never entered the .po files.
- User-facing control: `language` setting in `config.yaml` (`en`/`ko`) and
  Settings → General → Language.

## Session view plugins

Session-view plugins implement `SessionViewPlugin` (`libs/shell-ui/src/app/session-plugins/plugin.ts`): `id`, `title`, `version`, `dependsOn`, `stateKey`/`settingsKey`, `defaultEnabled`, plus optional `sessionFields` (session-card information — see **Session card** below), `onOutput`, `onCommand`, `onSessionOpen`, `onClose`, `repoMenuItems`, `sessionMenuItems` (rows contributed to the session right-click menu — dev-workflow adds its start/move/stop entries there), `workspaceMenuItems(ctx, workspace)` (rows in the workspace-header context menu; `ctx` binds to a representative session — the selected one when it lives in that workspace, else the workspace's first — and workspaces without sessions get no plugin rows). `version` (`x.y.z`) is shown in Settings and matched by `dependsOn` — each dependency `{ id, version? }` must be registered, enabled, and satisfy the optional constraint (`1.2.3`, `>=`/`>`/`<=`/`<`, `^` same-major) or the plugin counts as disabled (unmet deps are listed in Settings; cycles resolve to disabled). All built-in session-view and file-preview plugins carry `version: '0.1.0'`; external `.mjs` plugins may declare both fields on their default export. Plugins can be bound to a foreground process via `processPattern` (regex on `session.process` — the argv-derived identity, see below; anchor it, e.g. `/^claude/i`, so programs merely containing the name don't match); when the process exits, `onProcessEnd` fires once — use it to clear process-bound UI like task lists or progress bars. A plugin whose program edits its own input line declares `agentInput: { title? }` (devin does): while it is foreground, hidden-command interception switches to `'agent'` mode instead of off, and `session.agentInput` carries the plugin id — set from the 1 s process poll, or earlier from an OSC terminal title matching `title`. The core resolves both through `agentInputPluginFor`/`agentInputPluginForTitle` (`agentHookBridge.ts`, over the enabled plugins) and never names a specific agent. The plugin API (`PluginApi`) provides `writeToSession`, `updatePluginState` (merged against latest state), `pluginState`, `pluginSettings`, `exec(command, cwd?)` (runs `sh -c` via the `plugin_exec` backend command), `readFile(path, cwd?)`/`writeFile(path, contents, cwd?)`/`statPath(path, cwd?)` (backend file ops via `backendFileService` — work on desktop and web; `statPath` resolves null when absent), `waitForSessionOutput`, `openBrowser(path)` (opens an `axn-browse` directory
tab for the session), `openTab({ path, kind })` (opens an
editor/browser/preview/git sub-view tab), `repoMenuItems(repo)` (the rows
all enabled plugins contribute to the repo context menu), `setBanner(banner
| null)` — a dismissible strip on top
of the session view, stored in pluginState under the reserved `banner` key
(`SessionBanner { message, level?: 'info'|'warning'|'error', dismissible?,
actions?, trailingActions? }`; `dismissible: false` hides the ✕ — the plugin
clears the banner itself; `actions`/`trailingActions` are JSON-safe
`SessionBannerAction { id, icon?, label?, title?, disabled? }` buttons
rendered before the message / at the right edge — clicks route to the
plugin's `onBannerAction(ctx, actionId)` hook); banners from
all enabled plugins stack above the session's tab strip and are rendered by
the shared `Banner` component (`app/Banner.tsx`), also usable for app-level
notices — and `setAttention(attention | null)` — a per-plugin
"needs attention" flag stored in pluginState under the reserved `attention`
key (`SessionAttention { message?, level?: 'warning'|'critical' }`). A raised
flag also fires `services.notify` — once per flag content, and only for
sessions the user isn't looking at (a different session is selected or the
window is unfocused) —
and `setRestoring(label | null)` — raises/clears the plugin's "restoring"
overlay over the session's terminal (in-memory store `app/restoring.ts`,
keyed sessionId → pluginId → label). A plugin that restores session state
by injecting commands on open declares `pendingRestore(ctx)` — evaluated
when a session's PTY has just spawned, right before `onSessionOpen` runs
(same freshly-spawned gate; never on PTY reattach); returning a display
label covers the terminal with a blocking `RestoringOverlay`
(`app/RestoringOverlay.tsx`) that steals focus so keystrokes cannot reach
xterm and race the injected restore command. The overlay clears on
`ctx.setRestoring(null)` — the plugin must call it on every resolve path —
or via the overlay's × button for hung restores. The devin plugin uses
this: `pendingRestore` returns `devin session '<name>'` when
`restore-session` is on and a captured name exists, and `finishRestore`
clears it on ok/gone/timeout. Restore also requires the agent to have been running when the session went away (`devinActive`/`claudeActive` in pluginState): set while the agent is foreground, cleared when it exits on its own or the session closes at a plain prompt, kept when `onClose` (or a crash) stops it — the captured name/id survives for `axn-devin-resume`/`axn-claude-resume` either way.
Separately, every agent exit also publishes an `at`-stamped "last session"
into the plugin's app-level pluginData (`pluginData.<key>.last`, shared
across sessions) via the shared `agentResume.ts` module: the captured
name/id's exact resume line (`devin -r <name>`, `claude --resume <id>`
with its `--worktree`), else the agent's "continue latest" line (`devin
-c`, `claude -c`, `codex resume --last`, `agy -c` — vibe records
named exits only, its bare `-r` lists sessions). Exactly ONE last exists
across agents — the newest record by `at`, tracked in the module's
in-memory registry (seeded from the persisted records on read).
`agentResumeMenuItem` is each agent plugin's `sessionMenuItems`
contribution — `Resume <agent> session '<name>'` — offered only while no
process runs in the session (neither `session.process` nor
`session.agentInput` set) and only by the agent owning the global last,
so a menu shows at most one resume row; the click dispatches the stored
line like a typed command so `onCommand` bookkeeping sees it. Each record
also carries a `title` — the conversation's display name captured at exit
from the session's `autoName` (the agent's OSC title, e.g. a `/rename`
name, with its own `<cli>: ` prefix stripped via `stripAgentTitlePrefix`)
or the custom session name — and UI labels prefer it over the raw
name/id. `agentResumePanel` (`agentResumePanel.tsx`) is the same offer as
a `<agent>.resume` session field (a button on the selected session's card), behind each
agent plugin's `resume-button` setting (default on; the menu row shows
regardless). Both go through the shared `resumableAgentLast` gate and
`resumeAgentSession` dispatch. A restore's
'gone' outcome clears a matching record (`forgetLastAgentSession`). Flags
surface as a pulsing disc underlaying the session's process icon; `critical`
(the default) is red, `warning` orange. `renderRail` plugins get a
`setAppAttention(attention | null)` for app-level flags (e.g. the RAM plugin
flagging memory pressure); app-level flags live in the in-memory store in
`app/attention.ts` and aggregate with session flags into the rail's dot.
Selecting a session clears its flags (`clearSessionAttention`, plugin flags
and sub-shell `tab.hookAttention` alike — the latter also clears on user
input into any of the session's terminals: `onUserInput` fires from
`sendInput`/`Shift+Enter` on chunks `isUserInput` proves aren't
terminal-generated query replies).
The rail slot under the hamburger is a permanent `active/total` session
counter (running processes / open sessions) — when flags are raised the
pulsing dot + level icon render inside the same fixed-height slot (click
opens the attention modal), so plugin rail views below never shift.
Plugin rail icons are reorderable by dragging — pointer-driven
(`startRailDrag` in `ShellApp`, `railDropIndexAt` in `app/railOrder.ts`),
not HTML5 drag-and-drop: rail views are `<button>`s and WebKit starts no
drag from a button press (macOS only showed a "+" cursor). Press, move 4px,
release to drop, Esc cancels; the click after a drag is swallowed. The
chosen order persists in window state
`pluginData['axn-rail'].order` — a preference list over plugin ids handled
by `app/railOrder.ts` (unlisted plugins append in registration order,
disabled ones keep their slot for re-enable).
The devin plugin uses this for idle detection: while devin runs, a quiet
screen for `devin.idle-timeout-seconds` (default 45) raises a `warning` flag
whose message guesses "waiting for input" vs "possibly finished" from the
output tail. Silence only counts once the user has selected the session and
the screen changed thereafter — `app/attention.ts` tracks each session's
last selection timestamp (`noteSessionSelected`/`sessionLastSelectedAt`)
and `watchedOutput` in devinTasks records which selection an output chunk
followed; sessions the user never watched never flag, and re-selecting a
session resets the baseline. Two filters keep repaints from gaming this:
only chunks that actually change the visible screen re-arm the timer
(`screenSeen` fingerprint — TUI repaints/reflows/attach replays resend
identical text), and "possibly finished" additionally requires devin to
have been seen working (`workSeen` — the `(esc twice to interrupt)` hint
on screen) since the user's last look, so a session quiet at its prompt
never claims to have finished. The same hint marks the session `running`
in the badge even when every todo row shows done (or none exists —
stepping back to idle takes two hint-free scans so a flicker cannot flap
it).

For task/progress detection the devin plugin scans the session's live
xterm screen (`ctx.getScreenLines()`, throttled to ~1/s while devin is
foreground) for the `│ glyph N.` task rows — Devin ≥3000.11 renders the
todo list inside the TUI's live region whose diffed updates never reach
scrollback, but the resolved screen buffer holds them cleanly. Because
detection follows what this terminal displays, no session-id mapping is
needed. A vanished block keeps the last list (`onProcessEnd` owns the
clear); the older marker-gated `parseDevinTasks` scrollback parser
remains as a fallback for pre-3000.11 CLIs.

**Session card** — plugins only *provide* session information; the panel
assembles each session's card. A plugin declares `sessionFields:
SessionField[]` (`session-plugins/plugin.ts`): `{ id, label, kind: 'inline'
| 'block', zone, value(ctx), tip?(ctx) }` — `inline` is a compact badge/chip,
`block` full width; `zone` is the default placement; `value` returns null
when there is nothing; `tip` adds `<marker>: <meaning>` lines to the card
tooltip while the field shows. Fields are addressed `<pluginId>.<id>`;
built-ins are `core.name`, `core.status`, `core.summary`, `core.process`,
`core.tasks`, `core.progress` (`CORE_FIELDS`). The card has three zones
(`app/sessionCardLayout.ts`): **title** (one row, inline fields only),
**always** (rows under the title on every card) and **selected** (rows only
on the selected card); a row of several inline fields renders `·`-joined.
The `sessionCard` setting in config.yaml (`{ title: [ids], always: [[ids]],
selected: [[ids]], hidden: [ids] }`) lays it out: a configured zone
replaces that zone's default, a field placed explicitly anywhere is left
out of default zones, unknown ids are skipped (a disabled plugin's fields
vanish), blocks configured into the title row move to the selected zone,
`core.name` is always in the title row, and a built-in field placed nowhere
and not `hidden` falls back to its zone. A **plugin field shows only where a
layout names it** (`resolveCardLayout`); its `zone` is only a hint. Each
unset zone falls back to the shipped `DEFAULT_SESSION_CARD`, which lists
today's card explicitly (git/MR/PR/vibe/worktree/persona badges, plugin
blocks) and deliberately leaves out `tagging.tags` and `jira.tickets`; a
new plugin's fields must be added there or to the user's `sessionCard`. `SessionItem`
(`SessionPanel.tsx`) renders it. This replaced the per-plugin `renderRow`/
`rowTip`/`render` hooks (and the short-lived `sessionLine`); external `.mjs`
plugins declaring the old hooks still work — `pluginSessionFields` adapts
`renderRow`(+`rowTip`) to a `<id>.row` title field and `render` to a
`<id>.panel` selected block. `findSessionField(plugin, id)` looks one up.
A field may also declare `search(ctx)` — the plain-text term(s) the panel
filter matches for it (mirroring `value`'s gate: null when nothing shows).
Only fields the layout places (any zone; the selected zone counts) are
searched, never hidden ones, so every match is something the card can
show; core terms are the name/`autoName`, the summary (while
`sessionSummaries` is on) and the process (`sessionSearchTerms`). Searchable
built-ins: `git-status.branch`/`.repo` (branch, repo name),
`glab-mr.mr`/`.mrs` and `gh-pr.pr`/`.prs` (refs + titles),
`worktrees.worktree`, `dev-workflow.state` (workflow, state, declared var
values) and `jira.tickets` (keys, plus status/summary once cached —
`peekEnrichment`); `agents.persona` is deliberately not searchable (the
agents view owns persona lookup).
Built-in field ids: `git-status.branch`/`.repo`, `glab-mr.mr`/`.mrs`,
`gh-pr.pr`/`.prs`, `agents.persona`, `worktrees.worktree`,
`vibe.attention`/`.panel`, `claude`/`codex`/`antigravity`/`opencode`
`.resume`, `devin.panel`, `dev-workflow.state`, `ram.memory`,
`jira.tickets`; sandboxed plugins offer their pushed surfaces as
`<id>.row`/`<id>.panel`.

Plugins with `renderView` offer a full-area plugin view: the rail ctx gains
`viewActive`/`toggleView`, and activating it deselects all sessions in the
panel and renders `renderView({ pluginSettings, close, appState,
updateAppState, openTab, sessions, selectSession, sessionApi })` in place of
the session terminals (the selected session's terminal stays
mounted, hidden — other sessions have no view at all). `sessions` lists live `ShellSession`s,
`selectSession(sessionId)` closes the view and focuses that session, and
`sessionApi(sessionId)` returns a `PluginApi` bound to that session so the
view can drive sessions other than the selected one (the dev-workflow kanban
moves states on cards). Selecting a session or using the session/workspace keyboard
navigation closes the view. `appState`/`updateAppState` (also on the rail ctx)
read and shallow-merge the plugin's persisted app-level data — window state
`pluginData.<settingsKey>` in `state.json`, the view counterpart of
per-session `pluginState`.

Plugins declaring `repoDirs(ctx)` report local repos (`RepoDir { path, name?, remote?, worktrees? }`, `ctx.exec` runs `sh -c`). ShellApp publishes the enabled providers to `app/repoDirectory.ts`; `localCheckouts(exec, roots)` combines them with a search of the caller's roots and expands every repo into its checkouts (main + linked worktrees, branch, `origin`), deduplicated by path — sources add, never replace. The root search reads git's metadata files instead of running git (`repoProbeScript`: `.git` file → `gitdir:` → `commondir`, `worktrees/*/gitdir`, `HEAD`, `config`), prunes `node_modules`/`target`/… and is cached per root set for 5 minutes; `remoteMatchesProject` matches a forge project path exactly.

Plugins declaring `hostsTabs` get a tab strip inside their view: `renderView`
is pinned leftmost as `view`, hosted sub-view tabs (browser/editor/preview —
never sub-shells, their PTYs stay bound to the owning session) follow and are
persisted in window state `pluginTabs.<plugin-id>`. `openTab({ path, kind })`
opens one. Right-clicking any session tab offers "Move to" a tab-hosting
plugin view; right-clicking a hosted tab offers moving it back to any
session. `Ctrl/⌘+Alt+←/→` cycles the hosted tabs while the view is active.

The `awesome-list` plugin (`session-plugins/awesomeList.tsx`, FolderHeart
rail icon) is a local favorites list: folder/file paths, URLs and shell
commands (`type: 'command'`) kept in `pluginData['awesome-list'].items`.
Clicking opens dirs as `browser` tabs and files as `editor` tabs inside the
plugin view (files also get a Preview action, URLs open externally); clicking
a command runs it in the current session — `renderView` ctx's
`selectedSessionId` (the session selected when the view opened; the
only session otherwise) — the line is routed through `runCommand` (so
`axn-*` favorites dispatch) then written to the PTY with a trailing CR,
and `selectSession` brings the terminal forward. "Run in another
session…" (menu row) asks via the shared `pickFromList` picker, a
hover/menu "Type into session" action writes the command without CR so
it can be edited first, and "Copy command" uses `services.copyText`. Entries are added/edited/removed in the view — a leading `>`
in the add input stores a command (`> [label =] command`, ` = ` separates
the label) — or via the `axn-awesome` hidden command (`axn-awesome`/`ls`
prints a numbered list with `$` marking commands, `add <path|url> [label]`
resolves via `stat_path` against the session's live cwd, `cmd [<label> =]
<command>` stores a command, `run <n|name>` routes the stored command
through `runCommand` dispatch (so `axn-*` favorites dispatch; a plain
command replaces the typed line), `rm <n|name>` removes — `completeArg`
completes subcommand names and `run`/`rm` targets); paths resolve via `stat_path`
(`~` expands, nonexistent paths are flagged "not found" in the view). A
filter row above the list matches label and path/command; Enter activates
the top match. Right-clicking a path entry opens a context menu built on
the shared `PathActionMenu` (Open/Edit/Preview/Reveal/Copy Path + Copy for
decodable image previews, or Open/Copy URL for links) with `extraItems` for
bookmark-specific
Edit/Remove rows; command entries get a plain menu with Run/Type/Edit/Remove.

The `glab-mr` plugin (`session-plugins/glabMr.tsx`) tracks GitLab merge
requests via the `glab` CLI. Per session it runs `glab mr list -s <branch>
-F json` plus two `glab api` calls per MR —
`projects/:fullpath/merge_requests/<iid>` (for `head_pipeline.status`) and
`…/<iid>/discussions` (notes' `resolvable`/`resolved` → `openThreads`, by
`countOpenThreads`; absent on failure so the panel falls back to the
`blocking_discussions_resolved` boolean chip) — when the repo/branch
signature changes or the cached list is >5 min stale; results live in
pluginState `glab-mr.mrs`. The session-panel block shows `N open threads`;
the renderView rows show the GraphQL `description` clamped to 3 lines.
App-wide it polls `glab api graphql` (one list query over
`currentUser.assignedMergeRequests` ∪ `authoredMergeRequests` without
assignee → "mine", and `reviewRequestedMergeRequests` → "review", carrying
GitLab's `userNotesCount`/`resolvable`/`resolvedDiscussionsCount` counters
instead of discussions — GitLab cuts a request off at ~30 s and resolving
every note author timed out; review MRs' discussions follow in aliased
batches of 8, only for MRs whose counters changed since the last poll, so
a quiet poll is one call) on a
`glab-mr.refresh-interval-seconds` cadence (default 120) — the rail teaser
shows `action/total` for mine and `waiting/total` for review, and toggles
the plugin's renderView listing both sets. `glab-mr.hostname` overrides the
`glab api --hostname` default.

The `gh-pr` plugin (`session-plugins/ghPr.tsx`) is the GitHub twin, driven
by `gh`. Per session it runs `gh pr list --head <branch> --json
number,title,url,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,isCrossRepository,headRepositoryOwner`
plus one batched `gh api graphql` call (PR numbers as `-F` variables) for
`reviewThreads.isResolved` — resolution state is GraphQL-only; the per-PR
unresolved count lands in `openThreads` (the panel shows `N open threads`;
the renderView rows show the fragment's `bodyText` clamped to 3 lines).
`--head`
matches the branch *name* in any fork, so `ownPrs` keeps same-repo PRs and
fork PRs only from the owners of the remotes this checkout pushes to (origin
plus the branch's push/tracking remote) — otherwise a session on `main` of a
popular repo shows strangers' fork PRs named `main`. Results live in
pluginState `gh-pr.prs`. App-wide it polls `gh api graphql` with
`is:pr is:open assignee|author|review-requested:@me` searches on a
`gh-pr.refresh-interval-seconds` cadence (default 120); `gh-pr.hostname`
overrides `gh api --hostname` (GHES). The search fragment is sized under
GitHub's 500,000-node query limit (`reviewThreads(first: 50)` ×
`comments(last: 20)` — `last`, because `mrWaitingForMe` reads a thread's
newest note). It shares glab-mr's model fields and classification helpers —
`mergeMine`, `openThreads`, `mrNeedsAction` + `prNeedsAction` (adds
`changes_requested`), `mrWaitingForMe` — and renders the same
rail/panel/row/view surfaces plus a `changes requested` badge; rows carry
the shared `mrActions` providers (dev-workflow's `review` button resolves
`pull/N/head`).

Both forge plugins are on by default and stay quiet where they don't apply
(shared helpers in `session-plugins/forge.ts`):

- A session only queries its own forge: `forgeOfRemote(repo.remote)` —
  the plugin's `hostname` setting, else `github`/`gitlab` in the origin
  host — makes gh-pr skip GitLab repos and glab-mr skip GitHub repos;
  unknown hosts try the CLI.
- Every command runs behind `forgeCliCommand` (a `command -v <cli>` guard
  that fails with a fixed `axn-term: <cli> is not installed` marker), and
  `classifyCliError` sorts overview failures into `missing`, `signed-out`
  (`gh auth login` / `Invalid token` / an anonymous `currentUser: null`)
  and `error`. `forgeRailMode` turns that into the rail: hidden while the
  CLI is missing (and until the first result, so nothing flashes up), a
  muted icon with a sign-in hint when signed out, the red triangle only
  for real errors (network, API). The failure is kept through `loading`
  so the rail doesn't flicker between polls.
- All arguments reach `sh -c` single-quoted via `shellQuote` — git allows
  branch names like `$(…)`, and the GraphQL queries carry `$variables`.
- Each forge plugin has its own `repo-roots` setting (`glab-mr.repo-roots`,
  `gh-pr.repo-roots`; comma separated, `~` expands): folders searched for
  local clones. They add to the repos enabled `repoDirs` providers report
  (e.g. axn-dev), deduplicated by checkout path, and reach MR row actions as
  `MrRowEnv.checkouts`. The views warm the cached search when they open.
  The dev-workflow review button uses them when no open session sits in the
  MR's project: the main checkout whose `origin` matches the project path
  exactly hosts the fetch + `git worktree add` (run through any session,
  every command `git -C <repo>`). A session already open in the MR's review
  worktree is selected instead of opening a second one.

**Card enrichers** (`session-plugins/cardEnrichers.tsx`) are a cross-plugin
capability: any plugin can add context to cards other plugins render — MR/PR
rows in the glab-mr/gh-pr views and dev-workflow kanban cards (`CardChips`).
A plugin registers a `CardEnricher` at module scope (`registerCardEnricher`,
the `mrActions.ts` pattern): `enabled(settings)`, a cheap synchronous
`match(subject, settings)` that turns a `CardSubject` (`mr` title/branch/url,
`session` name/cwd/branch, workflow `vars`) into a lookup key — no key, no
enrichment — and a batched `enrich(keys, settings)`. Every key visible in one
render pass goes to a single call (30 ms batch window), results are cached per
enricher for `ttlMs` (default 5 min) and a failed batch keeps stale data and
retries after the TTL. Results are data, not components — `chips` (`label`,
`tip`, `href`, `tone`, optional `color`) rendered uniformly by `ChipView`
(`chipStyle`: tinted fill, full-strength border, text mixed toward
`--text-primary` — border + colored text alone washed out on light themes;
`color` is a named theme color — `gray`, `blue`, `cyan`, `green`, `yellow`,
`orange`, `red`, `violet`/`purple`, `magenta`, `accent` → the theme's CSS
variable — or a hex value, anything else is dropped by `resolveChipColor`), plus `fields` namespaced by the
enricher (`jira.status`, …) — so the contract could later cross the sandbox
boundary. Outside a `PluginSettingsProvider` (`useOptionalPluginSettings`)
every enricher reads as disabled. An enricher may declare
`settingsKey(settings)` — a fingerprint of the settings its results depend
on; cached results made under another fingerprint are refetched (ticket
sources have the same hook). `useEnrichedKeys` reports a key the enricher
answered *without* as `null` (unknown — the jira session field hides it),
but a failed request leaves keys `undefined`, so an outage never hides
tickets.

The opt-in `jira` plugin (`session-plugins/jira.ts`, `jira.enabled: true`) is
the first enricher. Settings: `base-url` (https), `email`, `project-keys`
(comma list — only keys of these projects match, so `UTF-8` never does) and
the token — either `token` (literal, plain text in plugins.yaml; masked in
Settings via `PluginSettingField.secret`) or `token-from: keychain`
(`keychain-service`, default `axn-term-jira`; `keychain-account`, default the
email). Setting both is refused (logged as `not active: …`). `matchSubject`
looks for a key in the MR title, its source branch, the workflow vars
(`ticket` first), then the session branch/name/cwd basename. Lookups use
`POST /rest/api/3/issue/bulkfetch` (≤100 keys per call; unknown keys are
reported per issue instead of failing the whole query like `key in (…)` JQL)
and run through `appRuntime().exec` — `sh -c` on the desktop or the session
host, so it works on remote backends and avoids Jira's CORS. The token never
reaches curl's argv: `buildRequestScript` captures it in a shell variable —
literal, or `security find-generic-password … -w` (macOS) /
`secret-tool lookup` (Linux) — and pipes curl its config on stdin
(`curl -K -`), printing the body plus a trailing status line (`splitStatus`).
A literal token is part of the `sh -c` string itself, so it is visible to
same-user `ps` on the exec host for the request's duration; the keychain
source avoids even that. Chips show `KEY · Status`, colored by status category by
default (new gray, indeterminate yellow, done green); `status-colors`
overrides per status name or category key (`new`/`indeterminate`/`done`),
as a YAML map or the one-line `In Progress: blue; Reviewed: #8e44ad` form
the Settings field writes (`parseStatusColors`, exact status before
category — `statusColor`); backlog tickets carry the same `color`.
Summary/type/assignee are in the tooltip and the chip links to
`<base-url>/browse/KEY`. It offers one session field, `jira.tickets` (inline, shown only where `sessionCard` places it): the session's ticket keys from its MR/PR titles (glab-mr `mrs` / gh-pr `prs` per-session state, `sessionMrTitles`), else its branch, else its name (custom, else the terminal-reported `autoName`), else its cwd folder name — the first source with any key wins and may yield several (`sessionTicketKeys`/`findIssueKeys`); each renders as `KEY · Status` once the shared enrichment cache has it (`useEnrichedKeys`, `ChipView`). Where it shows is the session card layout's business (below), not a plugin setting.

The `git-inspect` plugin (`session-plugins/gitInspect.tsx`) is layered on
`git-status` (titled `git` in Settings): `dependsOn: [{ id: 'git-status',
version: '>=0.1.0' }]`, so it disables itself when git-status is off. It
owns only entry points — a "Git changes…" row contributed to the git-status
repo context menu via `repoMenuItems(ctx, repo)` (generic hook: rows come
from all enabled plugins; `ctx` is restricted to the session-bound
`RepoMenuContext`, not the contributor's own pluginState) and the `axn-git`
command — both open a session `git` tab via `ctx.openTab({ path: repo.root,
kind: 'git' })` (`openTab` on the session `PluginApi` deduplicates by
kind+path — a `base` field on the tab, set via `axn-git <ref>` or
`openTab({…, base})`, adds a "Changes vs <ref>" section to the inspect
view: a synthetic merge-base→HEAD selection producing the three-dot
merge-request diff in the same Monaco diff editor; updating `base` on an
existing tab retargets it). The repo context menu opens from both git-status surfaces:
right-clicking the repo block under the selected session, or right-clicking
the branch indicator in the session's title row (the `git-status.branch` field — its own
`RepoMenu`; contextmenu/right-mousedown stop propagation so the session
row's menu does not fire). The tab view itself lives in the app
(`GitInspectView`), so persisted git tabs keep working while the plugin is
disabled.

- Plugins are enabled per-user in `~/.axn-term/plugins.yaml` via `<settingsKey>.enabled: true|false`. Built-ins default to enabled; plugins loaded from `~/.axn-term/plugins/*.mjs` are always opt-in.
- The Settings view (`app/SettingsModal.tsx`) is a centered modal with General/Plugins tabs. The Plugins tab lists every registered session-view and file-preview plugin on the left (with an enabled dot); the right side offers the `enabled` toggle plus the plugin's declared settings. Changes persist via `updatePluginSection` (`app/PluginSettingsProvider.tsx`) — a shallow section merge that rewrites plugins.yaml (`pluginSettingsToYaml` converts camelCase keys back to kebab-case; comments in the file are not preserved by UI writes). General also holds the font settings: `shellFontFamily`/`shellFontSize` (applied to session and sub-shell terminals via `resolveShellFont` in `libs/shell-ui/src/themes.ts`, default: Monaspace stack @14px) and `panelFontFamily`/`panelFontSize` (applied to the session-panel wrapper — the size scales it proportionally against the 12px base via CSS `zoom`).
- Plugins declare UI-editable settings via `settings?: PluginSettingField[]` on `SessionViewPlugin` — pure data (`{ key, label, description?, type: 'boolean'|'number'|'string', options?, secret?, default? }` — `secret` renders a masked input for tokens) rendered generically, so external `.mjs` plugins can declare fields too. Built-ins may instead/additionally provide `renderSettings({ settings, update })` for a custom view. `git-status`, `glab-mr` and `gh-pr` each declare `show-in-panel` (gates their selected-card block field — `.repo`/`.mrs`/`.prs`; the legacy `show-in-header` key is still honored on read) and `show-in-title` (gates their title badge field — `.branch`/`.mr`/`.pr` — and its tooltip line); the `sessionCard` layout can place or hide the same fields; `devin` (`restore-session`, `idle-timeout-seconds`), `claude`/`codex`/`antigravity` (`restore-session`, `install-hooks`), `vibe` (`restore-session`, `idle-timeout-seconds`), `glab-mr` and `gh-pr` (`refresh-interval-seconds`, `hostname`) declare their fields as well.
- External `.mjs` plugins `export default` the plugin object (no JSX — a session field's `value` or a legacy `render` may return a string). They are loaded at startup through `loadExternalPlugins()` (`session-plugins/index.ts`) once `plugins.yaml` has been read — the file *watch* only reloads settings, newly dropped `.mjs` files need a restart. An `.mjs` plugin can also declare `hookSpec` (an `AgentHookSpec` from `@axn-term/plugin-sdk`, see "hook bridging" below): the host then drives the whole agent-hook bridge for it — config install per its `install-hooks` setting, event-file polling, mapped status/attention — with no lifecycle code of its own.
- Example external plugin: `plugins/axn-dev-scenarios.mjs` (copy to `~/.axn-term/plugins/` and set `axn-dev-scenarios.enabled: true`).

**Sandboxed plugins** (`~/.axn-term/plugins/<dir>/`) are the isolated tier:
each directory holds a `plugin.json` manifest (`id`, `title`, `version`,
`settings`, `commands` incl. `completeArg`, `processPattern`,
`handlesProgress`, `hostsTabs`, `logic`, `view`, `permissions`), a `plugin.mjs` logic entry
and an optional `index.html` view. Everything runs inside
`sandbox="allow-scripts"` iframes (opaque origin — no app DOM, storage or
Tauri internals); the only capability channel is the postMessage contract in
`libs/plugin-sdk` (`{ axn: 'plugin-v1' }` envelopes, `AXN_PLUGIN_API_VERSION`)
— `contract.ts` is the wire format, `api.ts` the public types
(`PluginManifest`, `SessionInfo`, `AxnClient`, …), `hooks.ts` the public
agent-hook contract (`AgentHookSpec`/`AgentHookEffect` plus the pure bridge
helpers — `mergeHookSettings`, `agentEventFile`, `agentHookScript`, …),
`shim.js` the
dependency-free client the host inlines into each frame as `window.axn`
(injected automatically; plugin files stay self-contained — sibling
`./app.js`-style references don't resolve, inline or CDN-import instead).
The bridge (`session-plugins/sandbox.tsx`) builds a `SessionViewPlugin` stub
per directory: hooks forward subscribed events (`sessionOpen`, `output`,
`close`, `line`, `command`, `completeArg`, `processEnd`, `subShellExit`,
`bannerAction`, `surfaceAction`), `axn.*` calls resolve to per-session
`PluginApi` ctxs via `sandboxRuntime.buildApi` (wired in `ShellApp`), and
`axn.setSurface('render'|'row', …)` pushes sanitized-HTML surfaces, offered
to the session card as the `<id>.panel`/`<id>.row` fields (`[data-axn-action]`
clicks → `surfaceAction`).
`renderView` mounts the view iframe (theme CSS vars injected + live
`theme`/`sessions`/`appState` pushes; `peer` relays between a plugin's logic
and view frames). Sandboxes boot/dispose with the enabled set
(`syncSandboxes`). Capabilities are opt-in via `permissions`
(`PluginPermission` in `libs/plugin-sdk/src/permissions.ts`: `exec` —
`exec`/`openSubShell`/`runCommand`; `terminal-input` — `writeToSession`, the
`line` hook and replacement lines from owned commands; `terminal-output` —
`getScreenLines`/`waitForSessionOutput` and the `output` hook; `fs-read`;
`fs-write`; `sessions` — `openSession`/`selectSession`/`activateTab`/`openTab`/
`openBrowser` and the rail views `openView`/`selectView`/`removeView`
(`getActiveView` and the `viewChanged` push need none and carry no URL);
`setRestoring` counts as `terminal-input` — its overlay takes the
terminal's input). The
bridge refuses undeclared calls with an error and never delivers undeclared
hooks; unknown entries are dropped with a warning at load. Default is none —
own pluginState, banners/attention, surfaces and swallowing owned
commands need no permission. Settings → Plugins lists the declared set.
`pendingRestore`/`repoMenuItems`/`sessionMenuItems` and
`renderSettings` stay in-process-only (sync contracts or trusted DOM).
Desktop reads plugin dirs via `list_external_plugin_dirs` /
`read_external_plugin_file`; web has no plugin dirs (capability absent).
Example: `plugins/axn-demo-note/`.
- The built-in `claude` plugin (`session-plugins/claude.ts`) is opt-in (`claude.enabled: true`). It parses Claude Code's rendered `Update Todos` block from the live screen into `session.tasks`/`session.progress` (it owns progress via `handlesProgress` while claude runs), can resume Claude Code (`restore-session: true`) — like devin it captures the conversation id from claude's exit hint (`Resume this session with:` / `claude [--worktree "<name>"] --resume <id>`; `onClose` sends Ctrl-C pairs so claude prints it, `onProcessEnd` reads it from the output tail for exits it did not drive) and restores that exact conversation behind the `pendingRestore` overlay, falling back to `claude -c` when no id was captured or a fresh `claude` launch invalidated it — and optionally bridges Claude Code **hooks** (`claude.install-hooks: true`, adapter `session-plugins/claudeHooks.ts` on the shared bridge below): `UserPromptSubmit`/`PreToolUse`/`PostToolUse` → `running` + flag cleared (PostToolUse un-blocks an approved permission at once), `PermissionRequest` → `blocked` + critical needs-you attention, `Notification` → a warning flag only — the status stays (claude also sends it when idling after `Stop`) and the bridge drops a hook-raised warning once the session is selected after it (`warningRaisedAt` vs `sessionLastSelectedAt`; critical flags wait for the next event); flags OS-notify for non-selected/unfocused sessions; `SubagentStop` is ignored (background subagents finish after `Stop`), `Stop` → `completed`, `StopFailure` → `blocked`, `SessionStart` → `idle`, `SessionEnd` clears the flag while process-end reconciliation owns the final badge. Once any hook event lands, hook state owns `session.status` and the screen scan only contributes task content; without hooks the todo-parse fallback still drives tasks/progress/status.


- Agent **hook bridging** is shared and public: the pure, dependency-free half lives in `libs/plugin-sdk` `hooks.ts` (`AgentHookSpec`/`AgentHookEffect`, `agentHookScript`/`agentHookScriptPath`, `agentEventDir`/`agentEventFile`/`agentEventLog`, `readHookLog`, `mergeHookSettings`/`removeHookSettings`, `parseHookEvent`), the host half in `session-plugins/agentHookBridge.ts` (runtime map, tty resolution + poll loop, config sync, `hookStatusOwned`). A plugin declares `hookSpec` on its `SessionViewPlugin` object — built-in *or* external `.mjs` — and the host drives the bridge for it: on output dispatch `maybeWireHookSpec` syncs the agent's config per the plugin's `installHooks` setting and starts the poll while `processPattern` matches, `releaseHookSpec` on process end stops polling and clears the flag (spec-only plugins get the default terminal badge — 'completed' persists, anything else → idle), `dropHookSpec` on session open/close forgets the runtime (all in `ShellApp`'s dispatch points). Built-ins (`claude`/`codex`/`antigravity`) declare `hookSpec` and keep only their extras (todo parsing, resume commands, `<agent>Seen` tracking) — nothing wires the bridge by hand. The spec itself carries the agent id, its event list, config file (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/config/hooks.json` — claude/codex use the grouped `hooks.<Event> = [{matcher?, hooks:[{type:'command', command}]}]` schema and a `hook_event_name` stdin payload; agy's file holds named hook groups `{"<name>": {enabled, <Event>: [...]}}` with a discriminator-free payload and a required JSON response, so its spec installs a wrapper script (`agy-hook.sh`) via custom `install`), and the event→status/attention map; agents with a non-JSON config (e.g. a JS plugin file) provide the spec and a custom `install` via the same contract. The bridge installs one script, `~/.axn-term/agent-hook.sh <agent>`, which appends each hook's stdin JSON as one line to `$AXN_TERM_STATE_DIR/<agent>-events/pty-<AXN_TERM_PTY_ID>.jsonl` (tty-named for terminals without the PTY id) — an append-only log per PTY: payloads over ~3.5 KB shrink to `hook_event_name`/`tool_name`/`notification_type` so every append is one atomic write, and past 64 KB the log rotates to `.jsonl.1` under a `mkdir` lock. While the agent is foreground the host polls the log (`pollHookEvents`/`readHookLog`, 1.5 s, offset + first-line cursor, reads the `.1` tail across a rotation) and applies every new event in order — the first read of a log applies only its newest event, and a warning never downgrades a live critical flag (`nextHookAttention`), so a PermissionRequest followed by a Notification stays "needs you". A latest-event `.json` from an older script is still read as a fallback. Hook events then own `session.status`. Agents in sub-shell tabs write to their tab PTY's own log: `SubShellView`'s 1 s foreground poll drives `createTabHookWatcher` (`app/subShellHooks.ts`) through the enabled plugin whose `processPattern` matches (`hookPluginFor`), setting `tab.hookStatus` (a dot on the tab — red pulsing for blocked) and `tab.hookAttention`, which `sessionAttention` rolls up as `tab:<label>` and OS-notifies when the tab is not in view; a warning clears once the tab is shown, a critical flag on the agent's next event. The same tick also tracks the tab agent's task list: plugins may declare a pure `screenTasks(lines)` (claude, devin), sub-shell xterms are registered in `terminalRegistry` under their tab id, and `tabTaskPatch` (`app/subShellTasks.ts`) stores `tab.tasks`/`tab.progress` — shown as done/total on the tab (list in its tooltip); a vanished block keeps the last list, an agent exit drops an unfinished one. Install merges axn-term-owned entries into the agent's config (foreign hooks/settings preserved, removed again when disabled — legacy `claude-hook.sh` entries are cleaned up too). The sandboxed manifest tier has no `hookSpec` yet — `mapEvent` is a function and cannot cross the iframe postMessage boundary; a declarative event→effect map in `plugin.json` is the planned bridge. The opt-in `codex` plugin (`session-plugins/codex.ts` + `codexHooks.ts`, `codex.enabled`/`install-hooks`/`restore-session` → `codex resume --last`, `axn-codex-resume`) maps `PreToolUse`/`PostToolUse`/`SubagentStart`/`SubagentStop`/`UserPromptSubmit` → `running`, `PermissionRequest` → `blocked` + critical flag, `Stop` → `completed`, `Interrupt`/`SessionStart` → `idle`; note codex requires new hooks to be trusted once via `/hooks` (trust review). The opt-in `opencode` plugin (`session-plugins/opencode.ts`, `opencode.enabled`/`restore-session`) mirrors the devin/claude resume flow without a hookSpec: it resolves the ended conversation via `opencode session list --format json -n 1` in the session cwd (project-global, so the top `ses_` id is adopted only when its `updated` timestamp falls inside the observed run window — otherwise `opencode -c`), plus an output-tail scan of the older TUI exit hint; records `opencode -s <id>`/`opencode -c` as the shared last-session record, tracks manual `opencode`/`-s` launches via `onCommand`, and auto-resumes reopened sessions when `opencodeActive`. The opt-in `antigravity` plugin (`session-plugins/antigravity.ts` + `antigravityHooks.ts`, same settings, `restore-session` → `agy -c`, `axn-agy-resume`) targets the Antigravity CLI (`agy`): `SessionStart` → `idle`, `PreInvocation`/`PostToolUse` → `running`, `Stop` → `completed` (`USER_CANCELED`/`ERROR` → `idle`). agy has no permission-request hook event, so no blocked/needs-you signal; `PreToolUse` is deliberately not wired — its required `decision` response would let a passive observer approve tools. The plugin also captures agy's `agy --conversation <id>` exit hint from output into `agyConversationId`, so `axn-agy-resume`/menu resume/`restore-session` can name the exact conversation, falling back to `agy -c` (most recent in the cwd).

- The built-in `vibe` plugin (`session-plugins/vibe.tsx`, opt-in `vibe.enabled: true`) tracks Mistral Vibe sessions without a hook surface — Vibe has no documented lifecycle hooks, so detection is screen/output parsing like the pre-hook devin path: symbol-based task lines (`[ ]`/`[~]`/`[x]`/`[!]`, `○`/`●`/`✓`/`✗`) plus `Task X/Y` progress markers drive `session.tasks`/`progress`/`status` (parsed in a short window after an "updated todo list" marker), a terminal badge reconciles on process end ('completed' persists, else idle) and clears on a new submitted command, session names matching attention patterns (`? vibe`, "action required", …) raise a warning flag + a `!` marker (`vibe.attention` field), and the idle timer flags a quiet session as "waiting for input"/"possibly finished" (`idle-timeout-seconds`, default 45). `/exit` inside vibe arms an 8 s exit-capture that reads the post-exit `vibe -r <name>` resume hint into `vibeSessionName` (+cwd), which powers `restore-session` (`pendingRestore` → `vibe -r <name>`) and `axn-vibe-resume` (with a `cd '<cwd>' &&` prefix when the recorded cwd differs). No `hookSpec` — nothing to bridge.
- The built-in `dev-workflow` plugin (`session-plugins/devWorkflow.tsx`, opt-in `dev-workflow.enabled: true`) is a meta layer above agents: `plugins.yaml` defines workflows (`dev-workflow.workflows.<id>` — `states`, `start`, optional `transitions`, optional `vars` declarations, per-state `steps` as a map of named actions, each with `agent`/`prompt`/`prompt-file`/`command` templates, `run-in: shell|sub-shell|headless` and `auto` to fire on every entry into the step's state (start + later transitions — the on-enter hook); the flat single-action form parses as one anonymous `default` action; every action takes an optional `description` — the reserved `description` key in a named-actions map describes the state itself — shown as the session banner's lighter `detail` text and leading the Run buttons' tooltips). Declared vars are supplied by `axn-workflow start <wf> [arg|key=value]`, card fields, `axn-workflow set`, or the `axn-workflow-var[<token>]:` marker; they substitute into `{{key}}` templates and ride every launched action's env (`KEY=value`, plus `AXN_WORKFLOW`/`AXN_STATE`/`AXN_ACTION`/`AXN_WORKFLOW_TOKEN`). A `command` action's exit code is recorded as an informational check (`pluginState.checks['<state>:<name>']`, never gating) — via a printed `axn-workflow-check[<token>]:` trailer for `shell`, the `ctx.exec` result for `headless`, and the `subshell-exited` code for `sub-shell` (`openSubShell` returns the tab id, `onSubShellExit` resolves it). The state of record lives in the session's `pluginState` (persisted in state.json); an optional `tracking.file` (repo-root-relative or absolute, extension picks `.json` vs YAML) mirrors it as an agent-writable surface — agents can also move the workflow by printing a whole line `axn-workflow-state[<token>]: <state>`, report a check via `axn-workflow-check[<token>]: <name> <rc>`, or fire a named action via `axn-workflow-run[<token>]: <name>`, all adopted from PTY output. `<token>` is a random per-binding secret (`pluginState.token`, minted on bind, dropped on stop) handed only to launched actions as `$AXN_WORKFLOW_TOKEN`/`{{workflow_token}}` — tokenless marker lines (a `cat`ed hostile file) are ignored. Commands `axn-workflow start`/`axn-workflow set`/`axn-workflow move`/`axn-workflow run`/`axn-workflow`/`axn-workflow stop`, start/move/run rows in the session context menu (`sessionMenuItems` — with several workflows a single "Start workflow…" row opens a searchable picker), a banner + under-session state chip, and a rail kanban view whose cards jump to sessions, move states via `sessionApi`, show editable var fields, and stack one run button per action with check badges. A workflow declaring a *required* `kind: mr` var also surfaces a button labelled with the workflow's `title` on glab-mr's MR rows (`mrStartWorkflows`; optional mr vars get none); the var's `when: { role: author|reviewer|other }` limits it to MRs where you have that role — `mrRole` in `forge.ts` (assignee → author, requested/past reviewer → reviewer, nobody assigned → creator author / others reviewer, else other), from the per-MR people cache glab-mr/gh-pr keep (`createMrPeopleCache`, `registerMrResolver`/`useMrDetails` in `mrActions.ts`; overview poll + per-session fetch fill it, one CLI call per miss); a row whose role is unknown offers only workflows without a role condition, starts fill `mr_role`; no workflow ships, so no button appears unless plugins.yaml declares one via the `mrActions.ts` contribution registry: click → fetch the MR head ref (`merge-requests/N/head`, GitHub `pull/N/head`; the same button shows on gh-pr's PR rows; for `axn-workflow start <wf> <mr>` a bare `#N` means a GitHub PR and `!N` a GitLab MR unless the checkout is on GitHub — `reviewFetchRef`), `git worktree add` at the worktrees-plugin location (off the main checkout — a linked-worktree session is mapped back via `--git-common-dir`, `mainCheckoutOf`), `openSession` there, bind the workflow with the MR vars pre-filled. See `docs/dev-workflow.md`. A workflow can link a ticket tracker that is coarser than itself — `tickets: { source?: jira, var?: ticket, status-map: { <tracker status>: <entry state> } }` (`parseWorkflowTickets`; status names verbatim, matched case-insensitively). Each mapped state opens a range up to the next mapped entry state, so one status covers several local states (`ticketRange`); unmapped statuses fall back to the status category (`new` → start, `done` → last state, `indeterminate` → everything between). The status is read from a card enricher's namespaced fields (`<source>.status`/`.statusCategory`), so dev-workflow never imports the tracker; kanban cards (`TicketCardInfo`) show the enricher chips plus a `drift` badge when the session's state lies outside the ticket's range (`ticketDrift`) — informational only, nothing is moved on either side. With a `query` (JQL for jira), the board also lists the tickets no instance of the workflow is bound to yet (`backlogTickets`) as dashed backlog cards in their status's entry state. Queries go through **ticket sources** (`session-plugins/ticketSources.ts` — `registerTicketSource({ id, enabled, search(query) })`, the jira plugin registers one over `POST /rest/api/3/search/jql`, ≤50 results), a shared cache polled every 2 min while the board is open (`useTicketLists`). A card's Start (`startTicket`) picks a main checkout (repo-dir providers + the forge plugins' `repo-roots` + open sessions' repos), reuses or creates `<parent>/worktrees/<repo>-<KEY>` on `wt/<KEY>` off `origin/HEAD` (`ticketWorktreeScript`), opens a session there and stages the binding with `<var>`/`<var>_summary`/`<var>_url` filled, entering at the ticket's entry state (`pendingReviews` carries an optional start state).
- The built-in `agents` plugin (`session-plugins/agents.tsx`, on by default — `agents.enabled: false` disables only the UI) owns **agent personas**: reusable `agents.personas.<name>` bundles in plugins.yaml (`cli` — defaults to the persona name, `model`, `args`, `prompt`/`prompt-file` — the first-message kickoff, `instructions`/`instructions-file` — the persistent identity, `description`; a bare string value is `cli` shorthand). On every ctx touch it mirrors the parsed list into the shared `agentRegistry.ts` module (the `mrActions.ts` contribution pattern — always in the bundle, so the schema stays available even when the plugin is disabled). Consumers: dev-workflow's `agent: <name>`/`{profile: <name>, …overrides}` step references (unresolved names degrade to `cli: <name>`). Launch lines are built by each CLI's registered **launcher** — `registerAgentLauncher` in `agentRegistry.ts`, built-in agent plugins register at module scope, `devWorkflow.agentLaunchLine` consults the registry: claude sends instructions via `--append-system-prompt(-file)`, codex via `-c developer_instructions=…`, devin and unregistered CLIs fold them into the seed prompt, and agy — which only accepts prompts via `-p`/`-i`/stdin — sends the seed through `-i` with instructions folded in (registered under both `agy` and `antigravity`). A launcher's refusal surfaces as session attention. Launch surfaces: `axn-agent <persona>` types the launch line in the current shell (`completeArg` offers persona names), the session and workspace context menus' single "New session with agent…" row opens a searchable persona picker (`pickFromList`, see below) and spawns a persona-named session seeded with the launch line (pending map → `onSessionOpen`, like worktrees; workspace rows use `defaultFolder` as cwd), and the rail bot icon opens a full-area view of persona cards (cli/model/prompt badges, live-session count, Launch button + a "running" session list grouped by workspace in panel order — a non-collapsible tree, so every agent shows where it lives). A launched/typed persona stamps `pluginState.agents.persona`, which drives the bot badge (`agents.persona` field) — the persona survives as the session's identity beyond process detection.
- `session.process` is the foreground process identity: the process-group leader's argv resolved by `process_identity` (`src-tauri/src/lib.rs`) — exact argv tokens from `/proc/<pid>/cmdline` on Linux and `sysctl(KERN_PROCARGS2)` on macOS (comm via `proc_name` when another user's process refuses it), so paths with spaces stay one token; the cwd poll reads `/proc/<pid>/cwd` / `proc_pidinfo(PROC_PIDVNODEPATHINFO)` — the 1 s per-terminal polls never spawn `ps`/`lsof` — argv0 basename, except interpreter launches unwrap to the script (`python3.13 /x/bin/vibe` → `vibe`, `node cli.js` → `cli`, `python -m pkg` → the module). `sessionIcons` keys match this name (lowercased), so script-based tools (uv/pipx CLIs, npm shims) get icons and `processPattern` matches too.
- The `docker` plugin (`session-plugins/docker.tsx`) is a rail-only indicator: the Docker whale SVG icon, running/stopped container counts, and one rounded `BarStrip` triple bar — CPU / MEM / disk strips stacked under a single border, each strip filled with `pressureColor` and its percentage written into the bar (the label renders twice, once in track color and once in `--text-inverted` clipped to the fill, so glyphs flip color where the fill passes under them; per-strip `data-tip` carries the details). CPU and MEM strips show real **VM** pressure when possible — the probe `docker exec`s a read-only /proc snapshot inside the first running container (proc is not cgroup-namespaced, so cpuinfo/meminfo/stat report the VM kernel's numbers on colima/Desktop/podman-machine, host numbers on native Linux; CPU% is the /proc/stat jiffie delta between polls, MEM is MemAvailable-based); container `docker stats` sums are the fallback and stay in the tooltips. Disk likewise prefers `docker exec <cid> df -k /` (the VM's root fs — `df` of the host's `/` reported the macOS disk before). Two `sh -c` probes run via `backend.exec` on separate cadences: the fast per-poll `DOCKER_STATS_CMD` (`docker info` gate, `docker ps -a --format '{{.State}}'` counts, `docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}'` container sums, `docker info --format '{{json .}}'` limits — docker `NCPU`/`MemTotal`, podman `host.cpus`/`host.memTotal` — and the `==vm==` container exec; each failed section prints `unavailable` and degrades to fallbacks) parsed by `parseDockerLive`, and the slow `DOCKER_DISK_CMD` (`docker system df --format '{{.Size}}'` + the df above, `DockerRootDir`/`Store.GraphRoot` host-side fallback) parsed by `parseDockerDisk` — `system df` walks every layer and takes seconds, so it runs only every `DISK_POLL_EVERY` (4) polls (~1 min at the default cadence) and keeps its last values on failure. The rail is session-less: desktop `plugin_exec` ignores the session id, web execs through the first session's host — the plugin hides when docker or exec is unavailable. `docker.refresh-interval-seconds` (default 15, min 5) sets the fast poll cadence; neither probe ever overlaps itself. ≥80/≥90 % disk or memory use raises a warning/critical app attention flag.
- The `axn-dev` plugin (`session-plugins/axnDev.tsx`, Boxes rail icon) is a read-only mirror of `axn-dev list`: a shared `useSyncExternalStore` overview polls `axn-dev list` via `appRuntime().exec` on a `axn-dev.refresh-interval-seconds` cadence (default 30, min 10), parsed by the pure `parseAxnDevList` (global section at indent 2, project sections under `  <repo>:` headers at indent 4, endpoint lines and wrapped descriptions one level deeper — told apart by a URL-ish second token). The rail shows `running/found` (warning triangle when the CLI fails); clicking toggles the plugin view, which lists sections like `axn-dev list` — status dot, name, worktree badge, description, and clickable endpoint links for running scenarios — plus a persisted "running only" filter (`pluginData['axn-dev'].runningOnly`). No start/stop actions; `axn-dev serve` remains the full dashboard. It is also a repo-dir provider (`repoDirs`, below): `axn-dev git repos --json` (axn-dev ≥ the `git repos` command; older CLIs contribute nothing). The older external `plugins/axn-dev-scenarios.mjs` (opt-in, per-session row) is unaffected — different plugin id.
- The built-in `worktrees` plugin (`session-plugins/worktrees.tsx`, opt-in `worktrees.enabled: true`) offers agent worktree isolation without any `axn-dev` dependency — plain `git` argv via `ctx.exec`. `git worktree add <dir> -b wt/<slug>` creates `<repo-parent>/worktrees/<repo>-wt-<slug>` (the axn-dev sibling-worktrees convention, so the CLI discovers them via `git worktree list`; `worktrees.worktree-root` overrides the parent), then `ctx.openSession(dir, slug)` spawns the session there — worktree-first, never a moved running shell. Entry points: session context menu ("New worktree session" / "New worktree with <agent>"), workspace context menu (when `defaultFolder` resolves to a repo), and `axn-worktree [name]`. The new session's `pluginState.worktree = { repoRoot, path, branch }` (stamped on `onSessionOpen` from a pending map, or detected once when a session opens inside a foreign-created linked worktree — e.g. dev-workflow's MR review) drives a `⎇` row badge, "Review worktree changes" (git tab at the path) and "Remove worktree" — `git worktree remove` refuses dirty trees, so failure re-raises the banner with a "Force remove" action, and success offers "Delete branch". The isolation nudge: when `session.process` matches `worktrees.agents` (default `claude, devin, codex, agy, vibe`) in a main checkout (`git-dir == git-common-dir`, probed once per session), a warning banner offers "New worktree session" (seeds the agent's resume command — `claude -c`, `devin -c`, `codex resume --last`, `agy -c`, `vibe -r`), with once-per-session re-raise and a persistent "Don't ask again" (`worktrees.suggest-isolation` gates it). `worktrees.default-agent` picks the seeded agent.
- The built-in `scratchpad` plugin (`session-plugins/scratchpad.tsx`, opt-in — `scratchpad.enabled: true` plus the `scratchpad.patterns` setting, which has no default: `;`- or newline-separated `<repo-regex>: <dir>, <dir>` entries, e.g. `*: .local-drafts, drafts; axn-term: .ai, notes`; an entry without a repo part applies to all repos). The regex matches case-insensitively against the checkout dir basename AND the remote repo name, so one entry covers a repo and all its worktrees (`axn-term` also matches `axn-term-feat-foo`). Matching dirs union in order; the first *existing* dir is `primary` (else the first configured). Its in-panel surface is the session context menu only: one `Open <dir>/` row per configured folder (read from `pluginState.dirs` — sessionMenuItems is synchronous, so `onSessionOpen` and a debounced onOutput refresh resolve+store the dirs — falling back to a single "Open drafts" row before the first resolution), plus "New or open draft…" (`pickOrCreate`), "Copy agent hint" and "Tell agent about scratchpad". Drafts are plain files — agents read/write them with their own tools (filesystem-as-context), the plugin only has to say where they are: `axn-scratch ls|dir` echoes real paths into the scrollback, `axn-scratch hint` prints a paste-able AGENTS.md/CLAUDE.md hint, "Copy agent hint" puts it on the clipboard and "Tell agent about scratchpad" (offered when `agentInput` or an agent-ish process is foreground) types it into the session input *without* a newline. Creating a draft (`axn-scratch new <name>` or a bare name) mkdirs the primary dir, seeds a `*` `.gitignore` (self-ignoring folder — `scratchpad.gitignore-drafts` gates it) and opens the file in an editor tab; `axn-scratch open <name|n>` and bare names open existing drafts, `browse` opens the folder. Beyond the menu there is a `NotebookPen` rail icon opening the `hostsTabs` full-area view: drafts grouped by repo across all sessions, per-repo "copy hint" buttons, editor/browser hosted tabs (listings go through `PluginApi.listDir`, which resolves `null` where the backend lacks `listDir`).
- The built-in `progress` plugin (`session-plugins/progress.ts`) scans the session's live screen (`ctx.getScreenLines()`, backed by the xterm registry in `terminalRegistry.ts`) for progress indicators (`45%`, `[###---]`, `3/10`) instead of guessing from the output stream. When several bars are on screen the bottom-most one is reported; an indicator must persist ~500 ms before it is shown, and `session.progress` is withdrawn once no bar remains on screen. Only allowlisted programs are tracked: `progress.include-processes` in `plugins.yaml` (exact, case-insensitive process names; `'*'` tracks every program) — unset, it defaults to `DEFAULT_INCLUDED_PROCESSES` (curl/wget/rsync/pv/dd, pacman/apt/dnf/pip/uv/cargo/npm/pnpm/yarn/bun, git, ffmpeg), so percent-like noise from anything else (brew, build logs) never becomes a bar. Exclude programs on top via `progress.exclude-processes: [docker]` (case-insensitive substring match on the foreground process). A built-in list (`BUILTIN_EXCLUDED_PROCESSES`) already covers full-screen monitors/pagers/editors (`top`, `htop`, `vim`, `less`, …) and matches the comm basename exactly.

## Restore verification

- Desktop unit tests: `pnpm --filter @axn-term/desktop test`.
- Typecheck: `pnpm exec tsc --noEmit` from `apps/desktop`.
- Build the embedded production frontend with `pnpm --filter @axn-term/desktop tauri build --bundles deb`; plain `cargo build --release` can still point at Vite's dev URL.
- Run a desktop restore flow with `axn-dev flow -f flows/axn-term-restore-second-workspace.xml --adapter axn-term=flows/adapters/axn-term.js`. Flows use isolated temporary state; an explicitly provided state directory must not already exist.
- Flows drive the app through its remote-control HTTP server (`AXN_TERM_REMOTE_CONTROL_PORT`). It only starts together with `AXN_TERM_REMOTE_CONTROL_TOKEN` (removed from the app's env, so PTYs never inherit it): every endpoint but `GET /health` requires `Authorization: Bearer <token>`, and requests whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>` are rejected (DNS-rebinding guard). The adapter generates a token per run. The per-session output buffer behind `GET /sessions/<id>` (last ~200 KB) is only kept while the server is enabled.
- The talk-tab resume flow is `flows/axn-term-talk-restore.xml` (seeded `agent` shell tab → `/exit` capture → `devin -r <name>` on reopen; plus the `devin -c` fallback when the app is killed mid-session).
- The worktrees-plugin flow is `flows/axn-term-worktrees.xml` (temp git repo + `worktrees.enabled`; `POST /sessions/<id>/command` submits `axn-worktree <name>` through the frontend dispatch — unlike raw `/write` — then a fake `devin` launch in the main checkout must raise the isolation banner). Like the other flows it runs `target/release/axn-term` from `tauri build` — a plain `cargo build`/`cargo test` binary loads the Vite dev URL, so without `pnpm dev` no frontend starts and no session ever appears.
- The file-drop flow is `flows/axn-term-drop-image.xml` (Linux): `startTestDisplay` runs a private X server (Xvfb, else rootful Xwayland) with a GTK drag source, `start` then launches the app there, and `flows/adapters/x11drive.py` performs a real XDND drag with XTEST — a synthetic DOM drop cannot reproduce the webview opening the file. It checks a drop beside the terminal types nothing and leaves the app loaded, a drop on the terminal pastes the image's quoted path (`wc -c ` + drop + Enter must count its bytes), and the window still closes from its close button. Variant `shell` is a plain shell session for flows that type into the terminal. On NVIDIA + Wayland the app needs `WEBKIT_DISABLE_DMABUF_RENDERER=1` in the flow's environment (Gdk "Error 71" otherwise); the test display sets it itself.
- On macOS the bare `target/release/axn-term` binary cannot host WKWebView (the web content process dies at window creation); the adapter automatically prefers `target/release/bundle/macos/axn-term.app/Contents/MacOS/axn-term` next to `AXN_TERM_BINARY`, so run `tauri build --bundles app` once after frontend changes.
- The flow adapter writes a `$SHELL` shim (`bin/axn-login-shell`) into the state dir: command sub-shells run `sh -c` with `login_shell_path()` — the login-shell PATH, not the app's env PATH — so the fake `devin` would be invisible without it. The shim answers the `-l -i -c env` probe with the flow bin dir prepended and (for zsh) routes startup through a proxy `ZDOTDIR` that re-sources the user's real dotfiles then re-prepends the bin dir, keeping the fake binaries first even after profiles rebuild PATH.
- Run the real flow with `AXN_TERM_DEVIN_SESSION=<available-session> axn-dev flow -f flows/axn-term-restore-real-devin.xml --adapter axn-term=flows/adapters/axn-term.js`. The adapter verifies the exact configured name before reopening. Do not remove locks or close unrelated Devin instances to run it.
- Devin CLI v3000.10.27 treats a combined `/exit\r` write as pasted multiline input rather than submission. Type `/exit`, allow the input to settle, and send `\r` separately. A shell-script stand-in does not reproduce this input behavior.
- Devin name capture: an authoritative capture is armed immediately before the separate Enter submits `/exit` (or by `onClose`'s Ctrl-C×2) and consumes only subsequent output chunks. For exits the plugin did not drive (manual Ctrl-C×2, `/quit`), `onProcessEnd` instead parses the newest resume line out of a bounded 16 KB output *tail* and arms a short passive capture for chunks still in flight — a passive capture adopts a seen name but never erases a stored one. Never use a scrollback length/offset as a capture cursor: scrollback is capped at 200,000 characters.
- Devin CLI ≥3000.11 prints the exit resume hint on two lines (` devin -r <name>` then ` resumes this session · devin -r lists recent sessions`); older versions print `Resume this session with \`devin -r <name>\`` on one line. `findDevinSessionName` matches both.
- OS session teardown (logout/restart/shutdown → SIGTERM/SIGHUP) is flagged via `signal-hook` and emitted as `os-shutdown`; the frontend runs the normal collect-and-close path without the confirm modal. A 15 s watchdog exits anyway if the frontend never finishes, so shutdown is never stalled. App-level quit (Cmd+Q / menu Quit / `app.exit`) arrives in Rust as `RunEvent::ExitRequested` while windows still exist — it is *not* routed through per-window `CloseRequested` — so the run handler intercepts it with `prevent_exit`, emits the same `os-shutdown`, and arms the same 15 s watchdog; each window then flushes state and `destroy()`s itself, and the resulting last-window-closed `ExitRequested` (window map empty) is allowed to proceed.
- Window-close semantics (`CloseConfirmModal` in `ShellApp`): with one window, closing saves its sessions as before. With other windows open (`otherWindowWorkspaces` non-empty — peers announcements, not a Rust query) the modal is a choice: "Close this window" runs `removeAndClose`, which kills every session PTY in the window (`backend.close` per session — sub-shell trees die with their parent; `destroy()` runs no React teardown so nothing else would release them), deletes the window's `state.json` entry, then destroys the window — the sessions end for good and are not restored. "Close all & save" broadcasts `close-now` over `peers` so every window runs its own collect+save+destroy path (the remote-control `POST /close` uses the same event) — the 10 s countdown and Enter default to it; Escape/Cancel keeps everything open. `closeNow` also kills the window's PTYs after the save (`killWindowSessions`) — saved sessions restore with fresh PTYs anyway — and the session-exit/sub-shell-exit handlers ignore exits while `closingRef` is set, so teardown kills can't mutate or re-save state.
- No child outlives the process: `RunEvent::Exit`, the exit/shutdown watchdogs and the remote `/close` force-exit all call `pty::kill_all_sessions` — SIGHUP, SIGKILL after `CLOSE_GRACE` — because `std::process::exit` skips destructors and a webview `destroy()` never releases PTY leases. `RunEvent::Exit` also `stop_vite`s the axn-term-hmr dev server. On a hard crash (SIGKILL, segfault) the kernel closes the PTY master fds, which SIGHUPs each session's controlling-terminal group — the OS-level guarantee that needs no code in the dying parent.

## macOS Local Network permission & code signing

Since macOS 15 the Local Network privacy filter blocks spawned shells from
reaching LAN peers (gateway works, everything else is `No route to host`)
unless the *responsible app* — axn-term itself — is granted
*System Settings → Privacy & Security → Local Network*. Two things make the
grant stick:

- `src-tauri/Info.plist` declares `NSLocalNetworkUsageDescription` (and
  `NSBonjourServices`); without the usage-description key macOS denies
  silently — no prompt, dead connections.
- The app must carry a **stable code signature**: TCC tracks identity via the
  signature and adhoc builds change their cdhash on every rebuild, so an
  enabled toggle silently stops matching. `bundle.macOS.signingIdentity` in
  `tauri.conf.json` points at `axn-term Code Signing`, a self-signed
  code-signing certificate (EKU `codeSigning`) in the login keychain, trusted
  via `security add-trusted-cert -p codeSign`. On a machine without that
  cert the build falls back to needing `APPLE_SIGNING_IDENTITY`/a
  Developer-ID identity — or re-sign the installed `.app` by hand:
  `codesign --force --deep --sign "axn-term Code Signing" /Applications/axn-term.app`.
  `tauri dev` binaries keep an adhoc linker signature, so dev-mode sessions
  may still lack LAN access — sign `target/debug/axn-term` the same way to
  fix a dev instance.

Full details + the Developer-ID/notarization publishing roadmap:
`docs/macos-packaging.md`.

## Packaging on Arch

`tauri build --bundles deb`, then repackage via `/tmp/axn-pkg/PKGBUILD` (`ar x` + `bsdtar -xf data.tar.gz -C "$pkgdir"`). Install with `sudo pacman -U /tmp/axn-pkg/axn-term-*.pkg.tar.zst`.

## Merge request workflow

Do not push directly to `develop` or `main`. Always create a feature branch, push the branch, open a merge request, and stop for the user to review. Do not auto-merge merge requests; wait for the user to merge after review.onventions for axn-term

## Apps and shared libraries

- `apps/desktop` — Tauri desktop app; binds the shared UI to `tauriBackend` /
  `tauriServices` from `@axn-term/session-backend/tauri`. A dev variant,
  **axn-term-hmr** (`pnpm build:hmr` → `tauri build -c
  src-tauri/tauri.term-hmr.conf.json`, product/binary `axn-term-hmr`, or
  `AXN_TERM_HMR=1` for the same code path under `tauri dev`), spawns
  `pnpm exec vite` inside a user-picked checkout/worktree and loads its
  session windows from that server (`WebviewUrl::External`, capabilities
  `remote.urls` `http://localhost:*`/`127.0.0.1:*`, navigation allowlist in
  `window.rs::is_dev_hmr_navigation`) — frontend edits hot-reload in the
  real app while the PTY/Rust side stays whatever the dev binary was built
  with. `devhmr.rs` owns the spawn/state/commands and the `#axn-dev`
  settings window (`apps/desktop/src/app/DevHmr.tsx`): repo picker, vite
  status/log, start/stop/install. In dev mode `state_dir()` is
  `~/.axn-term-hmr` and `save/load/delete_window_state` go through the
  in-memory `AppState.mem_shell_state` — no `state.json` is ever written,
  but a page reload still finds its state. The bundle carries its own
  yellow icon set (`src-tauri/icons-hmr/`, the glyph plated on
  `rgb(227 179 65)`, listed under `bundle.icon` in the hmr conf;
  `build/scripts/make-macos-icon.sh hmr` regenerates it), so the dev
  build is unmistakable next to a real axn-term.
- `apps/web` — browser/online app; binds the same shared UI to `WsBackend`
  (gateway `/ws` protocol: raw PTY frames + JSON `resize`, `fs-read`,
  `fs-write`, `fs-stat`, `fs-list`, `fs-mkdir`, `cwd`, `exec`, `fg-process`,
  `session`) and `browserServices`. `fg-process` reports the terminal's
  foreground pgrp leader comm (session host reads `/proc/<pid>/stat` tpgid →
  `/proc/<tpgid>/comm`, `null` while the shell itself is foreground).
  The session host closes `/ws` with code `4001` (`pty-exited`) when the
  shell exits and the gateway forwards close codes unchanged; `WsBackend`
  treats only `4001` as a session exit (`PTY_EXITED_CLOSE_CODE`). Any other
  close (network drop, gateway restart) keeps the session and prints a
  "connection lost" notice into its terminal — there is no auto-reconnect yet.
- `libs/session-backend` — the `SessionBackend` port (create/write/resize/
  output/close, optional `readFile`/`writeFile`/`statPath`/`getCwd`/
  `getTty`/`getForegroundProcess`/`getDefaultShell` — `getTty` reports the
  session PTY's controlling terminal so plugins can correlate tty-keyed
  out-of-band events like agent hooks; desktop-only) plus `ShellServices`
  (clipboard — `copyText` + optional `copyImage` RGBA pixels → desktop:
  `clipboard_write_image` arboard command, web: PNG `ClipboardItem` —,
  open-external, reveal, open-directory, optional `notify` —
  desktop: `tauri-plugin-notification`, web: Web `Notification`) plus an
  optional key-value `storage`
  (get/set — desktop: `kv_get`/`kv_set` Tauri commands over
  `~/.axn-term/kv.json`, web: `localStorage` under `axn-kv:`) and `FileReader`.
  Desktop file ops go through `tauri-plugin-fs` scoped to `$HOME` (see
  `src-tauri/capabilities/default.json`); tauri.conf.json sets
  `plugins.fs.requireLiteralLeadingDot: false` because the Unix default
  (`true`) makes `*`/`**` never match dot components — `.env`, `~/.config`,
  `~/.axn-term` would all be `forbidden path` errors for `axn-edit`/
  `axn-browse`/`axn-preview` and friends. Paths outside `$HOME` (e.g. repos
  on an external volume) are granted at runtime from the `fileAccessRoots`
  list in `config.yaml` — desktop `App.tsx` passes it to the
  `allow_file_roots` command, which widens the fs scope; grants are
  additive, so a removed root stays allowed until restart.
  Web-capability gaps
  are expressed as absent optional methods — don't stub them with no-ops.
- `@axn-term/session-backend/remote` — `RemoteBackend`, a `SessionBackend` over
  the Ramphastos hub (`/ramphastos` on session-host, proxied raw-WS by the
  gateway): one multiplexed connection; `createSession`/`createSubshell` map to
  `createPty` commands, PTY IO rides server-announced `pty:<id>` duplex streams,
  fs/exec/cwd/fg/tty map to VM commands. Kept behind a subpath export so the
  desktop build doesn't need the ramphastos-client dependency. Selected in
  `apps/web` via `VITE_RAMPHASTOS_URL` (absent → `WsBackend`). Client dep is
  the published `ramphastos-client` npm package (unscoped name), and the .NET
  apps consume the published `Ramphastos.*` NuGet packages — sibling-checkout
  builds are opt-in via `RAMPHASTOS_LOCAL_DEPS=1`: MSBuild swaps the package
  refs for ProjectReferences into `../ramphastos` (root overridable
  via `RamphastosLocalDepsRoot`), the vite/vitest configs alias
  `ramphastos-client` to the sibling (mounted at `/ramphastos` in containers,
  `AXN_LIBS_ROOT` points the docker `libraries` context at it), and the node
  e2e scripts take `RAMPHASTOS_CLIENT_DIST`; rebuild the client package's
  `dist/` when its sources change. End-to-end: `tests/ramphastos-e2e.mjs` (raw protocol)
  and `tests/remote-backend-e2e.mjs` (backend surface; run with
  `node --experimental-strip-types`), both against a locally running
  session-host (`SESSION_HOST_PORT=7682 dotnet run --project apps/session-host`).
- `libs/shell-ui` — protocol-agnostic UI: `SearchPickerModal` (the shared
  searchable list picker — grouped, disabled/badged rows, optional create
  row; behind "Move to workspace…", and behind `pickFromList()` from
  `app/pickerHost.tsx`, which in-process plugins await from a menu row to
  pick a persona/workflow — `PickerHost` is mounted once in `ShellApp`),
  `ShellTerminal`, `ContextMenu`
  (shared fixed-position popup portalled into `document.body` — so the
  panel's CSS `zoom` and ancestor overflow cannot offset or clip it —
  placed by `placeMenu`: opens at the click, flips up/left near the
  bottom/right window edge, clamps otherwise, re-placed via ResizeObserver
  when its content grows, capped to the window height with scrolling;
  outside-mousedown/Escape dismissal, optional `className` for the surface,
  `menuItemClass`/`menuDividerClass` row styles — the shell every right-click
  menu in the app wraps its items in, including the workspace, session and
  tab menus; any right-click no view handles itself opens `AppContextMenu`
  instead of the webview's native menu — Copy/Paste/Select all for the
  terminal under the pointer (`terminalAt`, `registerTerminalElement` in
  `terminalRegistry.ts`; paste goes through `term.paste`; Copy reads
  `terminalSelection` — xterm's live selection, else the user's last one,
  forgotten on a left click or typing — and terminals honour OSC 52 clipboard
  writes via `handleClipboardWrites`, because TUIs with their own mouse
  selection such as Claude Code copy that way and leave xterm with no
  selection; reads (`?`) are refused), Cut/Copy/Paste/
  Select all for text fields, plus "Reload window" (also `⌘⇧R`/`Ctrl+Shift+R`,
  `isReloadShortcut` — terminals let it through; it saves state first and,
  running no React cleanup, keeps the PTYs, which the reloaded window
  reattaches; every live terminal's serialized screen is stashed in
  sessionStorage first (`stashTerminalReplays`, `takeReloadReplay` in
  `terminalRegistry.ts`), so the reloaded window repaints scrollback and
  the alt screen of a running TUI instead of coming back blank —
  sessionStorage dies with the app session, same as the PTYs, so a fresh
  start never replays a dead terminal)), `PathActionMenu` /
  `FileHoverPreview`, themes, `SettingsProvider`, session types, terminal
  links/registry, platform labels. Tooltips are the shared `TooltipHost`
  (`app/Tooltip.tsx`, mounted once in `ShellApp`): put `data-tip="..."` on an
  element — never the native `title` attribute — and the host renders a
  fixed, viewport-clamped bubble on hover/focus. Disabled controls swallow
  pointer events, so put `data-tip` on a wrapper when the control may be
  disabled (`IconButton` does this internally). Components must never import
  Tauri APIs directly; everything platform-specific goes through the
  backend/services seam (desktop-only actions like Reveal simply disappear
  when the service is absent). Errors are contained by `ErrorBoundary`
  (`app/ErrorBoundary.tsx`): one per session sub-view tab (error panel with
  Reload view / Close tab) and a root one in `ShellApp` (Reload window —
  a page reload runs no React cleanup, so PTYs survive and reattach).
  Terminal unmount cleanups (`ShellTerminal`, `SubShellView`) wrap every
  teardown step in `safely()` (`terminalRenderer.ts`) and dispose the
  renderer addon before the xterm — an exception escaping an effect
  cleanup would otherwise blank the whole window.

## Repository vs. application name

- Repository / directory name: `axn-term`
- Shipped application name: `axn-term`
- macOS bundle identifier: `dev.axn-term.axn-term`

## State and config location

Application state is stored under the user's home directory:

- Linux/macOS: `~/.axn-term/`
  - `state.json` — persisted windows, workspaces, sessions, and selections.
    Structural changes (session/workspace add, close, rename, move, reorder,
    tab open/close, plugin data) call `saveNow` eagerly; runtime churn
    (status/progress/tasks/output, `pluginState`) stays on the ~2s dirty
    flush. Saves are serialized through `saveChainRef` so bursts never write
    `state.json.tmp` concurrently.
  - `state.json.bak` — backup of the last previously valid `state.json`, rotated on each successful save (writes go through `state.json.tmp` + rename, so a failed save never clobbers the good state)
  - `state.json.failed` — a `state.json` that could not be parsed is quarantined here for diagnosis (`.failed.1`, `.failed.2`, … when the name is taken — an earlier quarantined file is never overwritten); on startup the backup is loaded instead and the window state carries `restoredFromBackup`/`failedStateFile` markers (stripped again on save) so the frontend can show a banner. Any other read error (EMFILE, permissions) is not corruption: load/save/delete return the error and write nothing, so a save never merges into empty or older state
  - `sessions.json` — legacy single-window state (migrated into `state.json` on first read)
  - `kv.json` — generic key-value store behind `services.storage` (e.g. agent
    review explanations); desktop only, web uses `localStorage`. A missing
    file is an empty store; an unparseable one is quarantined as
    `kv.json.failed[.<n>]`; any other read error fails `kv_get`/`kv_set`
    without writing
  - `themes/` — user themes: every `*.yaml`/`*.yml`/`*.json` file directly in
    it, in the same format as the built-in `libs/shell-ui/themes/*.yaml`
    (`id`, `name`, `mode`, `colors`, optional `ui`/`tagColors`). Desktop reads
    them with the `list_user_themes` command (files over 256 KB are skipped);
    `SettingsProvider`'s `loadUserThemes` polls the folder every 3 s and
    `setUserThemes` (`themes.ts`) merges them into the theme list — a user
    file with a built-in's `id` replaces that theme, a file that does not
    parse raises an `Invalid theme` app-attention flag. No rebuild needed;
    web has no themes folder.
  - `plugins.yaml` — per-plugin configuration (e.g. `devin.restore-session`)
    via `platform.pluginSettingsStore` → `PluginSettingsProvider` (desktop:
    `read_plugins`/`write_plugins` Tauri commands). Like config.yaml, the
    desktop store polls `read_plugins` (~1.5 s `watch`) and live-reloads
    external edits — enable toggles and plugin config (e.g. dev-workflow
    workflow definitions) apply without a restart; the provider skips its
    own write echo and never writes back, so user formatting survives;
    invalid YAML keeps the last valid settings and raises an `Invalid
    plugin settings` app-attention flag; while the file on disk is invalid,
    UI changes stay in memory and are not written back (same for
    config.yaml). External `.mjs` plugin *files* are still startup-only. Web has
    no `watch` (localStorage is app-owned).
  - `config.yaml` — app settings (theme, fonts, `sessionIcons`,
    `terminalRenderer`: `auto` (WebGL → canvas → DOM fallback, incl. WebGL
    context loss) / `webgl` / `canvas` / `dom` — applied by
    `terminalRenderer.ts` to ShellTerminal and SubShellView terminals, and
    hot-swapped on the live terminal when the setting changes since
    recreating the PTY would kill the session, …) via
    `platform.configStore` → `SettingsProvider` (desktop: `read_config`/
    `write_config` Tauri commands over `~/.axn-term/config.yaml` — same seam
    as `state.json`/`plugins.yaml`, no fs-plugin permissions needed); on
    first desktop launch a legacy webview-localStorage blob is migrated into
    the file and removed. The desktop `configStore.watch` polls `read_config`
    (~1.5 s) and live-reloads external edits — the provider skips its own
    write echo and suppresses the write-back so user formatting/comments
    survive; an invalid file raises an `Invalid settings` app-attention flag
    (orange warning; clicking it opens the Settings modal) and keeps the
    last valid settings.
    Web has no `configStore` and keeps `localStorage` (`axn-term:settings`).
    Settings → General → "Config file" offers Import/Export through
    `platform.configFileStorage` (desktop: native dialogs, web: download +
    file input).

Remote publishing (Settings → Remote): `remoteAuthorityUrl` (+ optional
`remoteAuthoritySession`/`remoteAuthorityToken`) mirrors this window's PTYs
onto a `/remote` hub via `RemoteAuthority`; `platform.remoteAuthorityStatus`
exposes idle/connecting/connected/failed for the status line. Account
sign-in is OIDC **device flow** (`apps/desktop/src/app/remoteAuth.ts`):
`remoteAuthIssuer` + `remoteAuthClientId` settings, browser-side
authorization, the refresh token lives in the OS keychain via the
`secure_get`/`secure_set` Tauri commands (keyring crate — macOS Keychain,
Windows CM, Linux Secret Service), access tokens are refreshed in memory by
`getAccessToken()`. `platform.remoteAuth` exposes
state/subscribe/signIn/signOut/getAccessToken; the signed-in JWT wins over
the static `remoteAuthorityToken` dev fallback and a sign-in flip restarts
the authority so its hello carries the token. The gateway binds the
mirrored session to the JWT `sub` — viewers must authenticate as the same
account; `RemoteAuthority__AllowAnonymous=true` bypasses this for dev
(off by default). Hello tokens must come from an allowed OIDC client
(`azp`): `RemoteAuthority__ClientIds` (comma list), unset =
`Authentication:ClientId` plus the desktop's `axn-term-desktop`.

Session plugins can declare per-session state, which is stored inside `state.json`
under `sessions[].pluginState.<plugin-id>`. Plugin lifecycle hooks (`onOutput`,
`onSessionOpen`, `onClose`, `onCommand`) receive a `pluginState`/`updatePluginState`
API and a `writeToSession` helper for sending input to the session PTY.
`onCommand` can observe/intercept a submitted input line and replace or
swallow it (the devin plugin uses it to arm its `/exit` capture and to
invalidate the remembered session when the user launches `devin -r <name>`
manually). Handlers may return a Promise; the replacement line is written
once it resolves. The outcome of a hidden-command line follows one
procedure (`applySessionCommandResult` in `app/hiddenCommands.ts`): a
handler returning `undefined` submits the line to the shell unchanged;
`false` swallows it silently; a plain string replaces the line and runs in
the shell (e.g. `devin -r <name>`); and the `echo "<msg>"` shape is the
feedback convention — a message for the user, not a command. With the
terminal's `writeDisplay` channel the typed line stays on screen and
`<msg>` is drawn below it like real command output (the `\x15` kill goes
to the PTY after the display write so the shell's line erase lands on the
empty line underneath); without it the `echo` is typed into the shell as
a fallback. The remote `axn-term session command` path (`controlReply` in
`app/controlCommands.ts`) parses the same `echo` shape back into the CLI's
reply text. Covered by the `command feedback (display channel)` cases in
`hiddenCommands.test.ts`.

Plugins can declare hidden commands via `commands?: (string | PluginCommand)[]`
— they join the built-in `axn-*` names for Tab completion. A plain string is
completion-only (handled via `onCommand`); a `PluginCommand` object
`{ name, run, takesArg?, argCompletion?, completeArg? }` owns the command: a
submitted line whose first word matches `name` is dispatched to
`run(ctx, arg, line)` before
any `onCommand` sees it. `run` may return a replacement command, `false` to
swallow, or a Promise thereof. `takesArg` appends a space on completion;
`argCompletion: 'workspace' | 'dir' | 'file'` gives built-in argument
completion, `completeArg(ctx, prefix)` a dynamic list of argument candidates
(workflow/state names for `axn-workflow-*`). `axn-devin-resume` (devin
plugin → `devin -r <remembered>`), `axn-worktree [name]` (worktrees plugin →
`git worktree add` + session, see below),
`axn-claude-resume` (claude plugin → `claude -c`),
`axn-codex-resume` (codex plugin → `codex resume --last`),

`axn-agy-resume` (antigravity plugin → `agy --conversation <id>` once the
exit hint was captured, else `agy -c`), `axn-awesome` (awesome

`axn-opencode-resume` (opencode plugin → `opencode -s <id>`/`opencode -c`), `axn-awesome` (awesome
list), `axn-git [ref]` (git-inspect plugin → opens the repo's `git` tab at the
session cwd's toplevel — with a ref argument the tab diffs merge-base vs
HEAD as a "Changes vs <ref>" section; echoes an error outside a repo) and
`axn-workflow status|start|set|move|run|stop` (dev-workflow plugin), `axn-agent
<persona>` (agents plugin → the persona's launch line) and
`axn-scratch`/`axn-draft` (scratchpad plugin → `ls|dir|new|open|browse|hint|tell`
— see below) are implemented this
way.

Every `PluginApi` ctx comes from one builder, `createPluginApi(session,
plugin, deps)` (`session-plugins/plugin.ts`): ShellApp's lifecycle dispatch
passes live lookups (`getLiveSession`, `getSessionCount`) and `onAttention`
(OS notification), the panel/card call sites pass snapshots — the
behaviour is otherwise identical, so the two can no longer drift.

Plugin ctx (`PluginApi`) also exposes `appState`/`updateAppState` — the
app-level counterpart of `pluginState`, backed by window state
`pluginData.<settingsKey>` and shared across sessions. That's how
`axn-awesome` reads/writes the bookmark list outside the plugin view.

Built-in hidden session/workspace commands (intercepted before plugins):

- `axn-session <subcommand>` — session management. `create` opens a new
  session (`axn-session create [path] [-w|--workspace <name>]
  [-n|--name <name>] [--background] [--summary <text>]`); the bare legacy
  spelling `axn-session [flags] [path]` is an implicit `create`. No
  argument or `.` starts it in the current session's cwd; an absolute or
  relative path starts it there (validated via `stat_path`, echoes an
  error otherwise). `-w`/`--workspace` targets a workspace by name —
  created when absent, like `axn-session-mv`; `-n`/`--name` names the
  session; `--background` opens it without selecting it or dismissing a
  covering plugin view (agents spawning sessions don't steal focus);
  `--summary` sets the new session's `summary` field.
  `axn-session set` mutates the *current* session:
  `axn-session set [--summary <text>] [--name|--title <name>]` — at least
  one flag required (usage error otherwise); an empty quoted value clears
  the field (same convention as bare `axn-rename`/`axn-session-summary`).
  Feedback echoes as command output (`renamed to '…'`/`name cleared`,
  `summary updated`/`summary cleared`). `axn-session select <name|id>`
  focuses another session ('go to session' — same as the broadcast tile
  button); `axn-session list` echoes every session in panel order, `*` on
  the one it ran in and the workspace in parens — the session-addressing
  counterpart of `axn-workspaces`, so agents can discover peers to message.
- `axn-session-mv <workspace>` — move the current session to another
  workspace, creating the workspace if it does not exist. The session
  context menu's "Move to workspace…" opens `MoveToWorkspaceModal`: every
  workspace of every open window, grouped by window ("This window", "Main
  window", "Window N" — numbered globally by window id, `windowPeers.ts`),
  searchable, with a "New workspace '<query>'" row. Windows exchange their
  workspace lists over `platform.peers` (desktop: Tauri app-wide events,
  `useWorkspaceDirectory`; absent on web). Picking another window's
  workspace hands the session over (`requestAdopt` → `axn:adopt-session`):
  the source keeps its PTYs alive (`keepPtyAlive` for the main shell and
  every sub-shell tab), the target `adoptSession`s the full record (tabs,
  pluginState, scrollback) and acks; only then the source drops the session
  — output is broadcast to every window, so the target's terminals simply
  reattach. No ack within 3 s → the move is undone and an error banner
  shows.
- `axn-session-window` — move the current session into a new window of its
  own (also "Move to new window" in the session context menu; hidden for a
  window's only session). Session rows also tear off Chrome-tab style
  (`app/sessionTearOff.ts`): a row dragged out of the window and dropped
  where no window takes it opens a new window for it, and a row dropped on
  another window's panel (or anywhere in that window) moves there — before
  the row it lands on, else appended to the selected workspace. All of it
  rides the adopt hand-over above (PTYs, tabs, plugin state, scrollback).
  Every cross-window hand-over (also "Move to workspace…") carries the
  terminals' history: the PTYs only stream new output, so the source
  serializes each xterm (`serializeTerminal` in `terminalRegistry.ts`,
  `@xterm/addon-serialize` — colors, modes and a TUI's alternate screen
  included) into the adopt request's `replay`, and the target's
  `ShellTerminal`/`SubShellView` write it (`takePendingReplay`) before any
  live output. The receiving window takes focus (`platform.window.focus`,
  capability `core:window:allow-set-focus`). A secondary window emptied that
  way while other windows remain deletes its saved state instead of being
  restored empty at the next launch — unless it holds per-window data
  (`pluginData`/`pluginTabs`); `main` and the last window always keep theirs.
  Mechanics: the new window is created through `create_window` with
  `options` (`boot` — the `encodeBootIntent` URL fragment `#axn-boot=…`,
  validated URL-safe by `boot_fragment` in `lib.rs`; `x`/`y`/`width`/
  `height` — the source window's size and, when known, the drop point;
  Wayland compositors place windows themselves). `platform.window.bootIntent`
  hands it to the new window, which boots *empty* (`useShellSessions`
  `startEmpty`: one workspace named after the source's, no default shell;
  only without saved state, so a reload is a normal restore), suspends the
  empty-window auto-close and repeats `axn:window-ready` until it adopted
  the session (20 s, then it closes again). The source waits for that
  announcement (`openTearOffWindow`) before sending the adopt request.
  Cross-window drops: the dragging window announces `axn:session-drag`/
  `axn:session-drag-end`; other windows accept the HTML5 drop while one is
  active (a window-level dragover/drop listener plus the panel's own
  handlers) and claim it with `axn:session-drop`, which the source turns
  into an adopt request with `beforeSessionId`. Whether the drag left the
  window comes from `createDragExitTracker` (a lone `dragleave` — no
  coordinates, which Wayland does not report outside the window); a
  `dropEffect: 'none'` dragend outside waits `TEAR_OFF_CLAIM_GRACE_MS` for a
  drop claim before opening a new window. Esc-cancelling a drag outside the
  window is indistinguishable from dropping there, so it tears off too.
- `axn-session-up` / `axn-session-down` — reorder the current session within
  its workspace.
- `axn-workspace-up` / `axn-workspace-down` — reorder the current workspace.
- `axn-sh [command|dir]` — open a sub-shell tab. No argument (or an argument
  that resolves to a directory, like `.` or `src`) opens an interactive shell
  in that directory — defaulting to the session's live cwd; any other argument
  runs `sh -c` as a one-shot command. Also available as "New sub-shell" on the
  session right-click menu.
- `axn-preview <path>` — open a read-only preview tab for the file. The first
  enabled preview plugin claiming the path renders it (image, svg, markdown,
  asciidoc, mermaid, text fallback); the tab is named after the file.
- `axn-rename [name]` — rename the current context. In a session shell it
  renames the session (no argument clears the override → back to the
  process-reported name, same as the reset icon in the context menu); in a
  sub-shell it renames only that tab (no argument restores the default label).
- `axn-session-summary [text]` — set the session's `summary` field — a
  short description rendered clamped to 3 lines under the session title in
  the panel (behind the `sessionSummaries` setting) and under the title on
  dev-workflow kanban cards; full text stays in the tooltip. Matching
  outer quotes are stripped, text is capped at 400 chars
  (`SESSION_SUMMARY_MAX` in `app/hiddenCommands.ts`), and no argument
  clears it. `axn-session set --summary <text>` is the equivalent spelling
  on the `axn-session` umbrella command (also reachable as
  `axn-term session set --summary …` over the control socket). Agents use
  it to keep the session's displayed description current. The session
  context menu's "Edit summary…" (`app/EditSessionSummaryModal.tsx`) edits
  the same field: a textarea sized to the session row's width so wraps
  match the panel, with a warning once the text runs past the three-line
  clamp (measured on a hidden mirror of the panel's summary element).
- `axn-install [args]` — runs `axn-term install <args>` in the shell (the
  running binary's path is resolved via `current_exe_path`, so it also works
  in dev builds where `axn-term` is not on PATH).
- `axn-focus [tab]` — bring a session view to the front: bare or `shell`
  selects the main terminal; otherwise the first sub-view tab matching a
  1-based index, kind (`git`, `editor`, `shell`, `preview`, `browser`),
  id prefix, or label/path basename. Selecting the tab also selects the
  session and dismisses a covering plugin view — workflow `command:`
  actions use it as an on-enter "switch the view" (e.g. `axn-focus` on a
  human-gate state).
- `axn-broadcast [-t|--to <session>] <line>` — write the line (with Enter)
  to every session in the broadcast set, or to a single named session with
  `-t`/`--to` (same id/exact-name/prefix resolution as `axn-broadcast-add`;
  the line goes verbatim — transport, not a message). The set is a
  per-window runtime set of session ids
  (`app/broadcastSet.ts`): `axn-broadcast-add [name]`/`axn-broadcast-rm
  [name]` mark/unmark (current session with no arg, else name or id —
  prefix match), `axn-broadcast-clear` empties it, `axn-broadcasts`
  lists it (`*` on the current session). The session context menu's
  "Add/Remove from broadcast" toggles the same set and marked rows show
  a radio badge (`useBroadcastMarked`). Fan-out is a plain
  `backend.write(ptyId, line + "\r")` per target — the same bytes path
  as typing, so agents can drive it too via
  `"$AXN_TERM_CLI" session command "axn-broadcast <line>"`. The deck's
  composer gates dangerous buffers through a confirm dialog
  (`app/broadcastDanger.ts`): built-in rules (rm -rf, dd/mkfs, reboot,
  git push --force/--delete, git reset --hard/clean -f, DROP/TRUNCATE/
  DELETE FROM, kubectl delete/drain, systemctl stop/disable, chmod -R,
  killall/pkill, fork bombs) plus user regexes from
  `broadcastDangerPatterns` in config.yaml — each is matched
  case-insensitively against every line of a multi-line buffer, invalid
  patterns are skipped with a console warning. The gate only fronts the
  interactive composer; the `axn-broadcast` command path writes
  directly.
- `axn-tell <session> <message>` — agent↔agent messaging over the same PTY
  input path: delivers `[axn-tell from "<sender>"] <message>` typed into
  the target (the sender name comes from the session, not the text, so it
  can't be spoofed). When the target's foreground is a shell (or the
  backend reports none) the envelope is prefixed `# ` — it lands in
  scrollback/history instead of failing as `command not found`; any other
  foreground gets the raw envelope since typed input is the only universal
  way into a running agent TUI. Discover peers with `axn-session list`;
  agents use `"$AXN_TERM_CLI" session command "axn-tell <name> <msg>"`.

The session-level dispatch behind it — built-ins, plugin-owned commands,
`onCommand` hooks, Tab completion, and the out-of-band entry points
(`PluginApi.runCommand`, remote-control lines, `axn-term session …`) — is
`useSessionCommands` (`app/useSessionCommands.ts`), fed by ShellApp. The
built-ins are the `BUILTIN_COMMANDS` registry in `app/builtinCommands.ts`
(one entry = name + `run` + optional `takesArg`/`completeArg` — the same
table drives dispatch and Tab-completion); the shared parsing, session/
workspace resolution and path-completion helpers sit in
`app/shellCommandSupport.ts`.

Input interception for all of this lives in `createHiddenCommandInput`
(`app/hiddenCommands.ts`) — a per-view line-buffer tracker shared by
`ShellTerminal` and `SubShellView`. It gates on a `mode()` callback
(`'full'` at a bare shell prompt, `'agent'` while a plugin declaring
`agentInput` matches the foreground process — only `/exit` is observed, for
the plugin's `onCommand` — `'off'` while any other foreground process owns
input), dispatches `axn-edit`/`axn-browse`/`axn-preview` and
Tab-completion locally, and forwards everything else to the session-level
`onSessionCommand`. Views may register an `onLocalCommand` hook that runs
first — `SubShellView` uses it so `axn-rename` renames the tab rather than
the session. `ShellApp` handlers take an optional `ptyId` so paths and cwd
resolve against the PTY the command was typed into (a sub-shell's live cwd
can differ from the session's stored cwd).

Sub-shell tabs (`editors[].kind === 'shell'` in `state.json`) are sibling PTYs
spawned via `create_subshell` (`src-tauri/src/lib.rs`), keyed by their own tab
id in the backend `sessions` map with `parent_id` linking them to the owning
session (closing a session kills its sub-shells). They emit `shell-output`
like normal sessions but exit via `subshell-exited` (carries the exit code);
the `SubShellView` (`app/SubShellView.tsx`) holds the output on exit — Enter
re-runs, Esc closes the tab. Sub-shell tabs persist across restarts and
re-spawn lazily on first activation (command tabs re-run their command).
Tabs hosting an agent conversation (git-inspect "talk" tabs) carry `agent`
and `resumeCommand`: once the tab has run, every later spawn — restart or
Enter re-run — runs `resumeCommand` instead of the seed `command` (`devin -r
<name>` once the exit-time resume hint was captured from the tab's own
output — plugin `onOutput` only sees the main PTY — else `devin -c` /
`claude -c`), so the conversation is continued rather than re-seeded.
`/exit` typed inside a sub-shell never reaches session-level dispatch — the
devin plugin's exit capture is bound to the session's main PTY. Instead the
tab captures its agent itself (`app/subShellAgents.ts`): the exit hint of
claude (`claude --resume <id>`) or devin (`devin -r <name>`) is parsed from
the tab's own output — a talk tab stores it as `resumeCommand`. Plain tabs
where the user starts an agent follow the sessions' running-at-close rule:
the 1 s foreground poll records `agentActive` (a fresh start forgets the
previous `agentResume`; an exit the app did not drive clears it), the exit
hint lands in `agentResume`, and `subShellSpawnCommand` resumes exactly that
conversation (fallback `claude -c`/`devin -c`) only when the agent was still
running when the app went away. On app close `runSubShellClosers` (awaited
in `ShellApp`'s collect-and-close path) sends each running agent the same
Ctrl-C pairs as the plugins' `onClose`, so the hint lands before the save.
The session context menu and a sub-shell tab's context menu offer "Copy path" —
the live working directory of that shell (`backend.getCwd` on the session's
`ptyIdOf` / the tab's PTY; it is the shell's cwd, so it works while a program
runs in the foreground; the recorded cwd is the fallback, and the row is
absent where the backend cannot read a cwd).
They carry an optional `label` override (right-click a tab → Rename…, or
`axn-rename` inside it) — an empty rename clears it back to the default
command/dir label. Sub-shells intercept the same `axn-*` commands as the
main terminal (gated on a 1 s `getForegroundProcess` poll of the sub-shell
PTY), so `axn-edit`/`axn-browse`/`axn-session`/plugin commands work inside
them too.

A sub-shell can be promoted to the session's main shell (right-click a
sub-shell tab → "Make main shell", planned by `app/subshellPromote.ts`): the
session keeps its id but gains `mainPtyId` = the sub-shell's PTY id — every
PTY-bound operation (`ptyIdOf(session)`: ShellTerminal binds/writes/polls,
plugin `writeToSession`/`getCwd`/`waitForSessionOutput`, `axn-*` cwd
resolution) targets it while names/pluginState/output stay on `id`. The
demoted main PTY becomes a `kind: 'shell'` tab in its place. The backend
decides `session-exited` vs `subshell-exited` by the live `parent_id` link,
updated via `set_subshell_parent` (promotion re-parents the demoted shell to
the promoted one). `create_session`/`create_subshell` reattach to a live PTY
under the requested id instead of respawning (create_session reports
`spawned=false`, so plugin `onSessionOpen` hooks do not fire), and
`terminalRegistry.keepPtyAlive` flags PTYs whose views unmount during the
swap. "Turn into workspace" on a session with sub-shells (session context
menu) detaches every sub-shell PTY and adopts it as a standalone session —
main shell first — in a new workspace named after the session. The context
menu's "Close session" runs every enabled plugin's `onClose` (devin's
graceful interrupt + resume-hint capture) before tearing the PTY down —
an inline confirm appears first when `session.process` reports a live
foreground process.

Session views mount plugin-style: only the selected session renders a
`ShellTerminal` — unselected sessions have no xterm view at all. PTY
lifetime is session-owned, not view-owned: `acquirePty`
(`ptyLifetime.ts`) holds a permanent session-level owner for each session's
main PTY (sub-shell tab PTYs are covered by `syncRetainedPtys`), so a view
unmount can never reach the last owner and kill the process — closes are
explicit (`closeSessionGracefully`, `closeTab`, `killWindowSessions`). The
session layer also owns the pieces views used to carry: a per-session
`backend.onOutput` subscription in `ShellApp` drives output retention and
plugin `onOutput` hooks regardless of mounts; each session's main PTY is
spawned eagerly (background agents and devin restores keep running with no
view — the view claims the spawn instead when it mounts first); and a
headless xterm buffer per session (`trackSessionBuffer` in
`terminalRegistry.ts`) keeps `getScreenLines`/`serializeTerminal` seeing a
live screen for unmounted sessions, which is also the freshest repaint
source on remount.

The session tab strip keeps `shell` pinned leftmost; sub-view tabs (editor,
browser, shell, preview, git) are drag-and-drop reorderable. `Ctrl/⌘+Alt+←/→`
cycles tabs of the selected session, `↓/↑` sessions, `Shift+↓/↑` workspaces.

Git inspect tabs (`editors[].kind === 'git'` in `state.json`, view
`app/GitInspectView.tsx`) are a GitKraken-style workbench for the repo root
recorded in `path`: staged/unstaged/untracked/conflicted file lists with
per-file and bulk stage/unstage, a commit box with an amend toggle, a
read-only Monaco diff editor (HEAD/index blobs vs. disk for the working
copy, parent-vs-commit blobs for history), and a resizable lane-graph
history strip (every ref, or only HEAD and the compare base when the tab has
one — `historyRefs`: a review worktree shares its clone's refs, and `--all`
showed unrelated branches as if they were the MR's) (`app/GitGraph.tsx` + `assignLanes` in `app/gitClient.ts`)
where selecting a commit lists its files and shows their diffs. Hovering a
commit row opens an interactive card (a portal, not `data-tip` — it must be
clickable) with the full hash (click to copy), author, absolute commit time
and subject. Right-click
is everywhere: file rows offer stage/unstage, open file (an editor tab; a
deleted file instead offers restoring the recorded state) + copy path,
commit rows offer copy-hash, and history file rows offer "Restore this
state" (`git restore --source=<sha>`, the parent for deletions), and the
diff editor replaces Monaco's built-in menu
(`contextmenu: false` — "Go to Definition" makes no sense read-only) with a
DOM `ContextMenu` offering copy-selection/copy-old/copy-new plus — with a
`review-agent` configured — "Discuss this change" on the selected diff text
(opens an agent talk sub-shell seeded with the selection). All git I/O
goes through the backend `git_exec` command (`src-tauri/src/lib.rs`) —
`git` with an explicit argv,
no shell — wrapped by `git(cwd, args)` in `app/gitClient.ts` together with
the pure `git status --porcelain -z`, `git log`, and `--name-status -z`
parsers. The view refreshes on visibility change, on a 600 ms-quiet
`shell-output` debounce (repo state changes through the shell), and via a
manual refresh button. Git tabs are session-bound: like sub-shells they are
excluded from "Move to" plugin-view hosting.

The git-inspect plugin's `review-agent` setting (select: off / Devin /
Claude / Gemini / Codex, `gitInspect.tsx`) enables agent review rows in those menus —
"Explain this change" and "Talk about this change" (`app/gitReview.ts`,
pure helpers + tests). Explain runs `<agent> -p "<prompt>"` via backend
`exec` in the repo root — the prompt travels inside the command as a
quoted heredoc (no temp file, no fs capability, nothing to clean up) —
then stores the answer in `services.storage` keyed by `commit:<sha>` /
`commit:<sha>:<path>` / `wt:<path>` (with a `diffHash` staleness hint;
bounded to 200 entries). Rows show a spinning hourglass while pending and
a sparkles badge once stored; the badge opens a popover with the text,
"Talk about this" (opens a sub-shell seeded with the prompt — `devin --`/
`claude` interactive, then `exec $SHELL -l` keeps the tab usable; the tab
is marked `agent` so re-spawns resume the conversation, see above), and
"Forget".

`ctx.openSubShell(command?, cwd?, label?, agent?)` on `PluginApi` (also in
`RepoMenuContext`) opens a session sub-shell tab — one-shot `sh -c` with a
command, interactive shell without — so plugins can spawn terminal work
the same way `axn-sh` does. `label` sets the tab's display name, `agent`
(`'devin' | 'claude' | 'agy' | 'codex'` — `AgentCli` in types.ts) marks the
tab as hosting an agent conversation so re-spawns resume it. The return value is the tab/PTY id — the same id the
plugin hook `onSubShellExit(ctx, tabId, exitCode)` reports when the
sub-shell exits (desktop carries the real exit code, web reports `null`;
dev-workflow correlates it to record `run-in: sub-shell` check results).

`ctx.openSession(cwd?, name?, workspaceId?)` on `PluginApi` opens a new
session rooted at `cwd` (default: the shell default; a given `name` becomes
the session's custom name, so the terminal title does not replace it) — in the ctx
session's workspace unless `workspaceId` targets another — selects it,
and dismisses a covering plugin view so the user lands on the new
session. `ctx.getWorkspace()` returns the session's `Workspace` (carrying
`defaultFolder`); `ctx.getWorkspaces()` lists all workspaces in panel
order. Both are also exposed to sandboxed plugins
(`axn.session(id).openSession()`/`getWorkspace()`/`getWorkspaces()`).

`ctx.runCommand(line)` dispatches a line through the session's
hidden/plugin command pipeline — the same path a typed `axn-*` line takes
(`axn-git`, plugin `commands`, `onCommand` hooks), resolving `false` when
swallowed, a replacement command string, or `undefined` for pass-through.
It's how plugin code invokes hidden commands without faking PTY input —
`writeToSession` writes go straight to the shell and never reach the
interception layer. Host (ShellApp) registers the dispatch in a
module-level holder (`registerSessionCommandDispatch` in `plugin.ts`), so
apis built by SessionPanel/SessionView get it too; sandboxed plugins call
`axn.session(id).runCommand(line)`.

`ctx.activateTab(tabId)` brings one of the session's views to the front —
`'shell'` for the main terminal, else a sub-view tab by id, kind, index or
label — selecting the session and dismissing a covering plugin view. It's
sugar for dispatching `axn-focus <tabId>` through `runCommand` (resolves
`true` when a tab was activated); sandboxed plugins get
`axn.session(id).activateTab(tabId)`.

Workspaces carry an optional `defaultFolder` (persisted in `state.json`):
set/clear it from the workspace context menu — "Set default folder…" opens
`SetDefaultFolderModal`, a free path input seeded with the current value
(empty = home directory, never validated on save), and "Set default folder to
session dir" snapshots the representative session's live cwd (hidden when the
workspace is empty). The workspace "+" button then spawns sessions rooted
there instead of the default cwd, checking the path first via `statPath` when
a live session can answer it — a path that doesn't resolve to a directory
raises `InvalidDefaultFolderModal` (fix the path, or open in the home folder)
instead of a dead terminal. Workspace-scoped plugin actions (e.g. worktrees)
resolve their repository from it.

The session-panel header also has a filter input (`PanelSearch`) right of the
workspace buttons: a case-insensitive substring match on workspace names and on
what a session's card shows — its name (custom or terminal-reported
`autoName`) plus every *placed* session field whose plugin declares a
search string (see **Session card**; `app/sessionSearch.ts`) — a workspace
stays listed when its own name matches or it hosts a matching session, matched substrings are accent-highlighted
(`Highlight`), collapsed workspaces force-expand while the filter is active,
and Esc/✕ clears it.

Tab on an `axn-*` line completes the command name, a workspace name for
`axn-session-mv`, or a filesystem path for `axn-edit`/`axn-browse`/
`axn-session`/`axn-preview` (dirs only except for `axn-edit`/`axn-preview`).

The `axn-browse` view supports an editable path bar (click the path, type a
new one with directory autocomplete), back/forward/up navigation buttons
(the history is in-memory per tab, capped at 20 entries — going back or
up highlights the folder just left), a "show hidden files" checkbox under
the path bar, an expandable tree (a folder's chevron or →/← expands/
collapses it in place — expanded listings load on demand and re-list on
refresh, `app/browserTree.ts` flattens them into rows; double-click/Enter
still navigates into a folder), arrow-key/Backspace navigation, and right-click context
menus built on the shared `ContextMenu` (`libs/shell-ui`) — per entry it
hosts `PathActionMenu` (Open, Edit, Preview, Reveal in the OS file
manager, Copy Path, and a content preview — plus Copy, which puts the
image itself on the clipboard via `services.copyImage`, shown once the
preview decoded an image); on empty space it offers New
file/New folder (inline name input in the listing, created via
`writeTextFile`/`mkdir`), Copy path, Reveal, and Refresh. Clicking an
image thumbnail in the hover card opens it in a preview tab.

## File preview plugins

Preview tabs (`editors[].kind === 'preview'` in `state.json`, view
`app/PreviewView.tsx`) are rendered by `FilePreviewPlugin`s
(`libs/shell-ui/src/app/preview-plugins/`): `id`, `title`, `settingsKey`,
`defaultEnabled`, `matches(path)`, `render(ctx)`. `ctx` provides `path`,
`resolvedPath`, `cwd`, `readFile()`/`readBytes()`/`readSibling(rel)` (resolves
against the previewed file's directory), `pluginSettings`, and `isVisible`.
`render` returns a ReactNode; a plain string is treated as HTML, sanitized
with DOMPurify, and injected (that's the form external plugins use).
`resolveFilePreviewPlugin` picks the first enabled matching plugin — the
`text` fallback is registered last so it claims anything unhandled.

Built-ins: `svg`, `image` (raster — also overlays a Copy button that puts
the image itself on the clipboard via `services.copyImage`), `markdown`,
`asciidoc`, `mermaid`
(.mmd/.mermaid), `text` (fallback). marked/asciidoctor/mermaid/dompurify are
lazy-loaded via dynamic `import()`. Markup post-processing
(`preview-plugins/html.tsx`) renders `code.language-mermaid` blocks as
mermaid diagrams — covering mermaid fences inside markdown and
`[source,mermaid]`/`[mermaid]` listings inside asciidoc — and rewrites
relative `img[src]` to blob URLs. Mermaid follows the active theme's
light/dark mode; `securityLevel: 'strict'`.

External `.mjs` plugins can attach a `preview` capability to their default
export: `preview: { extensions: ['foo'] | match(path), title?, render(ctx) }`.
It registers as a `FilePreviewPlugin` sharing the plugin's plugins.yaml
section, so `<plugin>.enabled: true` enables the preview too (still opt-in).

## CLI subcommands and agent skills

`main.rs` routes argv before Tauri starts (`src-tauri/src/cli.rs`): bare
`axn-term` launches the app — one instance per `$AXN_TERM_STATE_DIR`: a
launch that finds a live control socket asks the running app to focus a
window and exits (a stale socket is replaced), so `pnpm tauri dev` from an
axn-term terminal needs its own `AXN_TERM_STATE_DIR`; an unknown subcommand
prints usage and exits 2. `axn-term command [--window <label>] <axn-…>` runs an
app-level line from any local process — the socket's secret-free `app` message
(like `activate`), delivered as `control-app-command` to the named window or the
focused one (`window::app_command_window`); only plugin commands declaring
`appRun` (e.g. `axn-views open|select|close|current`) run, plus the built-in
`axn-session create` (in the window's selected session's context); everything else
is refused (`dispatchAppCommand` in `app/controlCommands.ts`, `appSessionCreate` in
`app/useSessionCommands.ts`). `axn-session create --command <line>` /
`--command-b64 <base64>` types the line into the new session once its shell has
printed; on the app-level path that needs the `allowExternalCommands` setting
(default off) — agterm's `session new --command` model behind a switch. `axn-term session summary|rename|focus|command …`
runs an `axn-*` command for the terminal it is invoked from — over the
control socket (`src-tauri/src/control.rs`, `$AXN_TERM_STATE_DIR/control.sock`,
0600): every PTY gets `AXN_TERM_PTY_ID` + a random `AXN_TERM_PTY_SECRET` +
`AXN_TERM_CLI` (the app binary), the socket verifies the secret minted for that
PTY and emits `control-command`; the window owning the PTY
(`sessionForPty` in `app/controlCommands.ts`) runs the line through
`handleSessionCommand` and answers via `control_reply` (`controlReply`: swallowed
→ ok, `echo "<msg>"` → message, any other replacement → refused, 5 s timeout);
on the web the session host plays the app's part: `ControlListener`
(`apps/session-host`, its own minimal Kestrel app on
`$AXN_STATE_DIR/control.sock` — 0600, chowned to the PTY user — never the
gateway-facing listener) checks `X-Axn-Pty`/`X-Axn-Pty-Secret` (PTYs get
`AXN_TERM_PTY_SECRET`, `AXN_TERM_CONTROL_SOCKET` and `AXN_TERM_CLI` =
the host-written `sh` + `curl` script `$AXN_STATE_DIR/bin/axn-term`; the id is
the existing `AXN_SESSION_ID` — `AXN_TERM_PTY_ID` stays unset so hook event
files keep their names), and `ControlBroker` delivers the line to exactly one
browser channel — the PTY's /ws connection (`control-command` frame →
`control-reply`) or else the most recently attached Ramphastos session (duplex
`control` stream) — where `SessionBackend.onControlCommand` hands it to the same
dispatch (`tests/control-e2e.mjs` covers both transports);
`axn-term install`/`uninstall` copy the bundled
agent skills (embedded via `include_str!` from `src-tauri/skills/<name>/`) into
agent skill dirs — same scheme as `axn-dev install` (`--skills`, `--skill`,
`--project`, `--repo`, `--devin`, `--agent`, `--all-agents`). Agent-facing
conventions for programs running inside axn-term are documented in
`docs/agents.md`.

The terminal link provider (`libs/shell-ui/src/terminalLinks.ts`, used by
`libs/shell-ui/src/ShellTerminal.tsx`) reconstructs URLs split across a line break — a soft
wrap on a narrow terminal or a hard wrap inside a table cell. A `scheme://`
token that reaches the line edge or sits flush against a cell border is
extended into continuation rows (column 0 for soft wraps; the same column
under a matching border/blank prefix for table cells), and the link range
spans all fragment rows so any fragment activates the full URL. A token
padded by spaces up to a cell's right border also counts as cut off: the
continuation is the first token of the same cell on the next row, which is
only trusted when the row shares the table's border layout and every other
cell is blank (single-cell tables additionally need an unmatched `(` before
the URL — e.g. `!6 (https://…` continuing `merge_requests/6)` below). Hovering a
reconstructed URL shows the hover card with the joined link (Open / Copy
URL); plain single-line URLs stay click-only. Selecting text also opens the
card: a one-word selection resolves as a path/URL; a selection spanning rows
is rejoined without its wrap indentation (`wrappedSelectionCandidates` in
`terminalLinks.ts` — agent TUIs hard-wrap long paths onto an indented
continuation row) and its longest path/URL-like word that resolves gets the
card; otherwise a copy-only card. The hover card is placed from
its measured size (`placeHoverCard` in `hoverCardPlacement.ts`, re-run via
ResizeObserver as its preview loads): below/right of the pointer, flipped
above near the bottom edge and to the left near the right edge.

## Online session hosts (gateway env)

`apps/gateway/SessionHostContainerService.cs` spawns one container per user.
Env knobs (passed through `scenarios/axn-term-online/compose.yaml`):

- `SESSION_HOST_RUNTIME=kata` + `SESSION_HOST_DIND=1` + `SESSION_HOST_USER=0:0` —
  per-user VM with an inner dockerd.
- `SESSION_HOST_HOME_VOLUME=<prefix>` — named volume `<prefix>-<user>` mounted
  at `/home/<user>`; `$HOME` persists across session-host recreation.
- `SESSION_HOST_NIX_VOLUME=<prefix>` — named volume `<prefix>-<user>` mounted
  at `/nix`, seeded once from the image's `/opt/nix-seed` (a full single-user
  nix install baked into the session-host image). Entrypoint writes
  `/etc/nix/nix.conf` (unsandboxed builds, flakes enabled) and puts
  `~/.nix-profile/bin` + the default nix profile on PATH via
  `/etc/profile.d/nix.sh` and `/etc/bash.bashrc`.
- `SESSION_HOST_PREFIX` — container name prefix (default `axn-term-host`);
  `SESSION_HOST_HOSTNAME` — in-guest hostname (default `axn-machine`).
- `AXN_NIX_FLAKE` — deployment-wide default home-manager flake ref.
- `SESSION_HOST_MEMORY` / `SESSION_HOST_PIDS` / `SESSION_HOST_CPUS` —
  per-container limits (defaults `4g` / `4096` / `2`; `0` lifts a limit).
- `SESSION_HOST_ALLOW_UNSAFE_RUNC=1` — permit `SESSION_HOST_DIND`/
  `SESSION_HOST_PRIVILEGED` without kata (otherwise the gateway refuses to
  start; DIND under runc is effectively host root).
- `AXN_EXEC_TIMEOUT_SECONDS` — session-host `exec` timeout (default 120;
  the process tree is killed on timeout or cancel).

Session hosts only accept requests carrying the per-container secret the
gateway generates at create time (`AXN_SESSION_HOST_SECRET` in the container
env, sent as `X-Axn-Session-Secret`). The entrypoint moves it into a
root-only file (`AXN_SESSION_HOST_SECRET_FILE`) before starting the host,
so no PTY or exec child can inherit it. A host
without the env refuses to start unless `AXN_SESSION_HOST_INSECURE=1`
(local runs only); the gateway recreates pre-secret containers. Containers
are keyed by the token's username when it is already a clean ASCII name
(`[a-z0-9_-]`), else `<ascii-prefix>-<8 hex of sha256(name)>` so distinct
names never share a container or home volume; tokens without an identity
claim are rejected (no `?user=` fallback).

Per-user environment sources live in the persistent home (applied on every
spawn, in the background — see `scenarios/axn-term-online/session-host/entrypoint.sh`):

- `~/.config/axn-term/nix-flake` — home-manager flake ref (wins over
  `AXN_NIX_FLAKE`); applied via `nix run home-manager/master -- switch`.
- `~/.config/axn-term/nix-packages` — one `nix profile install` arg per line.
- `~/.axn-term/bootstrap.sh` — imperative escape hatch.

Setup output lands in `~/.local/state/axn-term/{nix-setup,bootstrap}.log`.
`POST /session/recreate` (gateway, authenticated) force-removes the caller's
session host; the next `/ws` connect respawns it with volumes reattached —
that's the user-facing "re-apply my environment" trigger. Spawns are
serialized per user in the gateway (StrictMode double-mounts race otherwise).

## Build commands

```bash
# Local development
pnpm install
pnpm dev:desktop

# Release build (produces target/release/bundle/)
pnpm build:desktop

# Dev variant: axn-term-hmr.app (yellow icon, HMR frontend, own state dir)
pnpm build:hmr

# Storybook (component catalog for apps/desktop)
pnpm --filter @axn-term/desktop storybook

# …or containerized with HMR through the published port:
axn-dev start -s axn-term-storybook   # http://localhost:8098
```

`src-tauri/build.rs` stamps `AXN_BUILD_DATE` (UTC, re-run when `../dist`
or `src` change); `lib.rs` swaps the default menu's macOS "About axn-term"
item for one showing "Version <x.y.z> (built <date>)".

Native menu bar (`app_menu` in `lib.rs`): macOS keeps Tauri's default menu
set (About shows version + build date, Preferences…, added View submenu).
Linux/Windows get a small custom menu — &File (Preferences…, Quit),
&View (Zoom In/Out/Actual Size — emit `menu-zoom` → `uiZoom` setting — and
Reload — `menu-reload` → the state-saving window reload), &Help (About).
The stock `Menu::default` is avoided there because only its About works
and its Edit accelerators (Ctrl+C/X/V/A/Z/Y/M) would be swallowed before
the PTY sees them; Quit is a custom `axn-quit` item for the same reason
(the predefined one binds Ctrl+Q, needed for XON). The bar starts hidden
per window (`hide_menu` in `create_window_with`); the frontend toggles it
on a solo Alt tap via `toggle_menu` (Thunderbird-style, Alt-as-modifier
does not toggle), accelerators stay live while hidden, and `on_menu_event`
re-hides it after any item is picked (which also covers a just-opened
settings window).

Built macOS artifacts:

- `target/release/bundle/macos/axn-term.app`
- `target/release/bundle/dmg/axn-term_0.1.0_aarch64.dmg`

`build:desktop` runs `tauri build --bundles app` and then
`build/scripts/make-dmg.sh`, which packages the .app into the DMG with a
single `hdiutil create -srcfolder ... -format UDZO` step (app +
`/Applications` symlink in a staging dir). It deliberately avoids
tauri-bundler's create-dmg fork: its read-write image + Finder-prettifying
AppleScript regularly fails on unmount ("resource busy") and leaves stale
`rw.*` volumes mounted.

App icons: `src-tauri/icons/icon.icns` is **not** generated by `tauri icon`
— it comes from `src-tauri/icons/icon-macos.svg`, a plated variant
(axn-dark `#141110` squircle plate, Apple 824/1024 grid) of the transparent
axn-term glyph the PNGs/.ico use, rebuilt by
`build/scripts/make-macos-icon.sh` (rsvg-convert + iconutil). macOS
composites Dock icons over the translucent Dock, so the transparent
interior shows through as white/gray there. Regenerating the shared icon
set with `tauri icon` would restore the transparent `.icns` — re-run
`make-macos-icon.sh` afterwards. The axn-term-hmr dev variant has its own
set in `src-tauri/icons-hmr/`: the same plated glyph on the dev yellow
`rgb(227 179 65)` — unlike the production set, every raster asset there
(PNGs, `.ico`, `.icns`) is rendered from the plated
`icons-hmr/icon-macos.svg` so the yellow identifies the dev build on all
platforms. `tauri.term-hmr.conf.json` points `bundle.icon` at it and
`build/scripts/make-macos-icon.sh hmr` regenerates the whole set.

## Internationalization (Lingui)

UI strings are localized with [Lingui](https://lingui.dev) 6 (macros via
`@lingui/babel-plugin-lingui-macro`, configured in `apps/desktop`,
`apps/web` vite configs and `libs/shell-ui/vitest.config.ts`).

- Catalogs: `libs/shell-ui/src/locales/{locale}/messages.po` — `en` is the
  source locale, `ko` is translated. Compiled `messages.ts` files sit next
  to the .po files and are committed. `lingui.config.ts` at the repo root
  scans `libs/shell-ui/src`, `apps/desktop/src`, `apps/web/src`.
- After changing wrapped strings: `pnpm i18n:extract` (updates .po files)
  → translate new `msgstr` entries → `pnpm i18n:compile` (regenerates
  `messages.ts`).
- In components use `const { t } = useLingui()` and
  `import { Trans, useLingui } from '@lingui/react/macro'`; wrap JSX text
  in `<Trans>…</Trans>` and attribute/dynamic strings in `t\`…\``. For
  module-level message tables use `msg` from `@lingui/core/macro` and
  translate at render time with `t(descriptor)` — a `t` received as a
  function parameter is NOT a macro binding and is silently skipped by
  extraction.
- `libs/shell-ui/src/i18n.ts` owns the global `i18n` instance and loads
  all compiled catalogs statically; `SettingsProvider` wraps children in
  `I18nProvider` and calls `activateLanguage(settings.language)` on change.
- `@lingui/cli` 6.9 gates its subcommands on `import.meta.main`, which Node
  22 lacks (added in Node 24) — `extract`/`compile`/`check` silently exit 0
  doing nothing. `patches/@lingui__cli@6.9.0.patch` replaces the gate with a
  `process.argv[1]` comparison so `pnpm i18n:extract`/`i18n:compile` work on
  Node 22.
- `libs/shell-ui/src/i18n.test.ts` fails when a compiled catalog misses an
  `en` message id or a non-`en` `.po` entry has an empty `msgstr` — a missing
  translation surfaces in the UI as untranslated English (or a raw hash id
  where no `message` fallback exists). The same file also runs
  `lingui check sync` (`pnpm i18n:check`), which fails when a wrapped string
  was added to the code but never extracted — the catalog-vs-catalog checks
  cannot see a msgid that never entered the .po files.
- User-facing control: `language` setting in `config.yaml` (`en`/`ko`) and
  Settings → General → Language.

## Session view plugins

Session-view plugins implement `SessionViewPlugin` (`libs/shell-ui/src/app/session-plugins/plugin.ts`): `id`, `title`, `version`, `dependsOn`, `stateKey`/`settingsKey`, `defaultEnabled`, plus optional `sessionFields` (session-card information — see **Session card** below), `onOutput`, `onCommand`, `onSessionOpen`, `onClose`, `repoMenuItems`, `sessionMenuItems` (rows contributed to the session right-click menu — dev-workflow adds its start/move/stop entries there), `workspaceMenuItems(ctx, workspace)` (rows in the workspace-header context menu; `ctx` binds to a representative session — the selected one when it lives in that workspace, else the workspace's first — and workspaces without sessions get no plugin rows). `version` (`x.y.z`) is shown in Settings and matched by `dependsOn` — each dependency `{ id, version? }` must be registered, enabled, and satisfy the optional constraint (`1.2.3`, `>=`/`>`/`<=`/`<`, `^` same-major) or the plugin counts as disabled (unmet deps are listed in Settings; cycles resolve to disabled). All built-in session-view and file-preview plugins carry `version: '0.1.0'`; external `.mjs` plugins may declare both fields on their default export. Plugins can be bound to a foreground process via `processPattern` (regex on `session.process` — the argv-derived identity, see below; anchor it, e.g. `/^claude/i`, so programs merely containing the name don't match); when the process exits, `onProcessEnd` fires once — use it to clear process-bound UI like task lists or progress bars. A plugin whose program edits its own input line declares `agentInput: { title? }` (devin does): while it is foreground, hidden-command interception switches to `'agent'` mode instead of off, and `session.agentInput` carries the plugin id — set from the 1 s process poll, or earlier from an OSC terminal title matching `title`. The core resolves both through `agentInputPluginFor`/`agentInputPluginForTitle` (`agentHookBridge.ts`, over the enabled plugins) and never names a specific agent. The plugin API (`PluginApi`) provides `writeToSession`, `updatePluginState` (merged against latest state), `pluginState`, `pluginSettings`, `exec(command, cwd?)` (runs `sh -c` via the `plugin_exec` backend command), `readFile(path, cwd?)`/`writeFile(path, contents, cwd?)`/`statPath(path, cwd?)` (backend file ops via `backendFileService` — work on desktop and web; `statPath` resolves null when absent), `waitForSessionOutput`, `openBrowser(path)` (opens an `axn-browse` directory
tab for the session), `openTab({ path, kind })` (opens an
editor/browser/preview/git sub-view tab), `repoMenuItems(repo)` (the rows
all enabled plugins contribute to the repo context menu), `setBanner(banner
| null)` — a dismissible strip on top
of the session view, stored in pluginState under the reserved `banner` key
(`SessionBanner { message, level?: 'info'|'warning'|'error', dismissible?,
actions?, trailingActions? }`; `dismissible: false` hides the ✕ — the plugin
clears the banner itself; `actions`/`trailingActions` are JSON-safe
`SessionBannerAction { id, icon?, label?, title?, disabled? }` buttons
rendered before the message / at the right edge — clicks route to the
plugin's `onBannerAction(ctx, actionId)` hook); banners from
all enabled plugins stack above the session's tab strip and are rendered by
the shared `Banner` component (`app/Banner.tsx`), also usable for app-level
notices — and `setAttention(attention | null)` — a per-plugin
"needs attention" flag stored in pluginState under the reserved `attention`
key (`SessionAttention { message?, level?: 'warning'|'critical' }`). A raised
flag also fires `services.notify` — once per flag content, and only for
sessions the user isn't looking at (a different session is selected or the
window is unfocused) —
and `setRestoring(label | null)` — raises/clears the plugin's "restoring"
overlay over the session's terminal (in-memory store `app/restoring.ts`,
keyed sessionId → pluginId → label). A plugin that restores session state
by injecting commands on open declares `pendingRestore(ctx)` — evaluated
when a session's PTY has just spawned, right before `onSessionOpen` runs
(same freshly-spawned gate; never on PTY reattach); returning a display
label covers the terminal with a blocking `RestoringOverlay`
(`app/RestoringOverlay.tsx`) that steals focus so keystrokes cannot reach
xterm and race the injected restore command. The overlay clears on
`ctx.setRestoring(null)` — the plugin must call it on every resolve path —
or via the overlay's × button for hung restores. The devin plugin uses
this: `pendingRestore` returns `devin session '<name>'` when
`restore-session` is on and a captured name exists, and `finishRestore`
clears it on ok/gone/timeout. Restore also requires the agent to have been running when the session went away (`devinActive`/`claudeActive` in pluginState): set while the agent is foreground, cleared when it exits on its own or the session closes at a plain prompt, kept when `onClose` (or a crash) stops it — the captured name/id survives for `axn-devin-resume`/`axn-claude-resume` either way.
Separately, every agent exit also publishes an `at`-stamped "last session"
into the plugin's app-level pluginData (`pluginData.<key>.last`, shared
across sessions) via the shared `agentResume.ts` module: the captured
name/id's exact resume line (`devin -r <name>`, `claude --resume <id>`
with its `--worktree`), else the agent's "continue latest" line (`devin
-c`, `claude -c`, `codex resume --last`, `agy -c` — vibe records
named exits only, its bare `-r` lists sessions). Exactly ONE last exists
across agents — the newest record by `at`, tracked in the module's
in-memory registry (seeded from the persisted records on read).
`agentResumeMenuItem` is each agent plugin's `sessionMenuItems`
contribution — `Resume <agent> session '<name>'` — offered only while no
process runs in the session (neither `session.process` nor
`session.agentInput` set) and only by the agent owning the global last,
so a menu shows at most one resume row; the click dispatches the stored
line like a typed command so `onCommand` bookkeeping sees it. Each record
also carries a `title` — the conversation's display name captured at exit
from the session's `autoName` (the agent's OSC title, e.g. a `/rename`
name, with its own `<cli>: ` prefix stripped via `stripAgentTitlePrefix`)
or the custom session name — and UI labels prefer it over the raw
name/id. `agentResumePanel` (`agentResumePanel.tsx`) is the same offer as
a `<agent>.resume` session field (a button on the selected session's card), behind each
agent plugin's `resume-button` setting (default on; the menu row shows
regardless). Both go through the shared `resumableAgentLast` gate and
`resumeAgentSession` dispatch. A restore's
'gone' outcome clears a matching record (`forgetLastAgentSession`). Flags
surface as a pulsing disc underlaying the session's process icon; `critical`
(the default) is red, `warning` orange. `renderRail` plugins get a
`setAppAttention(attention | null)` for app-level flags (e.g. the RAM plugin
flagging memory pressure); app-level flags live in the in-memory store in
`app/attention.ts` and aggregate with session flags into the rail's dot.
Selecting a session clears its flags (`clearSessionAttention`, plugin flags
and sub-shell `tab.hookAttention` alike — the latter also clears on user
input into any of the session's terminals: `onUserInput` fires from
`sendInput`/`Shift+Enter` on chunks `isUserInput` proves aren't
terminal-generated query replies).
The rail slot under the hamburger is a permanent `active/total` session
counter (running processes / open sessions) — when flags are raised the
pulsing dot + level icon render inside the same fixed-height slot (click
opens the attention modal), so plugin rail views below never shift.
Plugin rail icons are reorderable by dragging — pointer-driven
(`startRailDrag` in `ShellApp`, `railDropIndexAt` in `app/railOrder.ts`),
not HTML5 drag-and-drop: rail views are `<button>`s and WebKit starts no
drag from a button press (macOS only showed a "+" cursor). Press, move 4px,
release to drop, Esc cancels; the click after a drag is swallowed. The
chosen order persists in window state
`pluginData['axn-rail'].order` — a preference list over plugin ids handled
by `app/railOrder.ts` (unlisted plugins append in registration order,
disabled ones keep their slot for re-enable).
The devin plugin uses this for idle detection: while devin runs, a quiet
screen for `devin.idle-timeout-seconds` (default 45) raises a `warning` flag
whose message guesses "waiting for input" vs "possibly finished" from the
output tail. Silence only counts once the user has selected the session and
the screen changed thereafter — `app/attention.ts` tracks each session's
last selection timestamp (`noteSessionSelected`/`sessionLastSelectedAt`)
and `watchedOutput` in devinTasks records which selection an output chunk
followed; sessions the user never watched never flag, and re-selecting a
session resets the baseline. Two filters keep repaints from gaming this:
only chunks that actually change the visible screen re-arm the timer
(`screenSeen` fingerprint — TUI repaints/reflows/attach replays resend
identical text), and "possibly finished" additionally requires devin to
have been seen working (`workSeen` — the `(esc twice to interrupt)` hint
on screen) since the user's last look, so a session quiet at its prompt
never claims to have finished. The same hint marks the session `running`
in the badge even when every todo row shows done (or none exists —
stepping back to idle takes two hint-free scans so a flicker cannot flap
it).

For task/progress detection the devin plugin scans the session's live
xterm screen (`ctx.getScreenLines()`, throttled to ~1/s while devin is
foreground) for the `│ glyph N.` task rows — Devin ≥3000.11 renders the
todo list inside the TUI's live region whose diffed updates never reach
scrollback, but the resolved screen buffer holds them cleanly. Because
detection follows what this terminal displays, no session-id mapping is
needed. A vanished block keeps the last list (`onProcessEnd` owns the
clear); the older marker-gated `parseDevinTasks` scrollback parser
remains as a fallback for pre-3000.11 CLIs.

**Session card** — plugins only *provide* session information; the panel
assembles each session's card. A plugin declares `sessionFields:
SessionField[]` (`session-plugins/plugin.ts`): `{ id, label, kind: 'inline'
| 'block', zone, value(ctx), tip?(ctx) }` — `inline` is a compact badge/chip,
`block` full width; `zone` is the default placement; `value` returns null
when there is nothing; `tip` adds `<marker>: <meaning>` lines to the card
tooltip while the field shows. Fields are addressed `<pluginId>.<id>`;
built-ins are `core.name`, `core.status`, `core.summary`, `core.process`,
`core.tasks`, `core.progress` (`CORE_FIELDS`). The card has three zones
(`app/sessionCardLayout.ts`): **title** (one row, inline fields only),
**always** (rows under the title on every card) and **selected** (rows only
on the selected card); a row of several inline fields renders `·`-joined.
The `sessionCard` setting in config.yaml (`{ title: [ids], always: [[ids]],
selected: [[ids]], hidden: [ids] }`) lays it out: a configured zone
replaces that zone's default, a field placed explicitly anywhere is left
out of default zones, unknown ids are skipped (a disabled plugin's fields
vanish), blocks configured into the title row move to the selected zone,
`core.name` is always in the title row, and a built-in field placed nowhere
and not `hidden` falls back to its zone. A **plugin field shows only where a
layout names it** (`resolveCardLayout`); its `zone` is only a hint. Each
unset zone falls back to the shipped `DEFAULT_SESSION_CARD`, which lists
today's card explicitly (git/MR/PR/vibe/worktree/persona badges, plugin
blocks) and deliberately leaves out `tagging.tags` and `jira.tickets`; a
new plugin's fields must be added there or to the user's `sessionCard`. `SessionItem`
(`SessionPanel.tsx`) renders it. This replaced the per-plugin `renderRow`/
`rowTip`/`render` hooks (and the short-lived `sessionLine`); external `.mjs`
plugins declaring the old hooks still work — `pluginSessionFields` adapts
`renderRow`(+`rowTip`) to a `<id>.row` title field and `render` to a
`<id>.panel` selected block. `findSessionField(plugin, id)` looks one up.
A field may also declare `search(ctx)` — the plain-text term(s) the panel
filter matches for it (mirroring `value`'s gate: null when nothing shows).
Only fields the layout places (any zone; the selected zone counts) are
searched, never hidden ones, so every match is something the card can
show; core terms are the name/`autoName`, the summary (while
`sessionSummaries` is on) and the process (`sessionSearchTerms`). Searchable
built-ins: `git-status.branch`/`.repo` (branch, repo name),
`glab-mr.mr`/`.mrs` and `gh-pr.pr`/`.prs` (refs + titles),
`worktrees.worktree`, `dev-workflow.state` (workflow, state, declared var
values) and `jira.tickets` (keys, plus status/summary once cached —
`peekEnrichment`); `agents.persona` is deliberately not searchable (the
agents view owns persona lookup).
Built-in field ids: `git-status.branch`/`.repo`, `glab-mr.mr`/`.mrs`,
`gh-pr.pr`/`.prs`, `agents.persona`, `worktrees.worktree`,
`vibe.attention`/`.panel`, `claude`/`codex`/`antigravity`/`opencode`
`.resume`, `devin.panel`, `dev-workflow.state`, `ram.memory`,
`jira.tickets`; sandboxed plugins offer their pushed surfaces as
`<id>.row`/`<id>.panel`.

Plugins with `renderView` offer a full-area plugin view: the rail ctx gains
`viewActive`/`toggleView`, and activating it deselects all sessions in the
panel and renders `renderView({ pluginSettings, close, appState,
updateAppState, openTab, sessions, selectSession, sessionApi })` in place of
the session terminals (the selected session's terminal stays
mounted, hidden — other sessions have no view at all). `sessions` lists live `ShellSession`s,
`selectSession(sessionId)` closes the view and focuses that session, and
`sessionApi(sessionId)` returns a `PluginApi` bound to that session so the
view can drive sessions other than the selected one (the dev-workflow kanban
moves states on cards). Selecting a session or using the session/workspace keyboard
navigation closes the view. `appState`/`updateAppState` (also on the rail ctx)
read and shallow-merge the plugin's persisted app-level data — window state
`pluginData.<settingsKey>` in `state.json`, the view counterpart of
per-session `pluginState`.

Plugins declaring `repoDirs(ctx)` report local repos (`RepoDir { path, name?, remote?, worktrees? }`, `ctx.exec` runs `sh -c`). ShellApp publishes the enabled providers to `app/repoDirectory.ts`; `localCheckouts(exec, roots)` combines them with a search of the caller's roots and expands every repo into its checkouts (main + linked worktrees, branch, `origin`), deduplicated by path — sources add, never replace. The root search reads git's metadata files instead of running git (`repoProbeScript`: `.git` file → `gitdir:` → `commondir`, `worktrees/*/gitdir`, `HEAD`, `config`), prunes `node_modules`/`target`/… and is cached per root set for 5 minutes; `remoteMatchesProject` matches a forge project path exactly.

Plugins declaring `hostsTabs` get a tab strip inside their view: `renderView`
is pinned leftmost as `view`, hosted sub-view tabs (browser/editor/preview —
never sub-shells, their PTYs stay bound to the owning session) follow and are
persisted in window state `pluginTabs.<plugin-id>`. `openTab({ path, kind })`
opens one. Right-clicking any session tab offers "Move to" a tab-hosting
plugin view; right-clicking a hosted tab offers moving it back to any
session. `Ctrl/⌘+Alt+←/→` cycles the hosted tabs while the view is active.

The `awesome-list` plugin (`session-plugins/awesomeList.tsx`, FolderHeart
rail icon) is a local favorites list: folder/file paths, URLs and shell
commands (`type: 'command'`) kept in `pluginData['awesome-list'].items`.
Clicking opens dirs as `browser` tabs and files as `editor` tabs inside the
plugin view (files also get a Preview action, URLs open externally); clicking
a command runs it in the current session — `renderView` ctx's
`selectedSessionId` (the session selected when the view opened; the
only session otherwise) — the line is routed through `runCommand` (so
`axn-*` favorites dispatch) then written to the PTY with a trailing CR,
and `selectSession` brings the terminal forward. "Run in another
session…" (menu row) asks via the shared `pickFromList` picker, a
hover/menu "Type into session" action writes the command without CR so
it can be edited first, and "Copy command" uses `services.copyText`. Entries are added/edited/removed in the view — a leading `>`
in the add input stores a command (`> [label =] command`, ` = ` separates
the label) — or via the `axn-awesome` hidden command (`axn-awesome`/`ls`
prints a numbered list with `$` marking commands, `add <path|url> [label]`
resolves via `stat_path` against the session's live cwd, `cmd [<label> =]
<command>` stores a command, `run <n|name>` routes the stored command
through `runCommand` dispatch (so `axn-*` favorites dispatch; a plain
command replaces the typed line), `rm <n|name>` removes — `completeArg`
completes subcommand names and `run`/`rm` targets); paths resolve via `stat_path`
(`~` expands, nonexistent paths are flagged "not found" in the view). A
filter row above the list matches label and path/command; Enter activates
the top match. Right-clicking a path entry opens a context menu built on
the shared `PathActionMenu` (Open/Edit/Preview/Reveal/Copy Path + Copy for
decodable image previews, or Open/Copy URL for links) with `extraItems` for
bookmark-specific
Edit/Remove rows; command entries get a plain menu with Run/Type/Edit/Remove.

The `glab-mr` plugin (`session-plugins/glabMr.tsx`) tracks GitLab merge
requests via the `glab` CLI. Per session it runs `glab mr list -s <branch>
-F json` plus two `glab api` calls per MR —
`projects/:fullpath/merge_requests/<iid>` (for `head_pipeline.status`) and
`…/<iid>/discussions` (notes' `resolvable`/`resolved` → `openThreads`, by
`countOpenThreads`; absent on failure so the panel falls back to the
`blocking_discussions_resolved` boolean chip) — when the repo/branch
signature changes or the cached list is >5 min stale; results live in
pluginState `glab-mr.mrs`. The session-panel block shows `N open threads`;
the renderView rows show the GraphQL `description` clamped to 3 lines.
App-wide it polls `glab api graphql` (one list query over
`currentUser.assignedMergeRequests` ∪ `authoredMergeRequests` without
assignee → "mine", and `reviewRequestedMergeRequests` → "review", carrying
GitLab's `userNotesCount`/`resolvable`/`resolvedDiscussionsCount` counters
instead of discussions — GitLab cuts a request off at ~30 s and resolving
every note author timed out; review MRs' discussions follow in aliased
batches of 8, only for MRs whose counters changed since the last poll, so
a quiet poll is one call) on a
`glab-mr.refresh-interval-seconds` cadence (default 120) — the rail teaser
shows `action/total` for mine and `waiting/total` for review, and toggles
the plugin's renderView listing both sets. `glab-mr.hostname` overrides the
`glab api --hostname` default.

The `gh-pr` plugin (`session-plugins/ghPr.tsx`) is the GitHub twin, driven
by `gh`. Per session it runs `gh pr list --head <branch> --json
number,title,url,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,isCrossRepository,headRepositoryOwner`
plus one batched `gh api graphql` call (PR numbers as `-F` variables) for
`reviewThreads.isResolved` — resolution state is GraphQL-only; the per-PR
unresolved count lands in `openThreads` (the panel shows `N open threads`;
the renderView rows show the fragment's `bodyText` clamped to 3 lines).
`--head`
matches the branch *name* in any fork, so `ownPrs` keeps same-repo PRs and
fork PRs only from the owners of the remotes this checkout pushes to (origin
plus the branch's push/tracking remote) — otherwise a session on `main` of a
popular repo shows strangers' fork PRs named `main`. Results live in
pluginState `gh-pr.prs`. App-wide it polls `gh api graphql` with
`is:pr is:open assignee|author|review-requested:@me` searches on a
`gh-pr.refresh-interval-seconds` cadence (default 120); `gh-pr.hostname`
overrides `gh api --hostname` (GHES). The search fragment is sized under
GitHub's 500,000-node query limit (`reviewThreads(first: 50)` ×
`comments(last: 20)` — `last`, because `mrWaitingForMe` reads a thread's
newest note). It shares glab-mr's model fields and classification helpers —
`mergeMine`, `openThreads`, `mrNeedsAction` + `prNeedsAction` (adds
`changes_requested`), `mrWaitingForMe` — and renders the same
rail/panel/row/view surfaces plus a `changes requested` badge; rows carry
the shared `mrActions` providers (dev-workflow's `review` button resolves
`pull/N/head`).

Both forge plugins are on by default and stay quiet where they don't apply
(shared helpers in `session-plugins/forge.ts`):

- A session only queries its own forge: `forgeOfRemote(repo.remote)` —
  the plugin's `hostname` setting, else `github`/`gitlab` in the origin
  host — makes gh-pr skip GitLab repos and glab-mr skip GitHub repos;
  unknown hosts try the CLI.
- Every command runs behind `forgeCliCommand` (a `command -v <cli>` guard
  that fails with a fixed `axn-term: <cli> is not installed` marker), and
  `classifyCliError` sorts overview failures into `missing`, `signed-out`
  (`gh auth login` / `Invalid token` / an anonymous `currentUser: null`)
  and `error`. `forgeRailMode` turns that into the rail: hidden while the
  CLI is missing (and until the first result, so nothing flashes up), a
  muted icon with a sign-in hint when signed out, the red triangle only
  for real errors (network, API). The failure is kept through `loading`
  so the rail doesn't flicker between polls.
- All arguments reach `sh -c` single-quoted via `shellQuote` — git allows
  branch names like `$(…)`, and the GraphQL queries carry `$variables`.
- Each forge plugin has its own `repo-roots` setting (`glab-mr.repo-roots`,
  `gh-pr.repo-roots`; comma separated, `~` expands): folders searched for
  local clones. They add to the repos enabled `repoDirs` providers report
  (e.g. axn-dev), deduplicated by checkout path, and reach MR row actions as
  `MrRowEnv.checkouts`. The views warm the cached search when they open.
  The dev-workflow review button uses them when no open session sits in the
  MR's project: the main checkout whose `origin` matches the project path
  exactly hosts the fetch + `git worktree add` (run through any session,
  every command `git -C <repo>`). A session already open in the MR's review
  worktree is selected instead of opening a second one.

**Card enrichers** (`session-plugins/cardEnrichers.tsx`) are a cross-plugin
capability: any plugin can add context to cards other plugins render — MR/PR
rows in the glab-mr/gh-pr views and dev-workflow kanban cards (`CardChips`).
A plugin registers a `CardEnricher` at module scope (`registerCardEnricher`,
the `mrActions.ts` pattern): `enabled(settings)`, a cheap synchronous
`match(subject, settings)` that turns a `CardSubject` (`mr` title/branch/url,
`session` name/cwd/branch, workflow `vars`) into a lookup key — no key, no
enrichment — and a batched `enrich(keys, settings)`. Every key visible in one
render pass goes to a single call (30 ms batch window), results are cached per
enricher for `ttlMs` (default 5 min) and a failed batch keeps stale data and
retries after the TTL. Results are data, not components — `chips` (`label`,
`tip`, `href`, `tone`, optional `color`) rendered uniformly by `ChipView`
(`chipStyle`: tinted fill, full-strength border, text mixed toward
`--text-primary` — border + colored text alone washed out on light themes;
`color` is a named theme color — `gray`, `blue`, `cyan`, `green`, `yellow`,
`orange`, `red`, `violet`/`purple`, `magenta`, `accent` → the theme's CSS
variable — or a hex value, anything else is dropped by `resolveChipColor`), plus `fields` namespaced by the
enricher (`jira.status`, …) — so the contract could later cross the sandbox
boundary. Outside a `PluginSettingsProvider` (`useOptionalPluginSettings`)
every enricher reads as disabled. An enricher may declare
`settingsKey(settings)` — a fingerprint of the settings its results depend
on; cached results made under another fingerprint are refetched (ticket
sources have the same hook). `useEnrichedKeys` reports a key the enricher
answered *without* as `null` (unknown — the jira session field hides it),
but a failed request leaves keys `undefined`, so an outage never hides
tickets.

The opt-in `jira` plugin (`session-plugins/jira.ts`, `jira.enabled: true`) is
the first enricher. Settings: `base-url` (https), `email`, `project-keys`
(comma list — only keys of these projects match, so `UTF-8` never does) and
the token — either `token` (literal, plain text in plugins.yaml; masked in
Settings via `PluginSettingField.secret`) or `token-from: keychain`
(`keychain-service`, default `axn-term-jira`; `keychain-account`, default the
email). Setting both is refused (logged as `not active: …`). `matchSubject`
looks for a key in the MR title, its source branch, the workflow vars
(`ticket` first), then the session branch/name/cwd basename. Lookups use
`POST /rest/api/3/issue/bulkfetch` (≤100 keys per call; unknown keys are
reported per issue instead of failing the whole query like `key in (…)` JQL)
and run through `appRuntime().exec` — `sh -c` on the desktop or the session
host, so it works on remote backends and avoids Jira's CORS. The token never
reaches curl's argv: `buildRequestScript` captures it in a shell variable —
literal, or `security find-generic-password … -w` (macOS) /
`secret-tool lookup` (Linux) — and pipes curl its config on stdin
(`curl -K -`), printing the body plus a trailing status line (`splitStatus`).
A literal token is part of the `sh -c` string itself, so it is visible to
same-user `ps` on the exec host for the request's duration; the keychain
source avoids even that. Chips show `KEY · Status`, colored by status category by
default (new gray, indeterminate yellow, done green); `status-colors`
overrides per status name or category key (`new`/`indeterminate`/`done`),
as a YAML map or the one-line `In Progress: blue; Reviewed: #8e44ad` form
the Settings field writes (`parseStatusColors`, exact status before
category — `statusColor`); backlog tickets carry the same `color`.
Summary/type/assignee are in the tooltip and the chip links to
`<base-url>/browse/KEY`. It offers one session field, `jira.tickets` (inline, default zone `always`): the session's ticket keys from its MR/PR titles (glab-mr `mrs` / gh-pr `prs` per-session state, `sessionMrTitles`), else its branch, else its name (custom, else the terminal-reported `autoName`), else its cwd folder name — the first source with any key wins and may yield several (`sessionTicketKeys`/`findIssueKeys`); each renders as `KEY · Status` once the shared enrichment cache has it (`useEnrichedKeys`, `ChipView`). Where it shows is the session card layout's business (below), not a plugin setting.

The `git-inspect` plugin (`session-plugins/gitInspect.tsx`) is layered on
`git-status` (titled `git` in Settings): `dependsOn: [{ id: 'git-status',
version: '>=0.1.0' }]`, so it disables itself when git-status is off. It
owns only entry points — a "Git changes…" row contributed to the git-status
repo context menu via `repoMenuItems(ctx, repo)` (generic hook: rows come
from all enabled plugins; `ctx` is restricted to the session-bound
`RepoMenuContext`, not the contributor's own pluginState) and the `axn-git`
command — both open a session `git` tab via `ctx.openTab({ path: repo.root,
kind: 'git' })` (`openTab` on the session `PluginApi` deduplicates by
kind+path — a `base` field on the tab, set via `axn-git <ref>` or
`openTab({…, base})`, adds a "Changes vs <ref>" section to the inspect
view: a synthetic merge-base→HEAD selection producing the three-dot
merge-request diff in the same Monaco diff editor; updating `base` on an
existing tab retargets it). The repo context menu opens from both git-status surfaces:
right-clicking the repo block under the selected session, or right-clicking
the branch indicator in the session's title row (the `git-status.branch` field — its own
`RepoMenu`; contextmenu/right-mousedown stop propagation so the session
row's menu does not fire). The tab view itself lives in the app
(`GitInspectView`), so persisted git tabs keep working while the plugin is
disabled.

- Plugins are enabled per-user in `~/.axn-term/plugins.yaml` via `<settingsKey>.enabled: true|false`. Built-ins default to enabled; plugins loaded from `~/.axn-term/plugins/*.mjs` are always opt-in.
- The Settings view (`app/SettingsModal.tsx`) is a centered modal with General/Plugins tabs. The Plugins tab lists every registered session-view and file-preview plugin on the left (with an enabled dot); the right side offers the `enabled` toggle plus the plugin's declared settings. Changes persist via `updatePluginSection` (`app/PluginSettingsProvider.tsx`) — a shallow section merge that rewrites plugins.yaml (`pluginSettingsToYaml` converts camelCase keys back to kebab-case; comments in the file are not preserved by UI writes). General also holds the font settings: `shellFontFamily`/`shellFontSize` (applied to session and sub-shell terminals via `resolveShellFont` in `libs/shell-ui/src/themes.ts`, default: Monaspace stack @14px) and `panelFontFamily`/`panelFontSize` (applied to the session-panel wrapper — the size scales it proportionally against the 12px base via CSS `zoom`).
- Plugins declare UI-editable settings via `settings?: PluginSettingField[]` on `SessionViewPlugin` — pure data (`{ key, label, description?, type: 'boolean'|'number'|'string', options?, secret?, default? }` — `secret` renders a masked input for tokens) rendered generically, so external `.mjs` plugins can declare fields too. Built-ins may instead/additionally provide `renderSettings({ settings, update })` for a custom view. `git-status`, `glab-mr` and `gh-pr` each declare `show-in-panel` (gates their selected-card block field — `.repo`/`.mrs`/`.prs`; the legacy `show-in-header` key is still honored on read) and `show-in-title` (gates their title badge field — `.branch`/`.mr`/`.pr` — and its tooltip line); the `sessionCard` layout can place or hide the same fields; `devin` (`restore-session`, `idle-timeout-seconds`), `claude`/`codex`/`antigravity` (`restore-session`, `install-hooks`), `vibe` (`restore-session`, `idle-timeout-seconds`), `glab-mr` and `gh-pr` (`refresh-interval-seconds`, `hostname`) declare their fields as well.
- External `.mjs` plugins `export default` the plugin object (no JSX — a session field's `value` or a legacy `render` may return a string). They are loaded at startup through `loadExternalPlugins()` (`session-plugins/index.ts`) once `plugins.yaml` has been read — the file *watch* only reloads settings, newly dropped `.mjs` files need a restart. An `.mjs` plugin can also declare `hookSpec` (an `AgentHookSpec` from `@axn-term/plugin-sdk`, see "hook bridging" below): the host then drives the whole agent-hook bridge for it — config install per its `install-hooks` setting, event-file polling, mapped status/attention — with no lifecycle code of its own.
- Example external plugin: `plugins/axn-dev-scenarios.mjs` (copy to `~/.axn-term/plugins/` and set `axn-dev-scenarios.enabled: true`).

**Sandboxed plugins** (`~/.axn-term/plugins/<dir>/`) are the isolated tier:
each directory holds a `plugin.json` manifest (`id`, `title`, `version`,
`settings`, `commands` incl. `completeArg`, `processPattern`,
`handlesProgress`, `hostsTabs`, `logic`, `view`, `permissions`), a `plugin.mjs` logic entry
and an optional `index.html` view. Everything runs inside
`sandbox="allow-scripts"` iframes (opaque origin — no app DOM, storage or
Tauri internals); the only capability channel is the postMessage contract in
`libs/plugin-sdk` (`{ axn: 'plugin-v1' }` envelopes, `AXN_PLUGIN_API_VERSION`)
— `contract.ts` is the wire format, `api.ts` the public types
(`PluginManifest`, `SessionInfo`, `AxnClient`, …), `hooks.ts` the public
agent-hook contract (`AgentHookSpec`/`AgentHookEffect` plus the pure bridge
helpers — `mergeHookSettings`, `agentEventFile`, `agentHookScript`, …),
`shim.js` the
dependency-free client the host inlines into each frame as `window.axn`
(injected automatically; plugin files stay self-contained — sibling
`./app.js`-style references don't resolve, inline or CDN-import instead).
The bridge (`session-plugins/sandbox.tsx`) builds a `SessionViewPlugin` stub
per directory: hooks forward subscribed events (`sessionOpen`, `output`,
`close`, `line`, `command`, `completeArg`, `processEnd`, `subShellExit`,
`bannerAction`, `surfaceAction`), `axn.*` calls resolve to per-session
`PluginApi` ctxs via `sandboxRuntime.buildApi` (wired in `ShellApp`), and
`axn.setSurface('render'|'row', …)` pushes sanitized-HTML surfaces, offered
to the session card as the `<id>.panel`/`<id>.row` fields (`[data-axn-action]`
clicks → `surfaceAction`).
`renderView` mounts the view iframe (theme CSS vars injected + live
`theme`/`sessions`/`appState` pushes; `peer` relays between a plugin's logic
and view frames). Sandboxes boot/dispose with the enabled set
(`syncSandboxes`). Capabilities are opt-in via `permissions`
(`PluginPermission` in `libs/plugin-sdk/src/permissions.ts`: `exec` —
`exec`/`openSubShell`/`runCommand`; `terminal-input` — `writeToSession`, the
`line` hook and replacement lines from owned commands; `terminal-output` —
`getScreenLines`/`waitForSessionOutput` and the `output` hook; `fs-read`;
`fs-write`; `sessions` — `openSession`/`selectSession`/`activateTab`/`openTab`/
`openBrowser` and the rail views `openView`/`selectView`/`removeView`
(`getActiveView` and the `viewChanged` push need none and carry no URL);
`setRestoring` counts as `terminal-input` — its overlay takes the
terminal's input). The
bridge refuses undeclared calls with an error and never delivers undeclared
hooks; unknown entries are dropped with a warning at load. Default is none —
own pluginState, banners/attention, surfaces and swallowing owned
commands need no permission. Settings → Plugins lists the declared set.
`pendingRestore`/`repoMenuItems`/`sessionMenuItems` and
`renderSettings` stay in-process-only (sync contracts or trusted DOM).
Desktop reads plugin dirs via `list_external_plugin_dirs` /
`read_external_plugin_file`; web has no plugin dirs (capability absent).
Example: `plugins/axn-demo-note/`.
- The built-in `claude` plugin (`session-plugins/claude.ts`) is opt-in (`claude.enabled: true`). It parses Claude Code's rendered `Update Todos` block from the live screen into `session.tasks`/`session.progress` (it owns progress via `handlesProgress` while claude runs), can resume Claude Code (`restore-session: true`) — like devin it captures the conversation id from claude's exit hint (`Resume this session with:` / `claude [--worktree "<name>"] --resume <id>`; `onClose` sends Ctrl-C pairs so claude prints it, `onProcessEnd` reads it from the output tail for exits it did not drive) and restores that exact conversation behind the `pendingRestore` overlay, falling back to `claude -c` when no id was captured or a fresh `claude` launch invalidated it — and optionally bridges Claude Code **hooks** (`claude.install-hooks: true`, adapter `session-plugins/claudeHooks.ts` on the shared bridge below): `UserPromptSubmit`/`PreToolUse`/`PostToolUse` → `running` + flag cleared (PostToolUse un-blocks an approved permission at once), `PermissionRequest` → `blocked` + critical needs-you attention, `Notification` → a warning flag only — the status stays (claude also sends it when idling after `Stop`) and the bridge drops a hook-raised warning once the session is selected after it (`warningRaisedAt` vs `sessionLastSelectedAt`; critical flags wait for the next event); flags OS-notify for non-selected/unfocused sessions; `SubagentStop` is ignored (background subagents finish after `Stop`), `Stop` → `completed`, `StopFailure` → `blocked`, `SessionStart` → `idle`, `SessionEnd` clears the flag while process-end reconciliation owns the final badge. Once any hook event lands, hook state owns `session.status` and the screen scan only contributes task content; without hooks the todo-parse fallback still drives tasks/progress/status.


- Agent **hook bridging** is shared and public: the pure, dependency-free half lives in `libs/plugin-sdk` `hooks.ts` (`AgentHookSpec`/`AgentHookEffect`, `agentHookScript`/`agentHookScriptPath`, `agentEventDir`/`agentEventFile`/`agentEventLog`, `readHookLog`, `mergeHookSettings`/`removeHookSettings`, `parseHookEvent`), the host half in `session-plugins/agentHookBridge.ts` (runtime map, tty resolution + poll loop, config sync, `hookStatusOwned`). A plugin declares `hookSpec` on its `SessionViewPlugin` object — built-in *or* external `.mjs` — and the host drives the bridge for it: on output dispatch `maybeWireHookSpec` syncs the agent's config per the plugin's `installHooks` setting and starts the poll while `processPattern` matches, `releaseHookSpec` on process end stops polling and clears the flag (spec-only plugins get the default terminal badge — 'completed' persists, anything else → idle), `dropHookSpec` on session open/close forgets the runtime (all in `ShellApp`'s dispatch points). Built-ins (`claude`/`codex`/`antigravity`) declare `hookSpec` and keep only their extras (todo parsing, resume commands, `<agent>Seen` tracking) — nothing wires the bridge by hand. The spec itself carries the agent id, its event list, config file (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/config/hooks.json` — claude/codex use the grouped `hooks.<Event> = [{matcher?, hooks:[{type:'command', command}]}]` schema and a `hook_event_name` stdin payload; agy's file holds named hook groups `{"<name>": {enabled, <Event>: [...]}}` with a discriminator-free payload and a required JSON response, so its spec installs a wrapper script (`agy-hook.sh`) via custom `install`), and the event→status/attention map; agents with a non-JSON config (e.g. a JS plugin file) provide the spec and a custom `install` via the same contract. The bridge installs one script, `~/.axn-term/agent-hook.sh <agent>`, which appends each hook's stdin JSON as one line to `$AXN_TERM_STATE_DIR/<agent>-events/pty-<AXN_TERM_PTY_ID>.jsonl` (tty-named for terminals without the PTY id) — an append-only log per PTY: payloads over ~3.5 KB shrink to `hook_event_name`/`tool_name`/`notification_type` so every append is one atomic write, and past 64 KB the log rotates to `.jsonl.1` under a `mkdir` lock. While the agent is foreground the host polls the log (`pollHookEvents`/`readHookLog`, 1.5 s, offset + first-line cursor, reads the `.1` tail across a rotation) and applies every new event in order — the first read of a log applies only its newest event, and a warning never downgrades a live critical flag (`nextHookAttention`), so a PermissionRequest followed by a Notification stays "needs you". A latest-event `.json` from an older script is still read as a fallback. Hook events then own `session.status`. Agents in sub-shell tabs write to their tab PTY's own log: `SubShellView`'s 1 s foreground poll drives `createTabHookWatcher` (`app/subShellHooks.ts`) through the enabled plugin whose `processPattern` matches (`hookPluginFor`), setting `tab.hookStatus` (a dot on the tab — red pulsing for blocked) and `tab.hookAttention`, which `sessionAttention` rolls up as `tab:<label>` and OS-notifies when the tab is not in view; a warning clears once the tab is shown, a critical flag on the agent's next event. The same tick also tracks the tab agent's task list: plugins may declare a pure `screenTasks(lines)` (claude, devin), sub-shell xterms are registered in `terminalRegistry` under their tab id, and `tabTaskPatch` (`app/subShellTasks.ts`) stores `tab.tasks`/`tab.progress` — shown as done/total on the tab (list in its tooltip); a vanished block keeps the last list, an agent exit drops an unfinished one. Install merges axn-term-owned entries into the agent's config (foreign hooks/settings preserved, removed again when disabled — legacy `claude-hook.sh` entries are cleaned up too). The sandboxed manifest tier has no `hookSpec` yet — `mapEvent` is a function and cannot cross the iframe postMessage boundary; a declarative event→effect map in `plugin.json` is the planned bridge. The opt-in `codex` plugin (`session-plugins/codex.ts` + `codexHooks.ts`, `codex.enabled`/`install-hooks`/`restore-session` → `codex resume --last`, `axn-codex-resume`) maps `PreToolUse`/`PostToolUse`/`SubagentStart`/`SubagentStop`/`UserPromptSubmit` → `running`, `PermissionRequest` → `blocked` + critical flag, `Stop` → `completed`, `Interrupt`/`SessionStart` → `idle`; note codex requires new hooks to be trusted once via `/hooks` (trust review). The opt-in `opencode` plugin (`session-plugins/opencode.ts`, `opencode.enabled`/`restore-session`) mirrors the devin/claude resume flow without a hookSpec: it scans the output tail for the TUI's exit hint (`opencode -s ses_…`), records `opencode -s <id>` (or `opencode -c` when no id was seen) as the shared last-session record, tracks manual `opencode`/`-s` launches via `onCommand`, and auto-resumes reopened sessions when `opencodeActive`. The opt-in `antigravity` plugin (`session-plugins/antigravity.ts` + `antigravityHooks.ts`, same settings, `restore-session` → `agy -c`, `axn-agy-resume`) targets the Antigravity CLI (`agy`): `SessionStart` → `idle`, `PreInvocation`/`PostToolUse` → `running`, `Stop` → `completed` (`USER_CANCELED`/`ERROR` → `idle`). agy has no permission-request hook event, so no blocked/needs-you signal; `PreToolUse` is deliberately not wired — its required `decision` response would let a passive observer approve tools. The plugin also captures agy's `agy --conversation <id>` exit hint from output into `agyConversationId`, so `axn-agy-resume`/menu resume/`restore-session` can name the exact conversation, falling back to `agy -c` (most recent in the cwd).

- The built-in `vibe` plugin (`session-plugins/vibe.tsx`, opt-in `vibe.enabled: true`) tracks Mistral Vibe sessions without a hook surface — Vibe has no documented lifecycle hooks, so detection is screen/output parsing like the pre-hook devin path: symbol-based task lines (`[ ]`/`[~]`/`[x]`/`[!]`, `○`/`●`/`✓`/`✗`) plus `Task X/Y` progress markers drive `session.tasks`/`progress`/`status` (parsed in a short window after an "updated todo list" marker), a terminal badge reconciles on process end ('completed' persists, else idle) and clears on a new submitted command, session names matching attention patterns (`? vibe`, "action required", …) raise a warning flag + a `!` marker (`vibe.attention` field), and the idle timer flags a quiet session as "waiting for input"/"possibly finished" (`idle-timeout-seconds`, default 45). `/exit` inside vibe arms an 8 s exit-capture that reads the post-exit `vibe -r <name>` resume hint into `vibeSessionName` (+cwd), which powers `restore-session` (`pendingRestore` → `vibe -r <name>`) and `axn-vibe-resume` (with a `cd '<cwd>' &&` prefix when the recorded cwd differs). No `hookSpec` — nothing to bridge.
- The built-in `dev-workflow` plugin (`session-plugins/devWorkflow.tsx`, opt-in `dev-workflow.enabled: true`) is a meta layer above agents: `plugins.yaml` defines workflows (`dev-workflow.workflows.<id>` — `states`, `start`, optional `transitions`, optional `vars` declarations, per-state `steps` as a map of named actions, each with `agent`/`prompt`/`prompt-file`/`command` templates, `run-in: shell|sub-shell|headless` and `auto` to fire on every entry into the step's state (start + later transitions — the on-enter hook); the flat single-action form parses as one anonymous `default` action; every action takes an optional `description` — the reserved `description` key in a named-actions map describes the state itself — shown as the session banner's lighter `detail` text and leading the Run buttons' tooltips). Declared vars are supplied by `axn-workflow start <wf> [arg|key=value]`, card fields, `axn-workflow set`, or the `axn-workflow-var[<token>]:` marker; they substitute into `{{key}}` templates and ride every launched action's env (`KEY=value`, plus `AXN_WORKFLOW`/`AXN_STATE`/`AXN_ACTION`/`AXN_WORKFLOW_TOKEN`). A `command` action's exit code is recorded as an informational check (`pluginState.checks['<state>:<name>']`, never gating) — via a printed `axn-workflow-check[<token>]:` trailer for `shell`, the `ctx.exec` result for `headless`, and the `subshell-exited` code for `sub-shell` (`openSubShell` returns the tab id, `onSubShellExit` resolves it). The state of record lives in the session's `pluginState` (persisted in state.json); an optional `tracking.file` (repo-root-relative or absolute, extension picks `.json` vs YAML) mirrors it as an agent-writable surface — agents can also move the workflow by printing a whole line `axn-workflow-state[<token>]: <state>`, report a check via `axn-workflow-check[<token>]: <name> <rc>`, or fire a named action via `axn-workflow-run[<token>]: <name>`, all adopted from PTY output. `<token>` is a random per-binding secret (`pluginState.token`, minted on bind, dropped on stop) handed only to launched actions as `$AXN_WORKFLOW_TOKEN`/`{{workflow_token}}` — tokenless marker lines (a `cat`ed hostile file) are ignored. Commands `axn-workflow start`/`axn-workflow set`/`axn-workflow move`/`axn-workflow run`/`axn-workflow`/`axn-workflow stop`, start/move/run rows in the session context menu (`sessionMenuItems` — with several workflows a single "Start workflow…" row opens a searchable picker), a banner + under-session state chip, and a rail kanban view whose cards jump to sessions, move states via `sessionApi`, show editable var fields, and stack one run button per action with check badges. A workflow declaring a *required* `kind: mr` var also surfaces a button labelled with the workflow's `title` on glab-mr's MR rows (`mrStartWorkflows`; optional mr vars get none); the var's `when: { role: author|reviewer|other }` limits it to MRs where you have that role — `mrRole` in `forge.ts` (assignee → author, requested/past reviewer → reviewer, nobody assigned → creator author / others reviewer, else other), from the per-MR people cache glab-mr/gh-pr keep (`createMrPeopleCache`, `registerMrResolver`/`useMrDetails` in `mrActions.ts`; overview poll + per-session fetch fill it, one CLI call per miss); a row whose role is unknown offers only workflows without a role condition, starts fill `mr_role`; no workflow ships, so no button appears unless plugins.yaml declares one via the `mrActions.ts` contribution registry: click → fetch the MR head ref (`merge-requests/N/head`, GitHub `pull/N/head`; the same button shows on gh-pr's PR rows; for `axn-workflow start <wf> <mr>` a bare `#N` means a GitHub PR and `!N` a GitLab MR unless the checkout is on GitHub — `reviewFetchRef`), `git worktree add` at the worktrees-plugin location (off the main checkout — a linked-worktree session is mapped back via `--git-common-dir`, `mainCheckoutOf`), `openSession` there, bind the workflow with the MR vars pre-filled. See `docs/dev-workflow.md`. A workflow can link a ticket tracker that is coarser than itself — `tickets: { source?: jira, var?: ticket, status-map: { <tracker status>: <entry state> } }` (`parseWorkflowTickets`; status names verbatim, matched case-insensitively). Each mapped state opens a range up to the next mapped entry state, so one status covers several local states (`ticketRange`); unmapped statuses fall back to the status category (`new` → start, `done` → last state, `indeterminate` → everything between). The status is read from a card enricher's namespaced fields (`<source>.status`/`.statusCategory`), so dev-workflow never imports the tracker; kanban cards (`TicketCardInfo`) show the enricher chips plus a `drift` badge when the session's state lies outside the ticket's range (`ticketDrift`) — informational only, nothing is moved on either side. With a `query` (JQL for jira), the board also lists the tickets no instance of the workflow is bound to yet (`backlogTickets`) as dashed backlog cards in their status's entry state. Queries go through **ticket sources** (`session-plugins/ticketSources.ts` — `registerTicketSource({ id, enabled, search(query) })`, the jira plugin registers one over `POST /rest/api/3/search/jql`, ≤50 results), a shared cache polled every 2 min while the board is open (`useTicketLists`). A card's Start (`startTicket`) picks a main checkout (repo-dir providers + the forge plugins' `repo-roots` + open sessions' repos), reuses or creates `<parent>/worktrees/<repo>-<KEY>` on `wt/<KEY>` off `origin/HEAD` (`ticketWorktreeScript`), opens a session there and stages the binding with `<var>`/`<var>_summary`/`<var>_url` filled, entering at the ticket's entry state (`pendingReviews` carries an optional start state).
- The built-in `agents` plugin (`session-plugins/agents.tsx`, on by default — `agents.enabled: false` disables only the UI) owns **agent personas**: reusable `agents.personas.<name>` bundles in plugins.yaml (`cli` — defaults to the persona name, `model`, `args`, `prompt`/`prompt-file` — the first-message kickoff, `instructions`/`instructions-file` — the persistent identity, `description`; a bare string value is `cli` shorthand). On every ctx touch it mirrors the parsed list into the shared `agentRegistry.ts` module (the `mrActions.ts` contribution pattern — always in the bundle, so the schema stays available even when the plugin is disabled). Consumers: dev-workflow's `agent: <name>`/`{profile: <name>, …overrides}` step references (unresolved names degrade to `cli: <name>`). Launch lines are built by each CLI's registered **launcher** — `registerAgentLauncher` in `agentRegistry.ts`, built-in agent plugins register at module scope, `devWorkflow.agentLaunchLine` consults the registry: claude sends instructions via `--append-system-prompt(-file)`, codex via `-c developer_instructions=…`, devin and unregistered CLIs fold them into the seed prompt, and agy — which only accepts prompts via `-p`/`-i`/stdin — sends the seed through `-i` with instructions folded in (registered under both `agy` and `antigravity`). A launcher's refusal surfaces as session attention. Launch surfaces: `axn-agent <persona>` types the launch line in the current shell (`completeArg` offers persona names), the session and workspace context menus' single "New session with agent…" row opens a searchable persona picker (`pickFromList`, see below) and spawns a persona-named session seeded with the launch line (pending map → `onSessionOpen`, like worktrees; workspace rows use `defaultFolder` as cwd), and the rail bot icon opens a full-area view of persona cards (cli/model/prompt badges, live-session count, Launch button + a "running" session list grouped by workspace in panel order — a non-collapsible tree, so every agent shows where it lives). A launched/typed persona stamps `pluginState.agents.persona`, which drives the bot badge (`agents.persona` field) — the persona survives as the session's identity beyond process detection.
- `session.process` is the foreground process identity: the process-group leader's argv resolved by `process_identity` (`src-tauri/src/lib.rs`) — exact argv tokens from `/proc/<pid>/cmdline` on Linux and `sysctl(KERN_PROCARGS2)` on macOS (comm via `proc_name` when another user's process refuses it), so paths with spaces stay one token; the cwd poll reads `/proc/<pid>/cwd` / `proc_pidinfo(PROC_PIDVNODEPATHINFO)` — the 1 s per-terminal polls never spawn `ps`/`lsof` — argv0 basename, except interpreter launches unwrap to the script (`python3.13 /x/bin/vibe` → `vibe`, `node cli.js` → `cli`, `python -m pkg` → the module). `sessionIcons` keys match this name (lowercased), so script-based tools (uv/pipx CLIs, npm shims) get icons and `processPattern` matches too.
- The `docker` plugin (`session-plugins/docker.tsx`) is a rail-only indicator: the Docker whale SVG icon, running/stopped container counts, and one rounded `BarStrip` triple bar — CPU / MEM / disk strips stacked under a single border, each strip filled with `pressureColor` and its percentage written into the bar (the label renders twice, once in track color and once in `--text-inverted` clipped to the fill, so glyphs flip color where the fill passes under them; per-strip `data-tip` carries the details). CPU and MEM strips show real **VM** pressure when possible — the probe `docker exec`s a read-only /proc snapshot inside the first running container (proc is not cgroup-namespaced, so cpuinfo/meminfo/stat report the VM kernel's numbers on colima/Desktop/podman-machine, host numbers on native Linux; CPU% is the /proc/stat jiffie delta between polls, MEM is MemAvailable-based); container `docker stats` sums are the fallback and stay in the tooltips. Disk likewise prefers `docker exec <cid> df -k /` (the VM's root fs — `df` of the host's `/` reported the macOS disk before). Two `sh -c` probes run via `backend.exec` on separate cadences: the fast per-poll `DOCKER_STATS_CMD` (`docker info` gate, `docker ps -a --format '{{.State}}'` counts, `docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}'` container sums, `docker info --format '{{json .}}'` limits — docker `NCPU`/`MemTotal`, podman `host.cpus`/`host.memTotal` — and the `==vm==` container exec; each failed section prints `unavailable` and degrades to fallbacks) parsed by `parseDockerLive`, and the slow `DOCKER_DISK_CMD` (`docker system df --format '{{.Size}}'` + the df above, `DockerRootDir`/`Store.GraphRoot` host-side fallback) parsed by `parseDockerDisk` — `system df` walks every layer and takes seconds, so it runs only every `DISK_POLL_EVERY` (4) polls (~1 min at the default cadence) and keeps its last values on failure. The rail is session-less: desktop `plugin_exec` ignores the session id, web execs through the first session's host — the plugin hides when docker or exec is unavailable. `docker.refresh-interval-seconds` (default 15, min 5) sets the fast poll cadence; neither probe ever overlaps itself. ≥80/≥90 % disk or memory use raises a warning/critical app attention flag.
- The `axn-dev` plugin (`session-plugins/axnDev.tsx`, Boxes rail icon) is a read-only mirror of `axn-dev list`: a shared `useSyncExternalStore` overview polls `axn-dev list` via `appRuntime().exec` on a `axn-dev.refresh-interval-seconds` cadence (default 30, min 10), parsed by the pure `parseAxnDevList` (global section at indent 2, project sections under `  <repo>:` headers at indent 4, endpoint lines and wrapped descriptions one level deeper — told apart by a URL-ish second token). The rail shows `running/found` (warning triangle when the CLI fails); clicking toggles the plugin view, which lists sections like `axn-dev list` — status dot, name, worktree badge, description, and clickable endpoint links for running scenarios — plus a persisted "running only" filter (`pluginData['axn-dev'].runningOnly`). No start/stop actions; `axn-dev serve` remains the full dashboard. It is also a repo-dir provider (`repoDirs`, below): `axn-dev git repos --json` (axn-dev ≥ the `git repos` command; older CLIs contribute nothing). The older external `plugins/axn-dev-scenarios.mjs` (opt-in, per-session row) is unaffected — different plugin id.
- The built-in `worktrees` plugin (`session-plugins/worktrees.tsx`, opt-in `worktrees.enabled: true`) offers agent worktree isolation without any `axn-dev` dependency — plain `git` argv via `ctx.exec`. `git worktree add <dir> -b wt/<slug>` creates `<repo-parent>/worktrees/<repo>-wt-<slug>` (the axn-dev sibling-worktrees convention, so the CLI discovers them via `git worktree list`; `worktrees.worktree-root` overrides the parent), then `ctx.openSession(dir, slug)` spawns the session there — worktree-first, never a moved running shell. Entry points: session context menu ("New worktree session" / "New worktree with <agent>"), workspace context menu (when `defaultFolder` resolves to a repo), and `axn-worktree [name]`. The new session's `pluginState.worktree = { repoRoot, path, branch }` (stamped on `onSessionOpen` from a pending map, or detected once when a session opens inside a foreign-created linked worktree — e.g. dev-workflow's MR review) drives a `⎇` row badge, "Review worktree changes" (git tab at the path) and "Remove worktree" — `git worktree remove` refuses dirty trees, so failure re-raises the banner with a "Force remove" action, and success offers "Delete branch". The isolation nudge: when `session.process` matches `worktrees.agents` (default `claude, devin, codex, agy, vibe`) in a main checkout (`git-dir == git-common-dir`, probed once per session), a warning banner offers "New worktree session" (seeds the agent's resume command — `claude -c`, `devin -c`, `codex resume --last`, `agy -c`, `vibe -r`), with once-per-session re-raise and a persistent "Don't ask again" (`worktrees.suggest-isolation` gates it). `worktrees.default-agent` picks the seeded agent.
- The built-in `scratchpad` plugin (`session-plugins/scratchpad.tsx`, opt-in — `scratchpad.enabled: true` plus the `scratchpad.patterns` setting, which has no default: `;`- or newline-separated `<repo-regex>: <dir>, <dir>` entries, e.g. `*: .local-drafts, drafts; axn-term: .ai, notes`; an entry without a repo part applies to all repos). The regex matches case-insensitively against the checkout dir basename AND the remote repo name, so one entry covers a repo and all its worktrees (`axn-term` also matches `axn-term-feat-foo`). Matching dirs union in order; the first *existing* dir is `primary` (else the first configured). Its in-panel surface is the session context menu only: one `Open <dir>/` row per configured folder (read from `pluginState.dirs` — sessionMenuItems is synchronous, so `onSessionOpen` and a debounced onOutput refresh resolve+store the dirs — falling back to a single "Open drafts" row before the first resolution), plus "New or open draft…" (`pickOrCreate`), "Copy agent hint" and "Tell agent about scratchpad". Drafts are plain files — agents read/write them with their own tools (filesystem-as-context), the plugin only has to say where they are: `axn-scratch ls|dir` echoes real paths into the scrollback, `axn-scratch hint` prints a paste-able AGENTS.md/CLAUDE.md hint, "Copy agent hint" puts it on the clipboard and "Tell agent about scratchpad" (offered when `agentInput` or an agent-ish process is foreground) types it into the session input *without* a newline. Creating a draft (`axn-scratch new <name>` or a bare name) mkdirs the primary dir, seeds a `*` `.gitignore` (self-ignoring folder — `scratchpad.gitignore-drafts` gates it) and opens the file in an editor tab; `axn-scratch open <name|n>` and bare names open existing drafts, `browse` opens the folder. Beyond the menu there is a `NotebookPen` rail icon opening the `hostsTabs` full-area view: drafts grouped by repo across all sessions, per-repo "copy hint" buttons, editor/browser hosted tabs (listings go through `PluginApi.listDir`, which resolves `null` where the backend lacks `listDir`).
- The built-in `progress` plugin (`session-plugins/progress.ts`) scans the session's live screen (`ctx.getScreenLines()`, backed by the xterm registry in `terminalRegistry.ts`) for progress indicators (`45%`, `[###---]`, `3/10`) instead of guessing from the output stream. When several bars are on screen the bottom-most one is reported; an indicator must persist ~500 ms before it is shown, and `session.progress` is withdrawn once no bar remains on screen. Only allowlisted programs are tracked: `progress.include-processes` in `plugins.yaml` (exact, case-insensitive process names; `'*'` tracks every program) — unset, it defaults to `DEFAULT_INCLUDED_PROCESSES` (curl/wget/rsync/pv/dd, pacman/apt/dnf/pip/uv/cargo/npm/pnpm/yarn/bun, git, ffmpeg), so percent-like noise from anything else (brew, build logs) never becomes a bar. Exclude programs on top via `progress.exclude-processes: [docker]` (case-insensitive substring match on the foreground process). A built-in list (`BUILTIN_EXCLUDED_PROCESSES`) already covers full-screen monitors/pagers/editors (`top`, `htop`, `vim`, `less`, …) and matches the comm basename exactly.

## Restore verification

- Desktop unit tests: `pnpm --filter @axn-term/desktop test`.
- Typecheck: `pnpm exec tsc --noEmit` from `apps/desktop`.
- Build the embedded production frontend with `pnpm --filter @axn-term/desktop tauri build --bundles deb`; plain `cargo build --release` can still point at Vite's dev URL.
- Run a desktop restore flow with `axn-dev flow -f flows/axn-term-restore-second-workspace.xml --adapter axn-term=flows/adapters/axn-term.js`. Flows use isolated temporary state; an explicitly provided state directory must not already exist.
- Flows drive the app through its remote-control HTTP server (`AXN_TERM_REMOTE_CONTROL_PORT`). It only starts together with `AXN_TERM_REMOTE_CONTROL_TOKEN` (removed from the app's env, so PTYs never inherit it): every endpoint but `GET /health` requires `Authorization: Bearer <token>`, and requests whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>` are rejected (DNS-rebinding guard). The adapter generates a token per run. The per-session output buffer behind `GET /sessions/<id>` (last ~200 KB) is only kept while the server is enabled.
- The talk-tab resume flow is `flows/axn-term-talk-restore.xml` (seeded `agent` shell tab → `/exit` capture → `devin -r <name>` on reopen; plus the `devin -c` fallback when the app is killed mid-session).
- The worktrees-plugin flow is `flows/axn-term-worktrees.xml` (temp git repo + `worktrees.enabled`; `POST /sessions/<id>/command` submits `axn-worktree <name>` through the frontend dispatch — unlike raw `/write` — then a fake `devin` launch in the main checkout must raise the isolation banner). Like the other flows it runs `target/release/axn-term` from `tauri build` — a plain `cargo build`/`cargo test` binary loads the Vite dev URL, so without `pnpm dev` no frontend starts and no session ever appears.
- On macOS the bare `target/release/axn-term` binary cannot host WKWebView (the web content process dies at window creation); the adapter automatically prefers `target/release/bundle/macos/axn-term.app/Contents/MacOS/axn-term` next to `AXN_TERM_BINARY`, so run `tauri build --bundles app` once after frontend changes.
- The flow adapter writes a `$SHELL` shim (`bin/axn-login-shell`) into the state dir: command sub-shells run `sh -c` with `login_shell_path()` — the login-shell PATH, not the app's env PATH — so the fake `devin` would be invisible without it. The shim answers the `-l -i -c env` probe with the flow bin dir prepended and (for zsh) routes startup through a proxy `ZDOTDIR` that re-sources the user's real dotfiles then re-prepends the bin dir, keeping the fake binaries first even after profiles rebuild PATH.
- Run the real flow with `AXN_TERM_DEVIN_SESSION=<available-session> axn-dev flow -f flows/axn-term-restore-real-devin.xml --adapter axn-term=flows/adapters/axn-term.js`. The adapter verifies the exact configured name before reopening. Do not remove locks or close unrelated Devin instances to run it.
- Devin CLI v3000.10.27 treats a combined `/exit\r` write as pasted multiline input rather than submission. Type `/exit`, allow the input to settle, and send `\r` separately. A shell-script stand-in does not reproduce this input behavior.
- Devin name capture: an authoritative capture is armed immediately before the separate Enter submits `/exit` (or by `onClose`'s Ctrl-C×2) and consumes only subsequent output chunks. For exits the plugin did not drive (manual Ctrl-C×2, `/quit`), `onProcessEnd` instead parses the newest resume line out of a bounded 16 KB output *tail* and arms a short passive capture for chunks still in flight — a passive capture adopts a seen name but never erases a stored one. Never use a scrollback length/offset as a capture cursor: scrollback is capped at 200,000 characters.
- Devin CLI ≥3000.11 prints the exit resume hint on two lines (` devin -r <name>` then ` resumes this session · devin -r lists recent sessions`); older versions print `Resume this session with \`devin -r <name>\`` on one line. `findDevinSessionName` matches both.
- OS session teardown (logout/restart/shutdown → SIGTERM/SIGHUP) is flagged via `signal-hook` and emitted as `os-shutdown`; the frontend runs the normal collect-and-close path without the confirm modal. A 15 s watchdog exits anyway if the frontend never finishes, so shutdown is never stalled. App-level quit (Cmd+Q / menu Quit / `app.exit`) arrives in Rust as `RunEvent::ExitRequested` while windows still exist — it is *not* routed through per-window `CloseRequested` — so the run handler intercepts it with `prevent_exit`, emits the same `os-shutdown`, and arms the same 15 s watchdog; each window then flushes state and `destroy()`s itself, and the resulting last-window-closed `ExitRequested` (window map empty) is allowed to proceed.
- Window-close semantics (`CloseConfirmModal` in `ShellApp`): with one window, closing saves its sessions as before. With other windows open (`otherWindowWorkspaces` non-empty — peers announcements, not a Rust query) the modal is a choice: "Close this window" runs `removeAndClose`, which kills every session PTY in the window (`backend.close` per session — sub-shell trees die with their parent; `destroy()` runs no React teardown so nothing else would release them), deletes the window's `state.json` entry, then destroys the window — the sessions end for good and are not restored. "Close all & save" broadcasts `close-now` over `peers` so every window runs its own collect+save+destroy path (the remote-control `POST /close` uses the same event) — the 10 s countdown and Enter default to it; Escape/Cancel keeps everything open. `closeNow` also kills the window's PTYs after the save (`killWindowSessions`) — saved sessions restore with fresh PTYs anyway — and the session-exit/sub-shell-exit handlers ignore exits while `closingRef` is set, so teardown kills can't mutate or re-save state.
- No child outlives the process: `RunEvent::Exit`, the exit/shutdown watchdogs and the remote `/close` force-exit all call `pty::kill_all_sessions` — SIGHUP, SIGKILL after `CLOSE_GRACE` — because `std::process::exit` skips destructors and a webview `destroy()` never releases PTY leases. `RunEvent::Exit` also `stop_vite`s the axn-term-hmr dev server. On a hard crash (SIGKILL, segfault) the kernel closes the PTY master fds, which SIGHUPs each session's controlling-terminal group — the OS-level guarantee that needs no code in the dying parent.

## macOS Local Network permission & code signing

Since macOS 15 the Local Network privacy filter blocks spawned shells from
reaching LAN peers (gateway works, everything else is `No route to host`)
unless the *responsible app* — axn-term itself — is granted
*System Settings → Privacy & Security → Local Network*. Two things make the
grant stick:

- `src-tauri/Info.plist` declares `NSLocalNetworkUsageDescription` (and
  `NSBonjourServices`); without the usage-description key macOS denies
  silently — no prompt, dead connections.
- The app must carry a **stable code signature**: TCC tracks identity via the
  signature and adhoc builds change their cdhash on every rebuild, so an
  enabled toggle silently stops matching. `bundle.macOS.signingIdentity` in
  `tauri.conf.json` points at `axn-term Code Signing`, a self-signed
  code-signing certificate (EKU `codeSigning`) in the login keychain, trusted
  via `security add-trusted-cert -p codeSign`. On a machine without that
  cert the build falls back to needing `APPLE_SIGNING_IDENTITY`/a
  Developer-ID identity — or re-sign the installed `.app` by hand:
  `codesign --force --deep --sign "axn-term Code Signing" /Applications/axn-term.app`.
  `tauri dev` binaries keep an adhoc linker signature, so dev-mode sessions
  may still lack LAN access — sign `target/debug/axn-term` the same way to
  fix a dev instance.

Full details + the Developer-ID/notarization publishing roadmap:
`docs/macos-packaging.md`.

## Packaging on Arch

`tauri build --bundles deb`, then repackage via `/tmp/axn-pkg/PKGBUILD` (`ar x` + `bsdtar -xf data.tar.gz -C "$pkgdir"`). Install with `sudo pacman -U /tmp/axn-pkg/axn-term-*.pkg.tar.zst`.

## Merge request workflow

Do not push directly to `develop` or `main`. Always create a feature branch, push the branch, open a merge request, and stop for the user to review. Do not auto-merge merge requests; wait for the user to merge after review.

# UI design tokens (chrome)

The app chrome (rail, session panel, tab strips, plugin view headers, dialogs) is styled from a small token set in `libs/shell-ui/src/styles.css`. Tokens are **derived in CSS** from the theme values `applyTheme()` sets (`color-mix`), so theme files need no changes; a theme may pin one through the optional `ui` keys `chrome`, `raised`, `elevated`, `attention`.

- Fonts: `--font-ui` (system UI stack, override via the `uiFontFamily` setting) for all chrome; `--font-mono` only for the terminal, the editor and inline code (`font-mono`). Sentence case, no `uppercase`; 11px is the smallest text (10px for numeric badges).
- Surfaces: `--chrome` (rail, session panel, window base), `--bg` (content pane), `--raised` (cards on it), `--elevated` (menus, tooltips, dialogs).
- Lines and states: `--hairline` / `--hairline-strong` between regions (no boxed controls), hover `--fill-1`, pressed / active tab `--fill-2`, selection `--fill-accent`, "needs you" `--attention` / `--fill-attention`, focus `--ring` (global `:focus-visible`).
- Metrics and motion: `--rail-w`, `--toolbar-h`, `--radius-sm|md|lg|xl`, `--dur-1|2`.
- macOS overlay title bar: `data-titlebar="overlay"` on `<html>` (set in `apps/desktop/src/app/titlebar.ts`) turns on `--titlebar-h` / `--titlebar-overhang`, the room the rail and the session-panel toolbar leave for the traffic lights.

Shared pieces to reuse instead of ad-hoc class strings: `app/chromeStyles.ts` (strip, ghost / primary / secondary buttons, field), `app/RailItem.tsx` (rail slots — plugins render it from `renderRail`), `app/PanelHeader.tsx` (plugin view header), `app/EmptyState.tsx` (empty and setup states), `tabStripClasses` / `tabStripTabClasses` in `app/tabStyles.ts`.

## Rail, session panel toggle and their shortcuts

The rail holds tools only: one item per plugin view — or one per entry for a plugin declaring `railEntries` (view key `pluginId/entryId`, `app/railOrder.ts`; e.g. the `external-views` plugin, one item per configured or runtime-opened web page) — Settings at the bottom behind a hairline. The rail order, ⌘N numbering, the active view and `app/viewHost.ts` (`openView`/`selectView`/`activeView`, per window) all work on view keys; unranked entries sort after every unranked plugin so they never take an existing item's number, and runtime entries are never saved. A plugin declaring `keepViewMounted` keeps each opened view mounted (hidden, `inert`) while another view or a session shows. Window-chrome shortcuts live in `app/shortcuts.ts`, are handled on `window` (capture) by ShellApp, and terminals let them through (`isAppChromeShortcut` next to `isAppNavigationShortcut` / `isReloadShortcut` in the custom key handlers of `ShellTerminal.tsx` and `SubShellView.tsx`):

- `⌘1`…`⌘9` (`Ctrl+1`…`Ctrl+9` on Linux/Windows) open the 1st…9th rail view in the order shown; pressing the active view's shortcut returns to the session. The numbering follows the rendered rail (`railViewIds` in `app/railOrder.ts`): slots without a view, and slots whose plugin renders no item, take no number. Each item's tooltip shows its shortcut (`RailShortcutContext`). `⌘0`/`Ctrl+0` is not a rail shortcut and is never shown as one: it stays View → Actual Size in the app menu, so there are nine rail shortcuts.
- `⌃⌘S` (`Ctrl+Shift+S`) shows/hides the session panel. The toggle button sits in the title-bar row right of the macOS traffic lights; without that row (no overlay title bar, fullscreen) and with the panel closed it falls back to the top of the rail. While the panel is closed it carries the count of raised attention flags.
- `⌘,` / `Ctrl+,` is the app menu's Preferences… accelerator (`apps/desktop/src-tauri/src/lib.rs`), not a page shortcut. It toggles the same in-app settings dialog as the gear at the bottom of the rail: the native side picks the shell window (`window::settings_target` — the focused one, else `main`) and emits `menu-settings` to that window only; `App.tsx` forwards it as `axn:menu-settings`, ShellApp toggles the dialog. The standalone settings window opens only when no shell window is open.

Attention lives in the session panel's toolbar: "N waiting" filters the list to sessions with a raised flag (click again to clear); flags that belong to no session get a warning button that opens `AttentionModal`.

## Session panel status stack and rail tooltips

Numbers that are read, not clicked, do not go into the rail or its tooltips: the machine's meters (memory, swap) and the statistics of the rail tools (docker containers and VM, open merge requests, running scenarios, personas, …). A plugin publishes one group with `publishPanelStatus(pluginId, group)` (`app/panelStatus.ts`) from a component it keeps mounted — next to its rail item with the `PublishPanelStatus` helper (`app/PanelStatusSection.tsx`), or from the headless `panelStatus` hook of `SessionViewPlugin`, which ShellApp mounts while the plugin is enabled (also the place for a status plugin's app attention flag). A group with nothing to show is not published.

`PanelStatusSection` draws the groups above the panel footer as a flat stack of top-level accordions, there is no parent header: one accordion per tool in rail order (`splitPanelStatus`), then "System" last, which collects the groups published with `system: true` (host metrics only; the docker VM belongs to Docker). A header is one line: chevron, icon (the plugin's `logo`, else the group's `icon`, a Lucide name), name and, while collapsed, the "label value" pairs that fit, warnings first. Expanded, each meter gets a bar or its explanation. The stack takes at most 40% of the panel height and scrolls on its own beyond that. Window state: `pluginData['axn-panel']` holds `systemExpanded` (System, default open) and `expandedGroups` (source ids of the open tool accordions, default none).

Each publishing plugin's `statusDisplay` (plugins.yaml, Settings → Plugins → Status display; `resolveStatusDisplay` in `app/panelStatus.ts`) picks where its status shows: `panel` (its accordion) or `rail` (rail only — the `renderRailDetail` item where the plugin has one, else just its plain icon; the accordion is dropped via `hiddenStatusSources`). Unset/`auto` is the rail on touch devices for detailed items, the panel otherwise. Settings offers the choice for every plugin with a detailed rail item or a currently published group.

Rail tooltips are short and appear to the right of the item (`data-tip-side="right"`, placed by `placeTooltip` in `app/tooltipPlacement.ts`, clamped to the window and kept out of the title-bar strip): the tool's name with its shortcut — "Docker (⌘3)" — and at most one status line (`RailItem`'s `status`, e.g. "2 waiting for you").
