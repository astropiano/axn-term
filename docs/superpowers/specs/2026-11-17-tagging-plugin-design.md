# Tagging plugin and plugin colour capability — design

Status: draft, awaiting approval. Decisions by the user: general colour capability, bands left to
right, multi-select tagging, empty workspaces taggable, tags live only on their carrier, a tag is
just a manually typed string. Branch `feat/tagging-plugin`.

## Intent

Let users colour sessions and workspaces so they can be told apart at a glance. Colour is a new,
general **plugin capability** ("a plugin can provide colours for a session / workspace"); the
tagging plugin is the first provider. A tag is just a string, typed by hand; its colour is derived
from the string.

## Goals

- Core capability: any enabled plugin can contribute colours to a session card and to a workspace
  header. When several colours apply, they are shown as equal-width bands, left to right, in plugin
  order, then in the plugin's own order.
- Tagging plugin: tags are plain typed strings that live only on the session or workspace carrying
  them, coloured by a stable hash of the string into a fixed palette; several per target; applied to a whole multi-selection of sessions, or to a workspace (including
  an empty one), from a "Tag…" context-menu item that opens a modal.
- Intensity is the host's decision, not the plugin's: session card tint is **stronger when the
  card is selected, fainter when not**; workspace header tint is **always the faint one**.
- Whether the tag name shows on the card is a normal card-layout choice (a `tagging.tags` session
  field placeable/hideable through the `sessionCard` setting).

## Non-goals

