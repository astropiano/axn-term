# Tagging plugin and plugin colour capability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugins can contribute colours to session cards and workspace headers (equal left-to-right bands); a built-in `tagging` plugin colours them from typed string tags.

**Architecture:** Two optional `SessionViewPlugin` hooks (`sessionColors`, `workspaceColors`) are collected by `SessionPanel` and rendered by a pure `resolveTint`. Workspaces gain `pluginState` (written through the existing `updateWorkspace`). Menu hooks get a `scope` argument (multi-selection targets, all sessions/workspaces) and a session-less `workspaceActions` hook. The tagging plugin = pure model + modal + plugin object.

**Tech Stack:** React 18, TypeScript, Tailwind arbitrary values, Lingui (`t` macro), vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-11-17-tagging-plugin-design.md`

## Global Constraints

- Colours are hex only (`#rgb`, `#rrggbb`, `#rrggbbaa`); anything else is dropped by `resolveTint`.
- Bands run **left to right**: `linear-gradient(90deg, …)` equal-width hard stops, plugin order then array order, duplicates shown once.
- Intensity: selected session card 30%, unselected 12%, workspace header 12% always (constants in `tint.ts`).
- A tag is a plain string stored only on its carrier: session `pluginState` slice `{ tags: string[] }`, workspace `Workspace.pluginState.tagging.tags`. No catalogue, no `appState`, no stored colour.
- `tagColor(name)` = stable hash of trimmed lower-cased name into a fixed palette.
- Magic strings (plugin id, state key) in one constants holder; user-visible text through Lingui `t`.
- Smallest diff; no comments on private functions; TSDoc only on exported contracts.
- Commit per task on `feat/tagging-plugin`; do not push. Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Test command: `pnpm vitest run <path>`; finish with `pnpm -w nx run-many -t typecheck` equivalent if present, else `pnpm tsc -p libs/shell-ui --noEmit`.

## Review Focus

- Colour string that is not hex (`red`, `url(x)`, `#12`): dropped, never emitted into CSS.
- Tag names `"  "`, `"Foo"` vs `"foo"`: blank rejected; case-insensitive duplicates collapse to one.
- Multi-select where targets disagree: tri-state shows "mixed"; click adds to all, then (when all) removes from all.
- Empty workspace: "Tag…" row is present and works.
- Plugin disabled / hook throwing: no tint, panel still renders.
- Selected session inside a tagged workspace: workspace header stays at faint intensity.

---

### Task 1: `resolveTint` and `tagColor` (pure)

**Files:**
- Create: `libs/shell-ui/src/app/session-plugins/tint.ts`, `tint.test.ts`

**Interfaces:**
- Produces:
  - `export const TINT_INTENSITY = { selected: 30, idle: 12, workspace: 12 } as const`
  - `export type TintIntensity = keyof typeof TINT_INTENSITY`
  - `export function isHexColor(value: unknown): value is string`
  - `export function resolveTint(colours: readonly string[], intensity: TintIntensity): string | undefined` — a CSS `background-image` value, `undefined` when no valid colour. Max 4 distinct colours.

