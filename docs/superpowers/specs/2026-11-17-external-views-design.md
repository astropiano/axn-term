# External views: one plugin, many rail items

## Intent

Let axn-term show any web page as a full-area view reached from the rail, starting with the
`mr-dashboard` hub (`plugins/mr-dashboard` in the ai-team-claude-plugin repo, MR !23,
`feat/launchpad-mr-dashboard-plugins`, as of `2acacde`). Today that dashboard opens in the browser
or, via `agtermctl`, in agterm's native web view; the user wants it inside axn-term. The general
mechanism is a plugin that holds a list of URLs and puts one rail icon per URL in the rail, plus a
runtime API that opens a view on request. That needs a host capability axn-term lacks: one plugin
contributing several rail items.

## Base

This builds on the tools-only rail of open PR #11 (UI redesign), present on this branch as copies
of its commits. It lands **after #11**; no PR is created yet. All axn-term anchors below are at
this branch (`feat/external-dashboards`); mr-dashboard anchors are at `d3109a3`, unchanged in the
cited files at `2acacde`.

## Goals

- A built-in plugin `external-views`, disabled by default (`defaultEnabled: false`), whose
  `plugins.yaml` section lists views: `views: [{ id, title, url?, urlCommand?, logo? }]`.
- Each entry gets its own rail item (icon, tooltip, ⌘1–9 slot, draggable position) and opens its
  page full-area in an iframe.
- Host capability: `SessionViewPlugin.railEntries` lets any plugin contribute several rail items,
  each with its own view. Reusable beyond this plugin.
- One host function, `openView`, opens (or re-selects) a view at runtime, reachable from a hidden
  command, the app-level control socket, and the plugin API. The current selection is readable.
- The `mr-dashboard` hub can be framed by axn-term when the user opts in, and pushes itself into
  axn-term the way it does into agterm.

## Non-goals

- No bridge from the **embedded page** into axn-term: the framed page cannot open sessions, write
  to a PTY, notify or select anything. (Processes outside — including the hub's own CLI — can
  open and select views through the opted-in `axn-views` commands; that is the only app-level
  path, see D.)
- No native child web view (approach 2).
- No change to existing plugins' rail behaviour or ids.
- Web build: the app-level control entry and `urlCommand` are desktop only.

## Anti-goals (would be a failure even if it works)

- Embedding that opens the hub to any framing page by default.
- Reloading a dashboard and losing its state whenever the user switches away and back.
- Adding entries shifting the ⌘N numbers of existing rail items.
- A hub token persisted anywhere by axn-term (window state, `plugins.yaml`, rail order) or handed
  to plugins that did not ask for it.

## Constraints (verified in code at this branch unless noted)

- The open view is one string, `activePluginView` (`ShellApp.tsx:306`, `useState`, not persisted).
  Readers that assume it is a plugin id: rail items' `viewActive`/`toggleView` (`:788-790`), the
  ⌘N toggle (`:421`), `selectAdjacentTab` (`:1444-1448`, also indexes `pluginTabsRef` by it), the
  view lookup `p.id === activePluginView` (`:2440-2441`), and `onOpenPluginView` (`:2826`).
- Only the active plugin's view is mounted (`{viewPlugin?.renderView && …}`, `ShellApp.tsx:3009`):
  switching away unmounts it today. Nothing in the app keeps a plugin view mounted.
- Rail order: `pluginData['axn-rail'].order`, written only on drag (`dropRailPlugin`,
  `ShellApp.tsx:356-364`); `orderRailPlugins` ranks saved ids first and leaves the rest in
  registration order (`railOrder.ts:22-31`); `railOrderAfterDrop` keeps stored ids that are no
  longer rendered (`railOrder.ts:46-55`). ⌘N counts rendered `[data-rail-slot]` elements that have
  `data-rail-view` (`railViewIds`, `railOrder.ts:81`; `ShellApp.tsx:389`).
- `setAppAttention(plugin.id, …)` keys rail attention by plugin id.
- `renderSettings` (`PluginSettingsViewContext`, `plugin.ts:447`) is consumed only by
  `SettingsModal.tsx`; its `update(patch)` persists `plugins.yaml`
  (`PluginSettingsProvider.tsx:193-209`).
- Sandbox permissions: `sessions` covers `openSession`, `selectSession`, `activateTab`, `openTab`,
  `openBrowser`; `runCommand` needs `exec` (`permissions.ts:39-56`). A method missing from
  `METHOD_PERMISSIONS` needs no permission (`sandbox.tsx:401-402`), so new methods must be added.
- Control socket (`control.rs`): 0600 (`:152`); `Incoming::Activate` (`:189`) is handled without a
  PTY secret (`:206-212`); command lines need `verify` (`:213`). Replies carry `ok` and an optional
  string `message` (`:39`). `axn-term session command` accepts any `axn-` line (`cli.rs:411-416`).
- `window::settings_target` (`window.rs:364-377`): focused shell window, else `main`, else lowest
  `w-N`, else `None`.
