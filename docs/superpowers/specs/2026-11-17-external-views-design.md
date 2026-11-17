# External views: one plugin, many rail items

## Intent

Let axn-term show any web page as a full-area view reached from the rail, starting with the
`mr-dashboard` hub (`plugins/mr-dashboard` in the ai-team-claude-plugin repo, local worktree
`/Volumes/MgnlDevExtended/Mgnl/Git/worktrees/mr-23-mr-dashboard-plugins`). Today that dashboard
opens in the browser or, via `agtermctl`, in agterm's native web view; the user wants it inside
axn-term. The general mechanism is a plugin that holds a list of URLs and puts one rail icon per
URL in the rail. That needs a host capability axn-term lacks: one plugin contributing several
rail items.

## Goals

- A built-in plugin `external-views`, disabled by default (`defaultEnabled: false`), whose
  `plugins.yaml` section lists views: `views: [{ id, title, url, logo? }]`.
- Each entry gets its own rail item (icon, tooltip, ⌘1–9 slot, position the user can drag) and
  opens its page full-area in an iframe.
- Host capability: `SessionViewPlugin.railEntries` lets any plugin contribute several rail items,
  each with its own view. Reusable beyond this plugin.
- The `mr-dashboard` hub can be framed by axn-term when the user opts in.
- One host API, `openView`, opens (and activates) a view at runtime. Anyone can drive it: a typed
  or agent-run `axn-views open` command, the app-level control socket (like `agtermctl` for
  agterm), and plugins through the plugin API.

## Non-goals

- No command bridge. Embedded pages cannot open sessions, write to a PTY, notify or select a
  session in axn-term. A later change can add a `postMessage` bridge with a per-URL permission
  model.
- No native child web view (Tauri multi-webview is behind the `unstable` feature flag and brings
  layout, z-order and visibility bugs). Desktop-only behaviour is out.
- No change to existing plugins' rail behaviour, ids or saved rail order.

## Anti-goals (would be a failure even if it works)

- Embedding that silently opens the hub to any framing page by default.
- Reloading a dashboard and losing its state whenever the user switches rail items.
- Existing users' saved rail order or `⌘N` numbering shifting.

## Constraints (verified in code)

- The open view is one string, `activePluginView` (`libs/shell-ui/src/app/ShellApp.tsx:306`);
  `railViewIds` counts `[data-rail-slot]` elements (`railOrder.ts`, `ShellApp.tsx:389`); rail order
  is `pluginData['axn-rail'].order` over plugin ids; `setAppAttention(plugin.id, …)` keys
  attention by plugin id. All four assume one rail item per plugin.
- `renderRail`/`renderView` are keyed by plugin; `renderView` ctx has no entry notion
  (`session-plugins/plugin.ts`).
- `renderSettings` (`PluginSettingsViewContext`, `plugin.ts:447`, consumed in
  `SettingsModal.tsx`) exists but no plugin uses it yet; this is its first user.
- axn-term's Tauri `csp` is `null` (`apps/desktop/src-tauri/tauri.conf.json`), so frames load.
- The hub sends `Content-Security-Policy: frame-ancestors 'self'`
  (`plugins/mr-dashboard/server/http_api.py:198`) and authenticates via a `SameSite=Strict`
  cookie set after a `?token=` redirect (`http_api.py:251-259`). The hub already accepts an
  `X-Launchpad-Token` header (`http_api.py:205`); the React front end
  (`web/src/lib/api.ts`) relies only on the cookie.
- Not verified: the parent origin axn-term presents to the iframe in release, dev
  (`http://localhost:1420`) and web builds, and whether WebKit honours it in `frame-ancestors`.
  See the gating spike.

## Approaches considered

1. **Iframe in the plugin view (chosen).** React only, works in desktop and web builds. Needs two
   hub changes (allowed parents, header token).
2. **Native Tauri child web view**, as agterm does. Page is top-level so the hub needs no change,
   but it is desktop-only, `unstable`, and must be kept in sync with resizing, menus, modals and
   rail switching.
3. **One hidden plugin per URL** (no host change). Rejected: Settings → Plugins would list fake
   plugins and each URL would need a registered plugin.

Chosen by the user: approach 1, viewer only.

## Design

### A. Host: `railEntries` (axn-term)

- `SessionViewPlugin.railEntries?: (ctx: { pluginSettings: unknown }) => { id: string; title: string; logo?: string }[]`.
  A plugin declaring it renders one rail item per entry instead of one `renderRail` item. Entries
  re-evaluate when plugin settings change (live-reload already exists for `plugins.yaml`).
