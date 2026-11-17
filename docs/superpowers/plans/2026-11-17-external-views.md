# External Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugins can contribute several rail items; a built-in `external-views` plugin shows any
`http(s)` page in a kept-mounted iframe view; views open at runtime through one host API reachable
from hidden commands, the control socket and plugins; the mr-dashboard hub can be framed.

**Architecture:** The rail and the active view move from "plugin id" to a *view key* (`pluginId` or
`pluginId/entryId`). A per-window module store (`app/viewHost.ts`) owns runtime entries, the
selection mirror and `viewChanged`; ShellApp registers the real selector into it. App-level
commands are plugin commands with an `appRun` handler; a secret-free control message reaches only
those.

**Tech Stack:** React 19 + TypeScript (vitest), Tauri 2 / Rust (cargo test), Python 3 stdlib
(unittest) for the hub.

**Spec:** `docs/superpowers/specs/2026-11-17-external-views-design.md`

## Global Constraints

- Lands after PR #11; no PR created. Commit on `feat/external-dashboards` (conventional commits).
- View key: `pluginId` or `pluginId/entryId`; entry ids never contain `/`.
- Existing rail items never change ⌘N number because entries appear.
- Runtime entries: in memory per window, random ids, never in `pluginData['axn-rail']`, never in
  `plugins.yaml`; `activeView()` payload has no URL.