- [ ] **Step 1: Write failing tests** (`tint.test.ts`): `isHexColor` accepts `#abc`, `#aabbcc`, `#aabbccdd`, rejects `red`, `#12`, `url(x)`, `''`, non-strings; `resolveTint([], 'idle')` and `resolveTint(['red'], 'idle')` → `undefined`; one colour → `linear-gradient(90deg, color-mix(in srgb, #abc 12%, transparent) 0 100%)`; two colours → bands `0 50%` and `50% 100%`, first colour first; `['#abc','#ABC']` collapses to one band; five distinct → four bands; `selected` uses 30%.
- [ ] **Step 2: Run, verify FAIL** — `pnpm vitest run libs/shell-ui/src/app/session-plugins/tint.test.ts`.
- [ ] **Step 3: Implement** the three exports above. Band edges via `i*100/n`, rounded to 2 decimals.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(ui): resolveTint for plugin colour bands`.

### Task 2: Colour hooks in the panel

**Files:**
- Modify: `libs/shell-ui/src/types.ts:90` (add `pluginState?: Record<string, unknown>` to `Workspace`), `session-plugins/plugin.ts` (hook types next to `sessionMenuItems`), `app/SessionPanel.tsx` (card `style`, `WorkspaceHeader` `style`)
- Test: `libs/shell-ui/src/app/SessionPanel.tint.test.tsx` (copy the render harness of `SessionPanel.sessionCard.test.tsx`)

**Interfaces:**
- Consumes: `resolveTint`, `TintIntensity` (Task 1).
- Produces on `SessionViewPlugin`:
  - `sessionColors?: (ctx: SessionViewContext & PluginApi) => string[]`
  - `workspaceColors?: (ctx: { workspace: Workspace; pluginSettings: unknown }) => string[]`
- Produces in `SessionPanel.tsx`: `collectColours(plugins, fn): string[]` (private helper; swallows plugin exceptions → `[]`).

- [ ] **Step 1: Write failing tests**: (a) plugin with `sessionColors: () => ['#ff0000']` → selected card element has inline `background-image` containing `30%`, unselected card `12%`; (b) `workspaceColors` → workspace header contains `12%` even though it holds the selected session; (c) two plugins `['#ff0000']` and `['#00ff00']` → both colours in order inside one gradient; (d) hook that throws, and a non-hex colour → no `background-image`, panel still renders; (e) no colour hooks → no `background-image` on card or header.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Card: build the existing session ctx (as `SessionItem` already does for fields), collect `sessionColors`, set `style={{ backgroundImage }}` on the card `div` (`SessionPanel.tsx:~1455`); header: collect `workspaceColors` in the workspace map (`:~2235`) and pass a `tint?: string` prop to `WorkspaceHeader`, applied as its container `style`. Confirm `--fill-1` is translucent; if not, set the tint layer via a pseudo-element or `background-blend` so it stays visible.
- [ ] **Step 4: Run, verify PASS; run `SessionPanel.sessionCard.test.tsx` and `sessionCardLayout.test.ts` unchanged.**
- [ ] **Step 5: Commit** `feat(ui): plugin colour hooks for session cards and workspace headers`.

### Task 3: Menu scope and session-less workspace actions

**Files:**
- Modify: `session-plugins/plugin.ts`, `app/SessionPanel.tsx` (`SessionItem` props + `SessionContextMenu` call at `:~1647`; `workspacePluginItems` at `:~1884`; panel passes `allSessions`)
- Test: `SessionPanel.menuScope.test.tsx`

**Interfaces:**
- Produces:
  - `export interface MenuScope { targets: (SessionViewContext & PluginApi)[]; sessions: ShellSession[]; workspaces: Workspace[] }`
  - `sessionMenuItems?: (ctx: SessionViewContext & PluginApi, scope: MenuScope) => RepoMenuItem[]` — `targets` is every multi-selected session when the right-clicked one is in a multi-selection, else `[ctx]`.
  - `export interface WorkspaceActionContext { workspace: Workspace; pluginSettings: unknown; sessions: ShellSession[]; workspaces: Workspace[]; updateWorkspaceState(patch: Record<string, unknown>): void }`
  - `workspaceActions?: (ctx: WorkspaceActionContext) => RepoMenuItem[]` — does not need a session; `updateWorkspaceState` shallow-merges `patch` into `workspace.pluginState[<plugin settingsKey>]` via the existing `updateWorkspace`.

- [ ] **Step 1: Write failing tests**: single session → `scope.targets.length === 1`; right-click inside a 2-session multi-selection → 2 targets; `workspaceActions` row appears in the menu of a workspace with **no sessions**; `updateWorkspaceState({tags:['a']})` calls `updateWorkspace(id, { pluginState: { <key>: { tags:['a'] } } })` and preserves other plugins' slices.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** `SessionItem` gets `allSessions: ShellSession[]` (panel passes `sessions`); targets built with the same `createPluginApi(...)` call per id. `workspaceActions` rows join `workspacePluginItems` output (works when `representativeSession` is undefined). Existing plugins ignore the new argument.
- [ ] **Step 4: Run, verify PASS; existing `SessionPanel.dragWindows.test.tsx` still green.**
- [ ] **Step 5: Commit** `feat(ui): menu scope for session menus and session-less workspace actions`.

### Task 4: Tagging model (pure)

**Files:**
- Create: `session-plugins/taggingModel.ts`, `taggingModel.test.ts`

**Interfaces:**
- Produces:
  - `export const TAGGING = { id: 'tagging', stateKey: 'tags' } as const` and `export const TAG_PALETTE: readonly string[]` (hex values, readable in light and dark)
  - `normalizeTag(raw: string): string | null` — trimmed; `null` when blank
  - `tagColor(name: string): string` — stable, case-insensitive, always in `TAG_PALETTE`
  - `addTag(tags: readonly string[], raw: string): string[]` — no-op on blank or case-insensitive duplicate
  - `removeTag(tags: readonly string[], name: string): string[]` (case-insensitive)
  - `renameTag(tags: readonly string[], from: string, to: string): string[]` (blank `to` → unchanged; `to` already present → just removes `from`)
  - `type TagState = 'none' | 'some' | 'all'`; `tagState(targets: readonly (readonly string[])[], name: string): TagState`
  - `derivedTags(carriers: readonly (readonly string[])[]): string[]` — case-insensitive de-duplicated union, first spelling wins, sorted
  - `toggleTag(targets: readonly (readonly string[])[], name: string): string[][]` — `none`/`some` → add to all; `all` → remove from all

- [ ] **Step 1: Write failing tests** for each function incl. the Review Focus cases (`"  "`, `"Foo"` vs `"foo"`, mixed → all → none, `tagColor` equal for `"Foo"`/`" foo "`, inside palette for 200 random strings).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement.** Hash: 32-bit FNV-1a of the lower-cased name modulo palette length.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(tagging): pure tag model`.