- A rail item/view key becomes `pluginId` for plugins without entries (unchanged) and
  `pluginId/entryId` for entries. `activePluginView`, the saved rail order, `data-rail-slot`,
  ⌘1–9 numbering and `setAppAttention` use the key. Entry ids must not contain `/`.
- `renderView` ctx gains `entryId?: string`. `PluginRailContext` gains `entryId?` likewise, so
  `viewActive` and `toggleView` are per item.
- Saved order tolerates entries appearing/disappearing the way it tolerates plugins today
  (`orderRailPlugins` already keeps unknown ids at their slot or appends).

### B. Plugin `external-views` (axn-term)

- Two entry sources, one rail: **settings entries** (`views` list, persistent) and **runtime
  entries** (created by `openView`, in memory only, gone when the window closes).
- Settings: `views` list, edited through `renderSettings` (add, remove, edit title/URL/icon,
  reorder via rail drag). Accepts `http:`/`https:` URLs only; rejects everything else, including
  `javascript:` and `data:`. Ids are generated and stable. A settings entry may carry
  `urlCommand` (e.g. `launchpad url mr`): run on open, its stdout is the iframe address, kept in
  memory only — so a token never lands in `plugins.yaml` (desktop only; needs `exec`; web builds
  use a plain `url`).
- View: slim header (title, reload, open in browser) over `<iframe src=url>` with
  `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`.
- Frames stay mounted after first open and are hidden while another view is active, so state
  survives switching. Closing is not required; a removed entry unmounts.
- Rail icon: entry `logo`, else a generic globe.
- A view that fails to load shows an error state with Retry and Open in browser, built from
  `app/EmptyState.tsx`.

### C. `mr-dashboard` (separate MR, ai-team-claude-plugin repo)

Found while answering the builder check: the header alone is not enough. `authorised()`
(`http_api.py:204`) guards every route, assets under `/d/…` included, and `?token=` redirects to a
clean URL and sets a `SameSite=Strict` cookie. An iframe navigation and its `<script>`/`<link>`
loads cannot carry `X-Launchpad-Token`, and the cookie will not ride a cross-site frame. So:

- **Path-prefixed token.** The hub accepts `/t/<token>/<rest>` as authenticated for GET and serves
  `<rest>` (page and assets, which load by relative URL and keep the prefix). No redirect, no
  cookie. The token is compared with `hmac.compare_digest` as today.
- `web/src/lib/api.ts` reads the token from `location.pathname` (`/t/<token>/…`) and sends
  `X-Launchpad-Token` on every API call; cookie stays as fallback for the normal browser/agterm
  flow. Reload and Retry work because the token lives in the URL, not in memory. Rebuild and
  commit `dashboard/app`.
- `frame-ancestors` becomes `'self'` plus the origins in a new `frameAncestors` setting in
  `settings.json` next to `port` (validated as origins, default empty).
- `launchpad url <dashboard>` prints `http://127.0.0.1:<port>/t/<token>/d/<id>/…` (starting the hub
  if needed) for `urlCommand`; `launchpad open <dashboard> --axn-term` is the push route (section D).
- Security note for the MR: allowing an origin lets any page under it frame the dashboard; the
  token in a URL is a secret at rest wherever the URL is saved. Acceptable on localhost, opt-in.

### D. `openView`: the one way to open a view at runtime

`openView({ url, title?, logo?, key? })` creates or re-activates a runtime entry (same `key`, else
same URL, activates instead of duplicating) and activates it. URLs are validated as for settings
entries (`http(s)` only). It is exposed three ways, all calling the same host function:

- **Hidden command** `axn-views open <url> [title]`, declared by the plugin like other owned
  commands (`axn-workflow …`). Useful on its own: from any session, from agents through
  `"$AXN_TERM_CLI" session command "axn-views open …"`, from `runCommand`.
- **App-level control entry.** `control.rs` already has a message that needs no PTY secret
  (`Incoming::Activate`, `control.rs:240`; the socket is 0600, user-only). Add a sibling that
  carries a hidden-command line to the app, and a CLI `axn-term command [--window <id|label>] <line>`
  that sends it. Default target is the window with focus, else `main` (as `window::settings_target`
  does); `--window` picks another, and an unknown window is an error, not a fallback. Views are
  per window (rail state is window state), so the target decides where the entry appears. Any local
  process of the user can drive axn-term this way, the same as `agtermctl`.
