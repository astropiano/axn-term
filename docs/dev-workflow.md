# dev-workflow plugin

A session-view plugin that adds a *meta* workflow layer on top of coding
agents. Agent CLIs (Devin, Claude Code, Mistral Vibe, …) can run workflows
internally; this plugin tracks a **workflow state outside the agent** — in a
repo file or in plugin storage — so the terminal itself knows which phase a
piece of work is in, can gate transitions on human approval, and can launch
the right agent (model + prompt) for the phase being entered.

Typical flows:

- **Speckit-style**: `plan → plan-review → implement → review → qa`. The
  planning agent writes `plan.md`/`specs.md`/`tasks.md`; the human reviews
  them in `plan-review` (no agent — a pure gate); `implement` launches the
  implementation agent.
- **Offices**: each state is an "office" with its own agent persona — a
  planning office that interrogates the user until the spec is complete,
  then hands over to an implementation office, then a review office.

## Design principle

The plugin is deliberately meta: it never parses agent output. Launching an
agent means *typing the right command into the shell* (or a sub-shell tab).
Once running, the existing agent plugins take over — `devin`/`claude` match
`session.process` via `processPattern` and provide task lists, progress,
idle-attention flags, and session resume. The workflow plugin only owns
state transitions and the launch of a state's named actions.

Actions are **offered, never orchestrated**: there is no `needs:`/DAG, no
retries/artifacts/`when:` — a named action is a button available while in a
state, not a pipeline job. If something is a phase with its own handoff,
model it as a state, not an action. The one exception is `auto: true`: an
auto action is the state's "on-enter" hook and fires every time the state is
entered (start, `axn-workflow-move`, board chevrons, an agent's
`axn-workflow-state:` marker).

## Configuration (plugins.yaml)

```yaml
dev-workflow:
  enabled: true              # opt-in (defaultEnabled: false)
  workflows:
    speckit:
      title: Speckit         # display name (default: the key)
      tracking:
        file: .axn/workflow.yaml   # repo-relative state file; omit for plugin store
        format: yaml               # json|yaml — default: inferred from extension
      states: [plan, plan-review, implement, review, qa]
      start: plan                  # initial state (default: first in `states`)
      vars:                        # optional declared inputs (see below)
        mr: { kind: mr, required: true, label: Merge request }
      transitions:                 # optional allowlist; absent = free movement
        plan: [plan-review]        # only restricts listed source states —
        plan-review: [plan, implement]  # unlisted states (implement…) move freely
      steps:                       # per state: a map of named actions
        plan:
          description: "Draft and critique the plan"  # reserved key — describes the state
          draft:
            agent: { cli: devin, model: opus, args: "--permission-mode accept-edits" }
            prompt-file: .specify/prompts/plan.md   # or prompt: "…" inline
            auto: true           # fire every time this state is entered
          critique:
            agent: { cli: claude }
            run-in: sub-shell      # shell | sub-shell | headless (default: shell)
            prompt: "Review plan.md adversarially."
          spec-lint:
            command: "sh .ci/spec-lint.sh"   # exit code → check result
            run-in: headless
            description: "Lint the spec files"   # leads the Run button's tooltip
        plan-review: {}            # no actions → human approval gate
        implement:
          agent: { cli: claude, model: sonnet }
          prompt: "Implement the approved plan in specs/."
          description: "Implement the approved plan"  # flat form: describes the state
        qa:
          command: "sh .ci/qa.sh"
```

`workflows` is a free-form map in the plugin's plugins.yaml section. It is
edited by hand — the declarative `settings` fields only cover scalars.

`steps.<state>` is a **map of named actions**. Two sugar forms are
recognized: a step value carrying `agent`/`command`/`prompt`/`prompt-file`/
`run-in` parses as a single anonymous action (named `default`), and a bare
string is shorthand for `{ command: <string> }`. Action names that collide
with the spec keys (`agent`, `command`, `prompt`, `prompt-file`, `run-in`)
are not usable — their presence switches the value to the flat form.

Every action accepts `description` — a human-facing sentence about what the
step does. It leads the Run button's tooltip, and for a state's single
action it also shows in the session banner. In the named-actions map a
reserved `description` key (not an action name) describes the state
itself: it renders in the banner next to the workflow/state title in a
lighter tone, ellipsized when long, full text on hover. A
description-only step (`plan-review: { description: "…" }`) is a
documented human gate — same as `{}`, but self-explanatory.