### Task 5: Tag modal

**Files:**
- Create: `app/TagModal.tsx`, `app/tagHost.tsx` (store + `TagHost`, mirroring `pickerHost.tsx`), `app/TagModal.test.tsx`
- Modify: `app/ShellApp.tsx` (mount `<TagHost />` next to `<PickerHost />`)

**Interfaces:**
- Consumes: Task 4 functions.
- Produces:
  - `export interface TagRequest { title: string; targets: string[][]; others: string[][]; onApply(next: string[][]): void }` — `targets` are each target's current tags, `others` the tags of every other carrier in the window (as built: renaming or deleting in the modal must not touch them, and the shared list is `derivedTags([...others, ...targets])`).
  - `export function openTagModal(request: TagRequest): void`
  - `TagModal` props `{ request: TagRequest; onClose(): void }`: filter/create input, a row per `derivedTags(universe)` with colour dot (`tagColor`) and tri-state checkbox (`tagState`), rename and delete per row, Enter on the input adds the typed tag (via `addTag` to every target). Apply writes once via `onApply` with the final per-target arrays, then closes.

- [ ] **Step 1: Write failing component tests**: rows reflect `none/some/all`; clicking a `some` row sets all targets; clicking an `all` row clears; typing `"  "` + Enter adds nothing; typing `"New"` + Enter adds to every target; rename affects opened targets only; Apply calls `onApply` exactly once.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** with the shared `Modal`/button styling used by `MoveToWorkspaceModal.tsx` and `SearchPickerModal.tsx`; Lingui `t` for all text; mixed state via `input.indeterminate`.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(tagging): tag modal and host`.

### Task 6: The tagging plugin

**Files:**
- Create: `session-plugins/tagging.tsx`, `tagging.test.ts`
- Modify: `session-plugins/index.ts` (import, export, add to `defaultPlugins`), `AGENTS.md` (one paragraph: colour hooks, `Workspace.pluginState`, tagging plugin)

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces `export const taggingPlugin: SessionViewPlugin` with:
  - `sessionColors` → `tags.map(tagColor)` from the session's own `pluginState`; `workspaceColors` → from `workspace.pluginState?.[TAGGING.id]?.tags`; non-array state → `[]`.
  - `sessionFields: [{ id: 'tags', label: 'Tags', kind: 'inline', zone: 'title', value, search }]` — chips with the tag text in its colour; `search` returns the tags; `null` when none.
  - `sessionMenuItems(ctx, scope)` → one "Tag…" row opening `openTagModal` with `targets` = each target's tags, `universe` = every session's tags + every workspace's tags, `onApply` writing each target with `updatePluginState({ tags })`.
  - `workspaceActions(ctx)` → one "Tag…" row, `onApply` → `ctx.updateWorkspaceState({ tags: next[0] })`.

- [ ] **Step 1: Write failing tests**: colours for session and workspace; garbage state → `[]`; field value null without tags and `search` returns the tags; session menu row opens the modal with all multi-select targets and writes each; workspace action works with zero sessions; plugin without tags contributes no colour.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** and register.
- [ ] **Step 4: Run all touched tests, the full `libs/shell-ui` vitest suite, typecheck, `pnpm i18n:extract` (commit catalog changes if the repo tracks them).**
- [ ] **Step 5: Commit** `feat(tagging): tagging plugin`.