- URLs: `http:`/`https:` only.
- New sandbox methods `openView`, `selectView`, `removeView` need `sessions`; `getActiveView` needs
  none. (`closeView` already means "leave the plugin view" in the sandbox, so removal is
  `removeView` — spec D's `closeView` is renamed.)
- App-level control message accepts only commands declaring `appRun`; desktop only.
- Lingui for user-visible strings in shell-ui (`<Trans>` / `t`), as the surrounding code does.

## Review Focus

1. Disabling `external-views` while one of its views is active → falls back to the session (no
   blank main area). Test in Task 4.
2. `openView` called twice with the same URL → one rail item, selected. Test in Task 2.
3. A runtime entry present during a rail drag → its key is not persisted. Test in Task 1.
4. A hand-edited `plugins.yaml` with a `javascript:` URL → entry dropped, never framed. Test in
   Task 5.
5. `axn-term command` to a window label that does not exist → error reply, nothing runs. Test in
   Task 6.

---

### Task 1: View keys and rail slot order (`railOrder.ts`)

**Files:** Modify `libs/shell-ui/src/app/railOrder.ts`; Test `libs/shell-ui/src/app/railOrder.test.ts`

**Produces:**
- `viewKey(pluginId: string, entryId?: string): string`
- `parseViewKey(key: string): { pluginId: string; entryId?: string }`
- `interface RailSlotLike { key: string; entry?: boolean; runtime?: boolean }`
- `orderRailSlots<T extends RailSlotLike>(slots: readonly T[], pluginData): T[]` — ranked keys
  (saved order) first; then unranked non-entry slots in input order; then unranked entry slots in
  input order.
- `railOrderAfterDrop(renderedIds, storedOrder, dragId, dropIndex, transient?: ReadonlySet<string>)`
  — ids in `transient` never appear in the result.

- [ ] Tests: `parseViewKey('external-views/abc')` → `{pluginId:'external-views', entryId:'abc'}`;
  `parseViewKey('docker')` → `{pluginId:'docker'}`; with no saved order, `[jira, ev/e1, ev/e2, docker]`
  (entries flagged) orders as `[jira, docker, ev/e1, ev/e2]`; saved order `['jira']` + docker
  unranked → `[jira, docker, ev/e1]`; a sandbox plugin last in input stays before entries;
  `railOrderAfterDrop([...,'ev/rt'], …, transient={'ev/rt'})` result excludes `'ev/rt'` and an
  existing stored transient id is dropped too.
- [ ] Run `pnpm vitest run libs/shell-ui/src/app/railOrder.test.ts` → FAIL; implement; → PASS.
- [ ] Update the file header comment (order is over view keys). Commit.

### Task 2: View host store (`app/viewHost.ts`)

**Files:** Create `libs/shell-ui/src/app/viewHost.ts`, `libs/shell-ui/src/app/viewHost.test.ts`

**Produces:**
- `interface RuntimeView { id: string; url: string; title: string; logo?: string }`
- `interface ActiveView { key: string; pluginId: string; entryId?: string; title: string; runtime: boolean }`
- `isWebUrl(raw: string): boolean` (http/https absolute only)
- `runtimeViews(): RuntimeView[]`, `useRuntimeViews(): RuntimeView[]`
- `openView(args: { url: string; title?: string; logo?: string }): string` — throws on bad URL;
  reuses an entry with the same URL; selects it; returns its key `external-views/<id>`.
- `selectView(key: string | null): boolean`, `removeView(key: string): boolean`
- `activeView(): ActiveView | null`, `onViewChanged(cb: (v: ActiveView | null) => void): () => void`
- `registerViewHost(impl: { select(key: string | null): boolean; describe(key: string): Omit<ActiveView,'key'> | null }): () => void`
- `publishActiveView(key: string | null): void` — ShellApp calls it on every change; fires
  `viewChanged` only when the key changed.
- `EXTERNAL_VIEWS_ID = 'external-views'`

- [ ] Tests: `openView` same URL twice → one runtime view, both return the same key; bad URL
  (`javascript:alert(1)`, `data:x`, `/rel`, `''`) throws; `removeView` on a runtime key removes it
  and selects null if it was active; `publishActiveView` twice with the same key fires once;
  `activeView()` result has no `url` property; `selectView` with no host registered → false.
- [ ] FAIL → implement (module-level state + listeners, `useSyncExternalStore`) → PASS. Commit.

### Task 3: Plugin contract types (`session-plugins/plugin.ts`)

**Files:** Modify `libs/shell-ui/src/app/session-plugins/plugin.ts`

**Produces (types folded into Tasks 4–7, no behaviour here):**
- `interface RailEntry { id: string; title: string; logo?: string; runtime?: boolean }`
- `SessionViewPlugin.railEntries?: (ctx: { pluginSettings: unknown }) => RailEntry[]`
- `SessionViewPlugin.keepViewMounted?: boolean`
- `renderView` ctx gains `entryId?: string; active: boolean`
- `interface PluginAppCommandContext { pluginSettings: unknown; openView; selectView; removeView; activeView }` (the viewHost functions)
- `PluginCommand.appRun?: (ctx: PluginAppCommandContext, arg: string | undefined, line: string) => string | false | void | Promise<string | false | void>`
- `PluginApi` gains `openView`, `selectView`, `removeView`, `activeView`, `onViewChanged` (bound to
  viewHost in `createPluginApi`).

- [ ] Add the types and wire `createPluginApi`; `pnpm nx run shell-ui:typecheck` (or `pnpm tsc -p libs/shell-ui`) passes. Commit with Task 4.

### Task 4: ShellApp — rail slots, view key, kept-mounted views

**Files:** Modify `libs/shell-ui/src/app/ShellApp.tsx`; Create `libs/shell-ui/src/app/keptViews.ts` + test

**Consumes:** Task 1, 2, 3.
**Produces:** `nextKeptViews(prev: string[], active: string | null, keep: (key) => boolean, valid: (key) => boolean): string[]`

- [ ] Tests for `nextKeptViews`: activating a keepable key appends it once; non-keepable never
  added; a key whose entry/plugin vanished (`valid` false) is dropped; order preserved.
- [ ] ShellApp: build `railSlots` (pinned + ordered) from enabled plugins — plugins with
  `railEntries` expand to one slot per entry (key via `viewKey`, `entry: true`,
  `runtime: entry.runtime`); host renders entry items as `RailItem` + `PluginIcon` (entry logo,
  else `globe`), title + shortcut tooltip, `active` = key is active. `data-rail-slot` = key.
  Drag/drop over keys; pass runtime keys as `transient`. Rail attention for entries uses the
  plugin id.
- [ ] `activePluginView` holds a view key. View lookup via `parseViewKey`; an invalid key (plugin
  disabled, entry gone) resolves to no view. ⌘N, `selectAdjacentTab` (plugin lookup by
  `parseViewKey(key).pluginId`; `pluginTabs` stay keyed by plugin id) and `onOpenPluginView`
  keep working with keys.
- [ ] Kept views: state `keptViews` updated with `nextKeptViews`; the main area container gets
  `relative`; each kept key renders its plugin's `renderView({... entryId, active})` in an
  `absolute inset-0` wrapper, `invisible` + `inert` + `aria-hidden` when inactive; the existing
  single-view block renders only non-kept plugins. On hide of the active kept view, focus moves to
  `document.body` (the terminal refocuses on selection as today).
- [ ] `registerViewHost` with `select = setActivePluginView` (validating the key) and `describe`
  (title from entry or plugin); `publishActiveView(activePluginView)` in an effect.
- [ ] Run `pnpm vitest run libs/shell-ui` → PASS (existing rail tests included). Commit.

### Task 5: Plugin `external-views`

**Files:** Create `libs/shell-ui/src/app/session-plugins/externalViews.tsx`,
`libs/shell-ui/src/app/session-plugins/externalViews.test.ts`; Modify
`libs/shell-ui/src/app/session-plugins/index.ts` (register)

**Produces:**
- `interface ExternalViewEntry { id: string; title: string; url?: string; urlCommand?: string; logo?: string }`
- `normalizeViews(raw: unknown): { views: ExternalViewEntry[]; dropped: string[] }`
- `externalViewsPlugin: SessionViewPlugin` — `id 'external-views'`, `defaultEnabled: false`,
  `logo: 'globe'`, `keepViewMounted: true`, `railEntries` = settings views + `runtimeViews()`
  (flag `runtime`), `renderView`, `renderSettings`, `commands` (Task 6 adds `appRun`).

- [ ] Tests: `normalizeViews` — duplicate ids regenerated, missing id generated, id with `/`
  regenerated, `javascript:`/`data:`/relative/blank `url` with no `urlCommand` dropped (listed in
  `dropped`), valid entry kept untouched; `urlCommand` entry with no `url` kept.
- [ ] View component: header (title, `new URL(url).host`, reload, open in browser via the app's
  external opener — `services.openExternal`/the link opener used by terminal links, else
  `window.open`; close for runtime), iframe `sandbox="allow-scripts allow-same-origin allow-forms
  allow-popups"`, `key={entry.id + url}`; `urlCommand` resolved with `backend.exec` (desktop),
  output must pass `isWebUrl`, else error state (`EmptyState`) with Retry / Open in browser;
  posts `{ axn: 'view-visibility', visible: active }` to `iframe.contentWindow` on change.
- [ ] Settings form via `renderSettings` (list rows: title, URL, URL command, icon; add/remove).
- [ ] `pnpm vitest run …/externalViews.test.ts` → PASS. Commit.

### Task 6: App-level commands (`axn-views …`, control socket, CLI)

**Files:** Modify `useSessionCommands.ts`, `externalViews.tsx`,
`libs/shell-ui/src/platform.ts`, `apps/desktop/src/app/platform.ts`,
`apps/desktop/src-tauri/src/{control.rs,remote.rs,cli.rs}`; tests next to each.

**Produces:**
- `handleAppCommand(line: string): Promise<ControlReply>` — only commands with `appRun`; else
  `{ ok:false, error:'not an app-level axn-term command: <word>' }`.
- Session dispatch: a command with `appRun` and no `run` runs `appRun` (typed lines work too).
- `ShellPlatform.onAppCommand?(cb: (cmd: { line: string }) => Promise<ControlReply>): Unsubscribe`
  — desktop listens to `control-app-command` `{ requestId, window, line }`, answers only when
  `window === appWindow.label`.
- Rust: `Incoming::App { app: AppRequest { line, window: Option<String> } }`; `serve` gets an
  `app_dispatch: Fn(u64, &str, Option<&str>) -> Result<(), String>`; remote.rs resolves the target
  (`--window` must name an open shell window, else `settings_target`; `None` → error
  "no axn-term window") and emits `control-app-command`. `cli.rs`: `axn-term command [--window
  <label>] <line>` (line must start with `axn-`), prints `message`/`error`, exit 0/1.
- `axn-views open <url> [title]`, `select <key|title>`, `close <key>`, `current` with `appRun`;
  replies via `echo "<json-quoted>"` (existing `controlReply` convention).

- [ ] Rust tests (control.rs): app line reaches `app_dispatch` without a secret; dispatch error →
  error reply; `{"app":{...}}` with a malformed body → "malformed request". cli.rs: parse of
  `command --window w-2 axn-views current`; non-`axn-` line refused.
- [ ] TS tests: `handleAppCommand` refuses a command without `appRun` and runs one with it;
  `axn-views open javascript:x` → error reply; `axn-views current` → message is JSON of
  `activeView()`.
- [ ] `cargo test -p axn-term control cli` and vitest → PASS. Commit.

### Task 7: Sandbox API

**Files:** Modify `libs/plugin-sdk/src/{permissions.ts,contract.ts,api.ts,shim.js}`,
`libs/shell-ui/src/app/session-plugins/sandbox.tsx`; tests in the existing sandbox/permissions tests.

- [ ] `METHOD_PERMISSIONS`: `openView`, `selectView`, `removeView` → `sessions`. Dispatch cases in
  the session-less switch. `getActiveView` → `activeView()`. HostMessage
  `{ type: 'viewChanged'; value }` posted to logic and view frames on `onViewChanged`; shim emits
  `viewChanged`; `AxnClient` gains `openView`, `selectView`, `removeView`, `getActiveView`;
  `AxnLogicEvent`/`AxnViewEvent` gain `'viewChanged'`; `permissions.ts` `sessions` doc lists them.
- [ ] Tests: `methodPermission('openView'|'selectView'|'removeView') === 'sessions'`;
  `methodPermission('getActiveView') === undefined`; sandbox dispatch refuses `openView` without
  `sessions` (existing harness pattern). PASS. Commit.

### Task 8: Docs (axn-term)

- [ ] `AGENTS.md` (both copies): rail "one item per plugin view" → entries; control section (app
  messages, `axn-term command`); permissions list. `docs/agents.md` control section;
  `docs/architecture.md:85`; `control.rs` module doc. Commit.

### Task 9: mr-dashboard (ai-team-claude-plugin, new branch off `feat/launchpad-mr-dashboard-plugins`)

Worktree `/Volumes/MgnlDevExtended/Mgnl/Git/worktrees/mr-dashboard-axn-term-embed`, branch
`feat/launchpad-axn-term-embed`.

- [ ] Tests (`plugins/mr-dashboard/tests/test_launchpad.py` style): `/t/<good>/d/mr/<page>` → 200;
  `/t/<bad>/…` → 403; `/t/<good>/../…` → 404; POST under `/t/` → 403/405;
  `frame-ancestors` header = `'self'` with empty setting, `'self' http://localhost:1420` with one
  origin; malformed origin rejected by `settings.validate`; `launchpad url mr` prints a
  `/t/<token>/d/mr/` URL.
- [ ] Implement in `server/http_api.py`, `server/settings.py` (`frameAncestors: []` in
  `DEFAULTS`), `server/hub.py` (`url` subcommand; `open --axn-term`), `server/launchers.py`
  (`axn_term_show(url, title)` locating `AXN_TERM_CLI` / `axn-term` / app bundle).
- [ ] `web/src/lib/api.ts`: token from `/t/<token>/` path → `X-Launchpad-Token`; asset base
  relative; `view-visibility` listener feeding the visibility logic; `pnpm build` in `web/`,
  commit `dashboard/app`. README (security, settings, commands). Tests PASS. Commit.

### Task 10: Live check (the spike)

- [ ] With the hub change and a dev axn-term: open the dashboard via `launchpad open mr --axn-term`
  and via a settings entry with `urlCommand: launchpad url mr`; record the parent origin the hub
  sees (log `Referer`/`Sec-Fetch-Dest` once) and whether `frame-ancestors` with that origin loads.
  Release origin (`tauri://localhost`) needs a release build — ask the user to run it if not
  feasible here. If WebKit refuses every origin, stop and report.