- No panel filter by tag, no tag-based search (the field's `search` hook is optional; see below).
- No colour rendering for anything but session cards and workspace headers (not tabs, not rail).
- No sandboxed (iframe) plugin API for colours in this change — in-process plugins only.

## Anti-goals

- A disabled plugin must never leave a stale colour behind.
- The selected card must still read as selected: the existing accent edge mark stays.
- Colours must stay legible in every theme: the tint is a translucent mix over the card surface,
  never an opaque fill that fights the text colour.

## Constraints (verified in the code)

- Plugins are `SessionViewPlugin` objects (`libs/shell-ui/src/app/session-plugins/plugin.ts`),
  registered in `session-plugins/index.ts`. Existing contribution hooks: `sessionFields`
  (`plugin.ts:460`), `sessionMenuItems` (`:813`), `workspaceMenuItems` (`:822`).
- `workspaceMenuItems` runs against a representative session and is not called for workspaces with
  no sessions. A workspace colour hook must therefore **not** need a session.
- Workspaces carry no plugin state today (`types.ts:90`: `id`, `name`, `collapsed`,
  `defaultFolder`). Per-session data lives in `pluginState.<id>`; workspaces need an equivalent
  (section 3).
- Card and selection styling is hard-coded in `SessionPanel.tsx:1459-1464` (selected:
  `bg-[var(--fill-1)]` + inset accent edge; multi-selected: accent 10% mix). The workspace header is
  rendered in the same file.
- `pickOrCreate` / `SearchPickerModal` (`pickerHost.tsx`) is a single-pick list with an optional
  create row. Multiple tags per target need either a multi-select mode or a dedicated modal.
- `CLAUDE.md` rules that apply: smallest diff, reuse before add, magic strings → constants,
  tests that pin the guard (the revert test), Javadoc-equivalent: TSDoc only where it records a
  contract.

## Approaches considered

- **A. Pure hook (chosen).** `sessionColors?(ctx) => string[]` and
  `workspaceColors?(ctx) => string[]` on `SessionViewPlugin`; the panel collects them from all
  enabled plugins on render. Nothing persisted in the host; disabling a plugin removes its colour,
  exactly as with `sessionFields`. Workspace hook takes the workspace and the plugin's `appState`,
  not a session.
- **B. Imperative `ctx.setColor()`** (like `setBanner`). Rejected: the host would have to persist
  the value, and a disabled plugin leaves it behind.
- **C. Tagging plugin paints the DOM itself.** Rejected: plugins have no hook into card styling,
  and it would bypass the host's selected/unselected intensity rule.

Decided by the user: colour is a general capability that several plugins can feed; bands run left
to right.

## Design

### 1. Core capability (`session-plugins/plugin.ts`, `SessionPanel.tsx`)

- New optional hooks on `SessionViewPlugin`:
  - `sessionColors?: (ctx: SessionViewContext & PluginApi) => string[]`
  - `workspaceColors?: (ctx: { workspace: Workspace; pluginSettings: unknown; appState: unknown }) => string[]`
  - Return CSS colour strings (hex). Empty array = no contribution. Must be synchronous and cheap
    (called per render).
- A pure helper (own file, unit-tested) `resolveTint(colours: string[], intensity)` that
  de-duplicates, caps at a small N (builder's call, suggest 4), and returns a CSS
  `background-image` of N equal hard-stop bands:
  `linear-gradient(90deg, c1 0 33.3%, c2 33.3% 66.6%, c3 66.6% 100%)`, each colour mixed with
  transparency via `color-mix(in srgb, <c> <pct>%, transparent)`.
- Intensity (initial values, tunable): selected session card ~30%, unselected ~12%, workspace
  header ~12% always. Multi-selected rows keep their existing accent mix; tint is layered under it
  (builder's call on exact layering).
- The panel applies the tint as an inline `backgroundImage` on the card / workspace header
  element, on top of the existing background classes. The inset accent edge on the selected card
  is unchanged.
- Ordering: plugins in registry order; within a plugin, array order. A colour that repeats is shown
  once.

### 2. Tagging plugin (`session-plugins/tagging.tsx`, new, registered in `index.ts`)

- **Data — a tag is a string, stored only on its carrier.** `pluginState.tags: string[]` on the
  session, `Workspace.pluginState.tagging.tags: string[]` on the workspace (section 3). No
  catalogue, no `appState`, no stored colour. Consequences, all intended:
  - **Colour is derived:** `tagColor(name)` = a stable hash of the lower-cased, trimmed name into a
    fixed palette. The same name has the same colour on every session, workspace and window, and
    survives reload. (Author's call — see "Calls made". The user cannot pick a colour.)
  - The picker's list of existing tags is **derived**: the union of tags across every session and
    workspace in the window, de-duplicated case-insensitively.
  - A tag with no carrier left no longer exists. Rename changes the string on the targets the modal
    was opened for; other carriers keep the old string (and therefore the old colour).
  - Constants (state keys, palette) in one typed holder (magic-strings rule).
- **Hooks**
  - `sessionColors` → the colours of the session's tags. `workspaceColors` → the workspace's.
  - `sessionFields` → one inline field `tags` (zone `title`) rendering the tag names as small
    coloured chips; `search` returns the tag names. Hiding it via `sessionCard.hidden` shows colour
    only, no name — that is the "show tag name or not" setting.
  - A "Tag…" row in the session menu and in the workspace menu (the workspace one works for empty
    workspaces — section 3).
- **Targets.** Session menu: if the right-clicked session is part of a multi-selection, the
  targets are all selected sessions, else just that session. Workspace menu: that workspace only.
- **Modal** — a text box plus the derived list of existing tags, each row a checkbox with its
  colour dot, tri-state for multiple targets: unchecked (no target has it), checked (all have it),
  mixed (some do). Typing filters the list; the create row ("Add \"<typed>\"") adds the typed
  string to every target. Clicking a row on unchecked or mixed adds the tag to every target;
  clicking it when checked removes it from every target. Each row also offers rename / delete,
  acting on the opened targets only (delete = remove from those targets). Confirming writes once.
- Names are normalised (trimmed, non-blank, case-insensitive) on create and rename, and the
  resolved string is what is stored and shown. A target never carries the same tag twice
  (case-insensitive).

### 3. Workspace state (core, small)

- `Workspace` (`libs/shell-ui/src/types.ts:90`) gains `pluginState?: Record<string, unknown>`,
  persisted with the workspace like `defaultFolder`, so it follows the workspace on adoption and
  tear-off and is deleted with it.
- A session-less menu contribution for workspaces: a hook (name left to the builder; e.g.
  `workspaceActions`) called with `{ workspace, pluginSettings, workspacePluginState,
  updateWorkspaceState(patch) }` and returning `RepoMenuItem[]`. Unlike `workspaceMenuItems` it
  does not need a session, so empty workspaces get the "Tag…" row. `workspaceColors` reads the
  same `workspace.pluginState` slice.
- The panel needs a write path for it (builder: find or add the existing workspace-update path
  that `defaultFolder` uses).

## Tests (must pin the guard, not the happy path)

- `resolveTint`: 1 colour → one band; 2 → 50/50 left to right; duplicates collapsed; cap at N;
  empty → no style; invalid colour string is dropped, not emitted raw.
- Panel: selected card renders the strong tint, unselected the faint one, workspace header the
  faint one even when it contains the selected session; a plugin with no colours changes nothing;
  two plugins both contributing give two bands in plugin order. Disabling the contributing plugin
  removes the tint.
- Tagging plugin: blank/whitespace name rejected on create and rename; `tagColor` is stable,
  case-insensitive and always inside the palette; a target never gets the same tag twice
  (case-insensitive); the derived list is the de-duplicated union over sessions and
  workspaces and drops a tag when its last carrier loses it; multi-select tri-state (none / some /
  all) and the add-to-all / remove-from-all click rule; rename on opened targets leaves other
  carriers untouched; an empty workspace gets the "Tag…" row; `sessionFields.search` returns names.
- Workspace state: `Workspace.pluginState` round-trips through persistence and survives adoption.
- Existing `SessionPanel.sessionCard` and `sessionCardLayout` tests stay green.

## Calls made while writing (author's, not agreed with the user)

- **Re-render path (checked):** `SessionPanel` already receives `pluginData` and `mergePluginData`
  as props (`SessionPanel.tsx:88-89`, passed down at `:1662`, `:1902`, `:2329`), and `pluginData`
  is React state in `ShellApp`. The workspace header reads `pluginData[settingsKey]` from those
  props, so a tag write re-renders cards and headers — no session-less `PluginApi` builder is
  needed. (`workspaceColors` now reads `workspace.pluginState`, section 3; the `appState` field in
  its ctx stays for other plugins that keep colour data there.)
- **Derived colour:** the user said a tag is "just a string, manually typed"; earlier a tag was
  name + colour. I read this as: no stored colour, derive it from the string. The alternative
  (user picks a colour per tag) would need a stored colour per carrier — say so if that is wanted.
- **Colour validation:** hex only (`#rgb`, `#rrggbb`, `#rrggbbaa`), checked by regex in
  `resolveTint`; anything else is dropped. No DOM / `CSS.supports` dependency, so it is testable
  in jsdom. The "CSS colour strings (hex)" wording above means exactly this.
- **Tint layering** under `--fill-1` / multi-select is a builder check: confirm `--fill-1` is
  translucent before layering `backgroundImage` over it.

## Left to the builder

- Exact intensity percentages, band cap, and layering with multi-select styling.
- Whether the modal is a new `TagModal` or `SearchPickerModal` gains an optional tri-state
  multi-select mode — prefer extending the existing component if the diff stays small.
- Palette values and the hash (use the design tokens where a suitable one exists; the palette must
  stay readable in light and dark themes).
- Lingui strings for all user-visible text.

## Open items / risks

- **Window tear-off / adoption of workspaces:** `Workspace.pluginState` should travel with the
  workspace; not checked how adoption copies workspace records.
- **Remote viewers:** not checked whether workspace and session `pluginState` replicate to remote
  viewers (sessions already carry `pluginState`, so likely yes; workspace records unverified).
- Two different names can hash to the same colour; accepted, since the name chip disambiguates.
- Sandboxed plugins get no colour API in this change; adding one is a separate change.

## Amendment: configurable colours, workspace block tint

- Colour overrides live in the plugin's settings section (`plugins.yaml` → `tagging.colors`,
  `{ "<lower-cased name>": "#hex" }`), edited in Settings → Plugins → Tags. A tag without an
  entry keeps its derived colour. Tags still live only on their carrier; settings holds colours,
  not tags, so renaming or deleting a tag stays in the Tag… modal.
- Limit: the settings view has no access to sessions, so it lists only overrides (type a name to
  add one), not every tag in use.
- The workspace tint paints the whole workspace block (header and sessions) with rounded corners,
  bleeding 6px past the list gutter so the container is visible.
- Plugin fields (all plugins, decided by the user) show only where a layout names them: the
  user's `sessionCard`, else per zone the shipped `DEFAULT_SESSION_CARD`, which keeps today's card
  but omits `tagging.tags` and `jira.tickets`. A disabled plugin's ids resolve to nothing. The
  colour tint is independent of the tags field.