- axn-term's Tauri `csp` is `null` (`tauri.conf.json:16`), so frames load.
- Hub (`http_api.py@d3109a3`): every route except `/api/ping` (`:249-250`) needs the token,
  assets under `/d/…` included; `?token=` answers `302` to the clean URL and sets
  `lp_token; SameSite=Strict` (`:251-259`); `X-Launchpad-Token` is accepted (`:205`); it sends
  `frame-ancestors 'self'` (`:198`). `settings.validate` flags keys not in `DEFAULTS`
  (`settings.py:96`). The front end relies on the cookie (`web/src/lib/api.ts:1`).
- Assumed, checked by the gating spike: the parent origin axn-term presents to the frame and
  whether WebKit honours it in `frame-ancestors`.

## Approaches considered

1. **Iframe in the plugin view (chosen).** React only. Needs hub changes (allowed parents, token
   in the URL path).
2. **Native Tauri child web view**, as agterm does. Page is top-level so the hub needs no change,
   but `add_child` is behind tauri's `unstable` feature (tauri 2.12.4, `window/mod.rs:1224`; this
   repo enables none). Keeping it in sync with resizing, menus, modals and rail switching is
   *assumed* costly, not measured. Returns to the table if the spike fails.
3. **One hidden plugin per URL.** Rejected: Settings → Plugins would list fake plugins.

## Design

### A. Host: rail entries and kept-mounted views

- `SessionViewPlugin.railEntries?: (ctx: { pluginSettings: unknown; appState: unknown }) =>
  RailEntry[]`, `RailEntry = { id; title; logo?; runtime? }`. A plugin declaring it renders one
  rail item per entry instead of one `renderRail` item.