## Agent personas

`agent:` accepts three forms:

```yaml
# inside workflows.<id>.steps:
  plan: { agent: { cli: devin, model: opus } }   # inline spec (as before)
  review: { agent: reviewer }                     # persona reference
  refine: { agent: { profile: reviewer, model: sonnet } }  # + overrides
```

A bare string — or the `profile` key inside the map — names a persona
declared under `agents.personas` in plugins.yaml (the built-in `agents`
plugin owns that section and mirrors it into the shared `agentRegistry`,
so the reference works even when the plugin's rail view is disabled).
Persona fields (`cli`, `model`, `args`, `instructions`,
`instructions-file`) are defaults underneath the step's own, and a
persona's `prompt`/`prompt-file` are defaults for the action's prompt —
the step's own `prompt:`/`prompt-file:` win.

An unresolved name degrades to `cli: <name>`, so `agent: claude` keeps
launching the claude CLI with no personas configured — a workflow file
never hard-depends on the agents plugin.

### Kickoff prompt vs. instructions

`prompt`/`prompt-file` is the **first message** the agent sees — the task
kickoff. `instructions`/`instructions-file` is the persona's persistent
identity/context (what other tools call system prompt, rules, or developer
instructions). Delivery is owned by each agent plugin's launcher
(`registerAgentLauncher`), not the workflow layer:

- **claude** — `--append-system-prompt-file <path>` for a file,
  `--append-system-prompt <text>` inline (claude reads the file itself).
- **codex** — `-c developer_instructions="…"` config override (the file
  is resolved to text; `AGENTS.md` keeps working natively).
- **gemini** — has no instructions flag. With the gemini plugin's
  `write-gemini-md: true` setting the instructions are written to a **new**
  `GEMINI.md` in the launch cwd — gemini reads it natively — and the
  launch **fails with an error if `GEMINI.md` already exists** (it is
  never merged or overwritten). Without the setting, instructions fold
  into the first prompt.
- **devin** / **unregistered CLIs** — instructions fold in ahead of the
  seed prompt.

Both fields are also accepted on a step's `agent` map and take precedence
over the persona's.

## Workflow variables

A workflow may declare input variables under `vars:` — a map
(`vars: { mr: { kind: mr, required: true, label: …, hint: … } }`, a bare
string value is shorthand for `{ label }`) or a list of `{ key, … }`.
Declared keys are camelized (`mr-url` → `mrUrl`).

Values are set when the workflow starts —
`axn-workflow-start mr-review <url>` fills declared vars in order,
`key=value` pairs set them by name — via the editable fields on the kanban
card, via `axn-workflow-set <var> <value>`, or agent-side via the whole-line
output marker `axn-workflow-var: <key> <value>`. They persist in the
session binding (`pluginState.vars`) and mirror onto cards
(`WorkflowInstance.vars`) so closed-session cards keep showing them.

Vars reach actions two ways:

- **Templates** — `{{key}}` in `command`, `prompt` and `prompt-file`
  substitutes the value (built-ins `state`, `workflow`, `action`, `cwd`,
  `tracking`, `model`, `promptFile` win name collisions).
- **Environment** — every launched action runs as
  `AXN_WORKFLOW=<id> AXN_STATE=<state> AXN_ACTION=<name> KEY=<value> … <cmd>`
  (camelCase/kebab keys → SNAKE), for `shell`, `sub-shell` and `headless`
  alike — a `command:` script reads `$MR`, an agent passes the vars to
  whatever it spawns. `AXN_*` namespaced built-ins can't be shadowed by a
  user var.

A `command` whose first word is `axn-*` is dispatched through the
hidden/plugin command pipeline — the same as a typed line — instead of
reaching the shell verbatim (a literal `axn-git` would just be
`command not found`). A swallowed command records the check as `done`;
a replacement line (`axn-install` → `axn-term install …`) runs in the
shell and reports its real exit code. Anything else passes through
unchanged, so a bogus `axn-foo` still fails honestly with 127.
(`run-in` must be `shell` for dispatch — sub-shell/headless actions
run outside the session input path.)

`kind: mr` marks a value as a merge/pull-request reference — a GitLab MR
url (`…/-/merge_requests/123`), a GitHub PR url (`…/pull/45`) or a bare
`!123`/`#45`/`group/proj!123`. Setting it also derives companions
`<key>_iid`, `<key>_url`, `<key>_project`, `<key>_host` — scripts read
`$MR_IID` directly. Card fields render such values as compact
`!123`/`#45` chips (full url on hover, click opens), and any other
`http(s)` value shortens to host/path. Required-but-empty vars get a `*`
marker; `axn-workflow-start` refuses to start until they're supplied.

## State tracking

The state of record lives **in the session's `pluginState`**
(`sessions[].pluginState['dev-workflow']` in `state.json`) — persisted,
restored on reload, and dropped with the session. It carries
`{workflow, state, updated, history}`.

Optionally, `tracking.file` declares an **agent-writable file mirror** per
workflow: relative paths resolve against the repo toplevel
(`git rev-parse --show-toplevel` via `backend.execGit`), falling back to the
session cwd outside repos; absolute paths are used verbatim. The file's
extension picks the encoding — `.json` → JSON, anything else (`.yaml`,
`.yml`) → YAML. Every transition mirrors the record
`{workflow, state, updated, history: [{state, at}]}` to it through
`backend.readFile`/`writeFile`/`statPath`.

Two agent-driven move channels exist (neither is gated by `transitions`,
which constrain interactive moves only):

- **File write** — with `tracking.file` configured, an agent flips the
  `state:` field and the change is picked up via the shell-output debounce,
  validated against `states`; invalid content raises a warning attention
  flag and is not applied. The resolved path is exposed to steps as the
  `{{tracking}}` template var.
- **Output marker** — an agent prints a whole line
  `axn-workflow-state: <state>` on its stdout; the plugin adopts declared
  states from `onOutput`. Works with or without a tracking file (a
  configured file is kept in sync). The whole-line anchor keeps prose
  mentions from triggering it.

Two more whole-line markers complete the agent-facing channel:

- `axn-workflow-check: <name> <rc>` — report a check result for the named
  action of the current state (`axn-workflow-check: <state>:<name> <rc>`
  addresses another state's action — the form the shell trailer emits so a
  check that outlives a move still lands correctly). Recorded under
  `checks` like a plugin-run result.
- `axn-workflow-run: <name>` — ask the plugin to fire the named action of
  the current state, the agent-side equivalent of its Run button.
  `sub-shell`/`headless` actions dispatch regardless of the foreground
  process; `shell` actions follow the same rules as the button (prompt
  injection into a running same-cli agent, refused under a foreign
  process — a warning attention flag explains the refusal).
- `axn-workflow-var: <key> <value>` — set a workflow var from a step or
  agent (e.g. a computed branch or a verdict path). `kind` derivation
  applies for declared vars; undeclared keys store verbatim.

Every confirmed transition also mirrors into `appState.instances`
(`pluginData['dev-workflow']`) — the kanban view's data source.

## Commands

| Command | Effect |
|---|---|
| `axn-workflow-start [name] [arg\|key=value …]` | Bind the session to a workflow (arg required when several are defined) and enter its start state. Trailing args fill declared `vars` — bare values in declaration order, `key=value` by name; missing `required` vars refuse the start. |
| `axn-workflow-set <var> <value>` | Set a var on the bound session (kind derivation applies); completion lists declared var keys. |
| `axn-mr-review <mr-url\|!N\|#N> [workflow]` | Fetch the MR/PR head into a `wt/mr-<iid>` worktree, open a session there (current workspace) and bind an MR-kind workflow with vars staged — the shell-side sibling of the `review` row button. |
| `axn-workflow-move <state>` | Validate + persist the transition — the entered state's `auto` actions fire; everything else waits for Run. |
| `axn-workflow-run [action]` | Run a named action of the current state (arg optional when the state has exactly one). Shell actions are returned as the replacement command line — the real command, check trailer included, is what gets typed. |
| `axn-workflow` | Echo current workflow + state + the state's check results. |
| `axn-workflow-stop` | Clear the binding (state record is kept). |

Tab completion: workflow names for `axn-workflow-start`, declared state
names for `axn-workflow-move`, action names of the current state for
`axn-workflow-run` — via the `completeArg` extension on `PluginCommand`.

## Action launch model

Per action, `run-in` selects where it runs:

- `shell` (default) — the rendered command replaces the typed line and runs
  in the session's main PTY; the agent becomes the foreground process.
- `sub-shell` — `ctx.openSubShell(command, cwd, label, agent?)` opens a
  labelled sub-shell tab seeded with the command and returns its tab id.
  Command actions run one-shot so the tab's exit code is the check result;
  agent actions append `; exec $SHELL -l` so the tab stays usable after the
  seed exits, and a resumable agent cli (`devin`/`claude`/`gemini`/`codex`
  — resolved through `profile` references too) marks the tab `agent` so
  re-spawns resume the conversation instead of re-seeding.
- `headless` — one-shot via `ctx.exec`, no terminal — fire-and-forget
  (`sh .ci/qa.sh`, `devin -p`, notifications).

### Check results

A `command` action's exit status is recorded in the session binding under
`checks['<state>:<name>'] = { status, rc?, at, message? }` with
`status: running | ok | failed | done` — **informational only**, checks
never gate transitions. The capture channel depends on `run-in`:

- `shell` — the typed line gets a trailer
  `; rc=$?; printf '\naxn-workflow-check: %s:%s %d\n' <state> <name> "$rc"`;
  the marker is scanned back out of PTY output (whole-line, chunked
  safely).
- `headless` — `ctx.exec` rejects on non-zero; the rejection's message
  (first stderr line) becomes the check's `message`.
- `sub-shell` — `ShellApp` routes `backend.onSubshellExit` to the plugin's
  `onSubShellExit(ctx, tabId, exitCode)`; the plugin correlates the tab id
  `openSubShell` returned. The web backend reports `null` (no exit code on
  its disconnect frame) → recorded as neutral `done`, not success/failure.
  Enter re-runs in the tab keep updating the badge — the pending mapping
  outlives the first exit.

A state's checks are discarded when the state is (re-)entered — a stale
green `spec-lint` from two visits ago is worse than none. Agent actions
record no implicit check (the plugin can't observe conversational
success); an agent that wants to report one prints the
`axn-workflow-check:` marker itself.

Agent command presets (`cli: devin|claude|vibe`) render the right flags;
a raw `command:` template with `{{prompt}}`, `{{promptFile}}`, `{{model}}`,
`{{state}}`, `{{workflow}}`, `{{action}}`, `{{cwd}}`, `{{tracking}}`
placeholders plus any declared var (`{{mr}}`, `{{mr_iid}}`, …) covers
anything else — and `prompt:`/`promptFile` text expands the same vars
(minus `{{prompt}}` itself).
Prompts embed via the base64 `promptArg` trick from `gitReview.ts`, so
arbitrary prompt text survives `sh -c` quoting.

| Agent | Interactive seed | Headless | Model flag | Resume |
|---|---|---|---|---|
| devin | `devin --model X -- "<prompt>"` / `--prompt-file` | `devin -p` | `--model` | `devin -r <name>` / `-c` |
| claude | `claude --model X "<prompt>"` / `--append-system-prompt` | `claude -p` | `--model` | `claude -c` |
| vibe | command template | via template | via `args:` | — |

## UI surfaces

- **Session banner** (`ctx.setBanner`): `<workflow title> · <state>` —
  non-dismissible (`dismissible: false`), stays while the session is bound
  and is cleared by `axn-workflow-stop`. The banner always renders both
  prev/next chevron actions (`SessionBanner.actions`) **before** the state
  name — the unavailable edge renders `disabled` instead of disappearing, so
  state-name length never shifts the controls. `SessionBanner.trailingActions`
  carries one `▶ <name>` button per action of the current state (`run:<name>`
  ids; the anonymous sugar action renders `Run agent`/`Run step`). Command
  actions append a compact check badge to the label (`…` running, `✓` ok,
  `✗` failed, `•` done-without-rc) and the last result joins the tooltip.
  Clicks route to the plugin's `onBannerAction` hook (`prev`/`next`/
  `run:<name>`). Each button is process-aware (`actionRunInfo`): while a
  foreign foreground process owns the terminal it renders `disabled` with
  the reason as its tooltip, and while the action's own agent is already
  running it becomes `Send prompt` — `onOutput` re-renders the banner
  whenever that eligibility flips or a check lands.
  Errors during moves surface as session attention, not by replacing the
  state banner.