- **Plugin API.** `PluginApi.openView` for in-process plugins and an `openView` RPC in the sandbox
  client (`AxnClient`). Capability: the existing `sessions` permission ("drive the app's sessions
  and views": `openSession`, `openTab`, `openBrowser`, …), so `METHOD_PERMISSIONS.openView =
  'sessions'`. No new permission and no need for `exec`, which `runCommand` requires.

`mr-dashboard` side: `launchpad open <dashboard> --axn-term` builds the tokened URL the way
`--agterm` does and calls `axn-term command "axn-views open …"`; the runtime entry holds the URL
in memory only. From outside an axn-term install (socket absent) it falls back to the browser.

### E. Knowing what is selected

The selection is `activePluginView` (`ShellApp.tsx:306`), which becomes the `pluginId/entryId` key
(section A). Today only the rail items read it (`viewActive`); nothing else can. Expose it:

- **Read:** `PluginApi.activeView()` and sandbox `axn.getActiveView()` return
  `{ key, pluginId, entryId?, title, url?, runtime } | null` (`null` = a session is showing).
  Readable by any plugin, no permission: it only reports what the user already sees.
- **Subscribe:** `viewChanged` event (in-process callback, sandbox `axn.on('viewChanged')`) fires
  on every change with the same payload.
- **Command:** `axn-views current` replies with the same JSON (through the control reply), so an
  external caller or agent can ask `axn-term command "axn-views current"`.
- **Link rail ↔ view:** the key is the one identity for the rail slot (`data-rail-slot`), the
  saved order, ⌘N and the active view, so `openView` returns the key, and `selectView(key)` /
  `axn-views select <key|title>` activate an existing entry (`sessions` permission, like
  `selectSession`). `openView` on an existing key just selects it.
- A view covering a session leaves `selectedSessionId` set (existing behaviour); `activeView()`
  and the selected session are reported separately.

## Gating spike (first task of the plan)

Before section C is built, load the hub's URL in an iframe inside a running axn-term (release-like
and dev) and record: the parent origin the frame reports (`location.ancestorOrigins` / the
`Origin` the hub sees), whether `frame-ancestors` accepts it (custom schemes such as
`tauri://localhost` may not be honoured by WebKit), and whether the path-token flow loads page,
assets and API calls. **If no allow-listable origin exists on WebKit, stop and bring it back to the
user** (approach 2 returns to the table); do not build C around a guess.

## Decisions and rules from the builder check

- Entry rules: ids are generated (short random), stable across edits. A URL edit reloads that
  frame in place (frame key = entry id + URL). Hand-edited `plugins.yaml` is normalised on read:
  entries with a missing, duplicate or `/`-containing id get a regenerated one; entries without a
  valid `http(s)` URL are dropped (with a Settings warning).
- Rail order: entries are new rail keys, so they append after every already-ordered plugin
  (existing `orderRailPlugins` behaviour for unknown ids); existing numbering never shifts. Within
  one plugin, entries keep the `views` array order.
- `renderSettings` already receives `update(patch)` which persists plugins.yaml
  (`PluginSettingsViewContext`, `plugin.ts:447`), so no extra host change is needed for the form.
- "Open in browser" uses whatever opener existing views use (e.g. the terminal link opener); the
  builder reuses it and falls back to `window.open` on web.

## Left to the builder

- Exact component split and file names, the icon picker UI, copy and i18n strings (Lingui).
- Whether the first-open spike needs a Storybook story.
- Whether `frameAncestors` lives in `settings.json` next to `port` (preferred).

## Tests

- Selection: `activeView()` is `null` with a session shown, the key after `openView`/rail click/
  ⌘N, and `viewChanged` fires once per change (not on re-selecting the same key).
- `openView`: validation (bad scheme refused), same key/URL re-activates instead of duplicating,
  runtime entries are not persisted, the `sessions` permission gates the sandbox RPC (denied
  without it), the control message reaches dispatch without a PTY secret and a wrong/absent window
  answers an error, `axn-views open` end to end.
- Unit: rail key parsing, `orderRailPlugins` with entries, `railViewIds` over entry slots, URL
  validation (valid, `javascript:`, `data:`, blank, relative), settings normalisation.
- Component: a plugin with two entries renders two items; toggling one leaves the other mounted
  but hidden.
- Hub (Python): `frame-ancestors` output for empty, valid and malformed `frameAncestors`; header
  token accepted without cookie.
- Docs: update `AGENTS.md` ("one item per plugin view") and the plugin SDK/docs sections that
  describe rail items.