- **View key.** `pluginId` for plugins without entries (unchanged); `pluginId/entryId` for entries.
  Entry ids must not contain `/`. One helper (`parseViewKey`/`viewKey`) is used at every reader
  listed in Constraints: `viewActive`/`toggleView`, ⌘N toggle, `selectAdjacentTab` and
  `pluginTabs` (keyed by plugin id, not view key), view lookup, `onOpenPluginView`,
  `setAppAttention` (entries share the plugin's attention).
- `renderView` and `PluginRailContext` gain `entryId?: string`.
- **Rail order.** Ranked keys first (saved order); then unranked plain plugins in registration
  order; then unranked entry keys in entry order. So a new entry never takes a number from an
  existing item. Runtime entry keys are never written to the saved order (`railOrderAfterDrop`
  drops them); persistent entry keys are.
- **Kept-mounted views.** `SessionViewPlugin.keepViewMounted?: boolean`. ShellApp keeps an
  opted-in plugin's view mounted after its first activation, per view key, and hides inactive ones
  (`visibility: hidden`, absolutely positioned, `inert`, `aria-hidden`). Focus returns to the
  terminal/session when a kept view is hidden. A view unmounts when its entry disappears or the
  plugin is disabled. Plugins without the flag behave as today. The view receives `active:
  boolean` in its ctx.

### B. Plugin `external-views`

- Entry sources: **settings entries** (`views` in `plugins.yaml`, persistent) and **runtime
  entries** (from `openView`, in memory per window, random ids, gone when the window closes or when
  closed from the view header).
- Settings, edited through `renderSettings`: add, remove, edit title / URL / `urlCommand` / icon.
  URL must be `http:`/`https:` (`javascript:`, `data:`, relative, blank refused). `urlCommand`
  (desktop only, e.g. `launchpad url mr`) runs on open; its trimmed stdout must be an `http(s)`
  URL and is held in memory only. Hand-edited entries are normalised on read: missing, duplicate
  or `/`-containing ids regenerated; entries with neither a valid `url` nor `urlCommand` dropped
  with a Settings warning.
- View: slim header (title, the URL's host, reload, open in browser, close for runtime entries)
  over `<iframe>` with `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`. Frame
  key = entry id + resolved URL, so a URL edit reloads that frame only. Declares
  `keepViewMounted`. On hide/show the plugin posts `{ axn: 'view-visibility', visible }` to the
  frame, for pages that throttle when hidden (a hidden iframe still reports `visibilityState ===
  'visible'`).
- Rail icon: entry `logo`, else a globe. Load failure (and `urlCommand` failure) shows an error
  state with Retry and Open in browser (`app/EmptyState.tsx`).
- "Open in browser" reuses the app's existing external-link opener; `window.open` on web.

### C. `mr-dashboard` (separate MR in ai-team-claude-plugin, after !23 merges to `master`)

- **Path-prefixed token.** GET `/t/<token>/<rest>` is authenticated by the path token
  (`hmac.compare_digest`) and serves `<rest>` exactly as `/<rest>` would; page and assets load by
  relative URL and keep the prefix. No redirect, no cookie. Non-GET under `/t/` is refused; path
  traversal stays refused by the existing realpath check.
- `web/src/lib/api.ts` takes the token from `location.pathname` when it starts with `/t/` and
  sends `X-Launchpad-Token`; cookie remains the fallback. It listens for `view-visibility` and
  treats hidden as not visible. Rebuild and commit `dashboard/app`.
- `frame-ancestors` = `'self'` plus the origins in a new `frameAncestors` setting (`settings.json`,
  added to `DEFAULTS` as `[]`, validated as origins).
- `launchpad url <dashboard>` prints `http://127.0.0.1:<port>/t/<token>/d/<id>/…`, starting the
  hub if needed (for `urlCommand`).
- `launchpad open <dashboard> --axn-term` builds that URL and runs `"$AXN_TERM_CLI" command
  "axn-views open <url> <title>"`, finding the binary via `AXN_TERM_CLI`, else `axn-term` on
  `PATH`, else the default app bundle path; if none answers it falls back to the browser.
- README: Security section (URL-path token, `frameAncestors`), settings section, the new commands.
- Security note for the MR: an allowed origin can frame the dashboard; the token travels in a URL
  axn-term never stores.

### D. `openView` and app-level commands

- `openView({ url, title?, logo? }) → key` creates a runtime entry (or selects the existing one
  with the same URL) and activates it, in the window it is called in. URL validated as in B.
  `closeView(key)` removes a runtime entry. `selectView(key)` activates any rail view.
- **Hidden commands** owned by `external-views`: `axn-views open <url> [title]`,
  `axn-views select <key|title>`, `axn-views close <key>`, `axn-views current`.
- **App-level control entry.** `PluginCommandDecl`/`PluginCommand` gain `appLevel?: true`. A new
  secret-free control message (sibling of `Activate`) carries a command line and an optional
  window; the app accepts it **only** when the line's command is declared `appLevel` (anything
  else: error reply), and runs it with an app context (window, no session). CLI:
  `axn-term command [--window <label>] <line>`. Target: `--window` if given (unknown label →
  error), else `settings_target`; `None` → error "no axn-term window". Desktop only. All four
  `axn-views` commands are `appLevel`.
- **Plugin API.** `PluginApi.openView` / `selectView` / `closeView`, sandbox `openView` /
  `selectView` / `closeView` RPCs, all under the `sessions` permission (added to
  `METHOD_PERMISSIONS`).

### E. Knowing what is selected

- `PluginApi.activeView()` / sandbox `getActiveView()` → `{ key, pluginId, entryId?, title,
  runtime } | null` (`null` = a session is showing). **No URL** in the payload — runtime URLs carry
  tokens. No permission needed.
- `viewChanged` event (in-process callback; sandbox `axn.on('viewChanged')`) once per change.
- `axn-views current` replies with that JSON as the control reply's message string.
- The selected session stays set while a view covers it (existing behaviour) and is reported
  separately.

## Gating spike (first task)

Load the hub in an iframe inside a running axn-term dev build and record: the parent origin
(`location.ancestorOrigins`, the `Origin`/`Referer` the hub sees), whether `frame-ancestors`
accepts it, whether the `?token=` cookie flow works in the frame (expected: no), and whether
header-authenticated fetches work. Repeat for a release-like build if dev differs. **If no
allow-listable origin exists on WebKit, stop and bring it back to the user.**

## Left to the builder

Component split and file names, icon picker UI, copy and Lingui strings.

## Tests

- Rail: view-key parse/format; `orderRailPlugins` with entries — no ⌘N shift for existing items
  with no saved order, partial saved order, and a sandbox plugin registered last; runtime keys not
  persisted by `railOrderAfterDrop`; `railViewIds` over entry slots.
- Host: view lookup, ⌘N toggle and `selectAdjacentTab` with an entry key; kept-mounted views stay
  mounted (and hidden, `inert`) when switching to a session and to another view; non-opted
  plugins still unmount; removed entry unmounts.
- Plugin: URL validation (valid, `javascript:`, `data:`, blank, relative); normalisation
  (duplicate / missing / `/` ids, invalid URL dropped); `urlCommand` output validated; frame key
  changes on URL edit.
- `openView`: same URL selects instead of duplicating; runtime entries not persisted; returns the
  key. Sandbox: `openView`, `selectView`, `closeView` denied without `sessions`, allowed with it.
  `activeView()` null with a session shown, key after open/rail click/⌘N, no `url` field;
  `viewChanged` fires once per change.
- App-level control: non-`appLevel` line refused; `appLevel` line dispatched without PTY secret;
  unknown `--window` and no window answer errors (Rust unit tests next to the existing ones).
- Hub (Python): `/t/<good>/d/mr/…` → 200; `/t/<bad>/…` → 403; `/t/<good>/../…` traversal → 404;
  POST under `/t/` refused; `frame-ancestors` for empty, valid and malformed `frameAncestors`;
  `launchpad url` output.
- Docs: `AGENTS.md` (both copies: rail "one item per plugin view", CLI/control section,
  permissions), `docs/agents.md` control section, `docs/architecture.md:85`, `control.rs` module
  doc, `permissions.ts` `sessions` doc, `railOrder.ts` header; mr-dashboard README.