- **Session row** (`renderRow`): compact state chip next to the session name.
- **Session context menu** (new `sessionMenuItems` hook): "Start workflow"/
  "Start: <name>", or when bound one "Run <name>" row per action of the
  current state + "Workflow <id> → <state>" move rows + "Stop workflow".
- **Rail** (`renderRail`): icon + active-workflow count.
- **Kanban view** (`renderView`): columns = the workflow's declared states
  (stretched to fill the view, `min-w` + horizontal scroll on narrow windows),
  cards = sessions; clicking a card selects the session (needs `sessions` /
  `selectSession` on the renderView ctx). Card layout: header row with the
  session's process icon (same `sessionIcons` resolution as the session row)
  and name; the session's `summary` (set via `axn-session-summary`) as a
  truncated line directly below the title when set; one editable field per
  declared workflow var (click to edit inline, Enter saves, MR/PR values
  render as `!N`/`#N` chips); a lighter row of plain
  chevrons to the previous/next state at
  the far left/right with a `remove` text button centered (on a live card it
  removes the session from the workflow, on a stale card it removes the
  card); and a stack of full-width `▶ <name>` buttons below — one per
  action of the current state, each carrying a colored check badge and the
  last result in its tooltip (`state: {}` is a human gate and gets none).
  On a transition the entered state's `auto` actions fire (the on-enter
  hook — e.g. `command: axn-focus` pulls the session's main shell back into
  view; `command: axn-git …` opens Git Inspect) — every other action still
  waits for its Run button, and Run never interrupts a running process. `shell` actions need a free
  prompt: while a foreign process owns the terminal the button is disabled
  with the reason in its tooltip (`'claude' is running — stop it to run
  'draft'`). When the action's own agent cli is already foreground, Run
  becomes `Send prompt` and injects the action's prompt via bracketed paste
  + CR — queued by a busy agent, run immediately by an idle one.
  `sub-shell`/`headless` actions launch regardless of the foreground
  process.
  Cards whose session vanished without an `onClose` (state import, replaced
  PTY) are pruned automatically by the always-mounted rail. Cards also move
  via drag-and-drop onto another column — only `transitions`-allowed targets
  accept the drop (allowed targets highlight dashed, disallowed dim). The
  shared `IconButton` (`libs/shell-ui/src/app/IconButton.tsx`, sizes
  `sm`/`md`/`lg`) covers the session header and banner action buttons.

## Merge-request review

A workflow whose `vars` declares a *required* `kind: mr` variable gets a
button labelled with the workflow's `title` (e.g. "MR review") on every MR
row in the gitlab-mr plugin — one per such workflow, so several stay
distinguishable. An optional `kind: mr` var (a development flow that records
its own MR later) gets no row button. The button appears in the full merge-requests
view *and* the per-session MR list. The seam is `mrActions.ts`: plugins
`registerMrActions(id, Provider)` at module scope and glab-mr renders each
registered provider component on its rows with `{ mr, env }`
(`env.sessions`/`apiFor`/`selectSession`) — a contribution point like
`workspaceMenuItems`, no import coupling between the plugins. dev-workflow
registers itself at module scope; the button only renders when
`dev-workflow.enabled` and the workflow exists in live `plugins.yaml`.

Clicking it (`startMrReview`):

1. Picks the target workspace: the first workspace (panel order) belonging
  to the MR's project — either scoped to the repo via the workspace's
  `defaultFolder` (basename matches the project's repo name), or hosting a
  session whose repo matches (`session.repo.remote` contains the project
  fullPath, or the checkout's directory name matches). When no workspace
  matches, an anchored workspace picker pops up (the shared
  `WorkspacePicker` context-menu component) and the review session opens in
  the workspace you choose.
2. Resolves a session in that repo to run git through (`session.repo.remote`
  match; falls back to any repo session — errors surface as an attention
  flag, the current session is never touched).
3. `git fetch origin <ref>` — `merge-requests/<iid>/head` for GitLab urls,
  `pull/<iid>/head` for GitHub — then `git worktree add <dir> -B
  wt/mr-<iid> FETCH_HEAD` at the worktrees-plugin location
  (`<repo-parent>/worktrees/<repo>-mr-<iid>`), so `axn-dev` discovers it.
  Re-reviewing reuses the existing worktree (`git merge --ff-only
  FETCH_HEAD` when the tree is clean — a dirty/diverged one stays as-is);
  failures surface as a red `failed` state on the button *and* a modal
  dialog with the message (Esc/backdrop dismisses; the `failed` label
  persists for retry), not only as a session attention flag. A rejected
  launch is reported the same way — no silent `preparing…` flicker. While
  the fetch + worktree + spawn run, the button shows a `preparing…`
  spinner.
4. `openSession(worktree, '!123 title', workspaceId)` opens a fresh session
  in the chosen workspace; the
  plugin's `onSessionOpen` consumes the staged entry from
  `pendingReviews`, stores the MR vars (`mr` = url plus derived
  `mr_iid`/`mr_url`/`mr_project`/`mr_title`/`mr_branch`/`mr_target`,
  `worktree`, `branch`) and enters the workflow's `start` state. Because
  the session's cwd is a linked worktree, the worktrees plugin's
  `onSessionOpen` probe also stamps `pluginState.worktrees.worktree` —
  the `⎇` badge and worktree menu items appear without it having created
  the worktree.
5. The entered state's actions marked `auto: true` fire automatically —
  on start once the session's first output arrives (all start paths — the
  review button, `axn-workflow-start`, menu start), and on every later
  state entry (immediately). Unflagged steps still launch via the Run
  affordance. Typical auto steps are `command: axn-git
  origin/{{mr_target}}` — opens Git Inspect with a "Changes vs
  origin/<target>" section (the merge-base diff — what the MR would
  change) — and `command: axn-focus` to pull the main shell back into
  view on a human-gate state.

A minimal review workflow is pure config:

```yaml
dev-workflow:
  enabled: true
  workflows:
    mr-review:
      title: MR review
      states: [inspect, review, verdict]
      vars:
        mr: { kind: mr, required: true, label: Merge request }
      steps:
        inspect:
          command: axn-git origin/{{mr_target}}   # Git Inspect + compare diff
          auto: true                  # fires when the session binds
        review:
          agent: { cli: claude }
          prompt: "Review MR {{mr}} ({{mr_title}}): diff vs {{mr_target}} in this checkout."
          run-in: sub-shell
        verdict:
          command: axn-focus          # human gate — back to the main shell
          auto: true                  # on-enter: fires on every transition in
```

The same path works from a shell without the gitlab-mr plugin:
`axn-workflow-start mr-review https://gitlab.com/g/p/-/merge_requests/114`
binds the current session with `mr` + companions pre-filled (no worktree
created — the start-args path just binds).

## Platform/API additions

- `SessionViewPlugin.sessionMenuItems?: (ctx) => MenuItem[]` — contributed
  rows in `SessionContextMenu` (mirrors `repoMenuItems`).
- `PluginCommand.completeArg?: (ctx, prefix) => string[] | Promise` —
  dynamic argument completion alongside `argCompletion`.
- `PluginApi.readFile`/`writeFile`/`statPath`/`mkdir` — session-scoped fs
  access (`mkdir` needed because fs-write doesn't create parent dirs).
  On the web session host, fs mutations run as the PTY user via `setpriv`
  (same as `exec`), so plugin-created files are owned by the shell user and
  stay agent-writable.
- `PluginApi.openSubShell(command?, cwd?, label?, agent?)` — returns the
  new tab/PTY id and forwards the `agent` marker so office tabs resume
  conversations.
- `SessionViewPlugin.onSubShellExit?: (ctx, tabId, exitCode) => void` —
  fired when a session sub-shell exits; `ShellApp` routes
  `backend.onSubshellExit` (ptyId → owning session → enabled plugins).
  Desktop reports the real exit code, web `null`.
- `renderView` ctx gains `sessions` (id/name/workspaceId/cwd) and
  `selectSession(sessionId)` for kanban → session jumps.
