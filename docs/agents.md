# axn-term for AI agents

axn-term is a terminal that watches session output and gives the user a live
side-panel view of what each session is doing. If you are an AI agent running
inside axn-term, this document describes what the terminal sees and which
conventions to follow. Content here is meant to be copied into `CLAUDE.md`,
`AGENTS.md`, or equivalent agent-facing docs.

## Task lists drive the progress UI

The terminal tracks your task list — for Devin ≥3000.11 by scanning the
visible screen for the todo block (it renders in the TUI's live region,
not scrollback), for older Devin CLIs and Claude Code by parsing the
rendered `⏺ Updated todo list` / `Update Todos` block — and turns it into
a live progress bar plus a task list in the session panel.

- Maintain your internal task list for multi-step work.
- Update it immediately when a step completes — a stale list means a stale
  progress bar. Do not batch task updates for the end.
- Keep at most one task in progress at a time.

The `axn-term-agent-tasks` skill carries these instructions
(`axn-term install --skills` installs it into agent skill directories).

## Progress output

The terminal scans the live screen for progress indicators (`45%`,
`[###---]`, `3/10`). Notes for tool wrappers:

- Indicators must persist ~500 ms before they are reported — transient output
  is ignored by design.
- When several bars are on screen, the bottom-most line is reported.
- When no bar remains on screen, the indicator is withdrawn.

## `axn-term session` — commands for your own session

A program running inside an axn-term terminal (an agent's Bash tool, a
script) can't type the hidden commands below — they are only intercepted
when typed at a bare shell prompt. Use the CLI instead; it reaches the app
over a local socket and acts on the terminal it runs in:

```sh
"${AXN_TERM_CLI:-axn-term}" session summary 'Reviewing the auth token refresh race'
"$AXN_TERM_CLI" session rename api-refactor
"$AXN_TERM_CLI" session focus git
"$AXN_TERM_CLI" session command axn-workflow move review   # any axn-*/plugin command
```

- Every PTY is started with `AXN_TERM_PTY_ID`, a random per-PTY
  `AXN_TERM_PTY_SECRET` and `AXN_TERM_CLI` (the app binary, which need not
  be on `PATH`). The CLI sends id + secret + the command line to
  `$AXN_TERM_STATE_DIR/control.sock` (mode 0600); the app checks the secret
  it minted for that PTY and runs the line through the same dispatch as a
  typed one. A sub-shell tab is its own PTY — commands act on the session
  that owns it.
- Exit status `0` = done (a command's message is printed), `1` = refused or
  failed (reason on stderr — e.g. a command whose result would have to be
  typed into the shell, like `axn-claude-resume`), `2` = usage error or not
  inside axn-term.
- From outside a terminal (a hub, a script), `axn-term command
  [--window <label>] <line>` runs an *app-level* command in the focused
  window — only commands that declare themselves app-level, e.g.
  `axn-term command axn-views open http://127.0.0.1:37778/d/mr/ "MR dashboard"`
  (opens a page as a rail view; `axn-views current` prints the selected view
  as JSON). No secret: the socket is the user's own (0600). Desktop only.
- Web terminals work the same: the session host writes a small `sh` + `curl`
  client to `$AXN_STATE_DIR/bin/axn-term` and points `AXN_TERM_CLI` at it;
  it authenticates with `AXN_SESSION_ID` + `AXN_TERM_PTY_SECRET` against
  the host's `control.sock`, which forwards the line to the browser tab
  showing that terminal.

The `axn-term` skill (`axn-term install --skills`) carries these
instructions for agents.

## Hidden `axn-*` commands

These are intercepted by axn-term when *typed* at a bare shell prompt — the
user's way in. Printing one in output does nothing; from inside a running
program use `axn-term session …` above:

- `axn-session [-w|--workspace <name>] [-n|--name <name>] [--background]
  [--create-ws] [path]` — open a new session in a workspace (`.` or no path
  uses the session cwd). `-w` targets a workspace by name — it must exist
  unless `--create-ws` opts into creating it; `-n` names the session;
  `--background` spawns it without stealing the user's focus. As a running agent, spawn sessions with
  `"$AXN_TERM_CLI" session command axn-session -w <workspace> [--background]`.
- `axn-session-mv <workspace>` — move the session to another workspace.
- `axn-session-window` — move the session into a new window of its own.
- `axn-sh [command|dir]` — open a sub-shell tab (one-shot command or
  interactive shell).
- `axn-edit <path>` — open a file in the built-in editor tab.
- `axn-browse <path>` — open a directory-browser tab.
- `axn-rename [name]` — rename the session/tab (empty restores the default).
- `axn-session-summary [text]` — set the session's summary — a one-line
  description shown under the session title in the panel and on workflow
  cards. Update it when the session's focus changes. Capped at 200 chars;
  no argument clears it.
- `axn-install [args]` — runs `axn-term install <args>` (e.g.
  `axn-install --skills --devin`).
- `axn-workspaces` — list workspaces; the session's own is marked `*`.
- `axn-session list` — list every session, `*` on the one it ran in, with
  its workspace. As a running agent this is how you discover peers:
  `"$AXN_TERM_CLI" session command "axn-session list"`.
- `axn-broadcast [-t|--to <session>] <line>` — write the line (with Enter)
  to every session in the broadcast set, or to a single session with
  `-t`/`--to <name-or-id>`; `axn-broadcast-add [name]`/`axn-broadcast-rm [name]`
  mark/unmark sessions (current session when no name), `axn-broadcast-clear`
  empties the set, `axn-broadcasts` lists it. Broadcast-marked sessions show
  a radio badge in the panel; the session menu toggles membership. The
  `--to` line goes verbatim — it is a transport, not a message.
- `axn-tell <session> <message>` — message another session (agent↔agent):
  delivers `[axn-tell from "<your session name>"] <message>` as input to
  the target. If the target's foreground is a shell it arrives as a `#`
  comment (scrollback/history) instead of erroring as a command; an agent
  TUI gets the plain envelope as its next prompt. From inside a session:
  `"$AXN_TERM_CLI" session command "axn-tell <name> <message>"`.
- `axn-session-up/down`, `axn-workspace-up/down` — reorder sessions/workspaces.
- `axn-focus [tab]` — bring a session view to the front: bare or `shell`
  selects the main terminal; otherwise a sub-view tab matched by index,
  kind (`git`, `editor`, `shell`, `preview`, `browser`), id prefix, or
  label. Selecting the tab also selects the session and dismisses a
  covering plugin view.
- `axn-awesome [ls|add <path|url> [label]|rm <n|path>]` — manage the awesome
  list bookmark panel (plugin, enabled by default).
- `axn-workflow` (or `axn-workflow status`) reports the binding.
- `axn-workflow start [name] [arg|key=value …]` — bind the session to a dev
  workflow and enter its start state (name required when several are
  defined). Trailing args fill the workflow's declared `vars` — bare values
  in declaration order, `key=value` by name.
- `axn-workflow set <var> <value>` — set a declared var on the bound
  session. A step or agent can also emit
  `axn-workflow-var[<token>]: <key> <value>` on a whole output line (see the
  token note under `axn-workflow move`). Vars substitute into `{{key}}` action templates
  and export to actions' env as `KEY` (plus `AXN_WORKFLOW`/`AXN_STATE`/
  `AXN_ACTION`/`AXN_WORKFLOW_TOKEN`).
- `axn-workflow start <workflow> <mr-url|!N|#N>` — when the value fills
  the workflow's `kind: mr` var: fetch the merge/pull-request head
  (`merge-requests/N/head`, GitHub `pull/N/head`) into a `wt/mr-<iid>`
  worktree (an existing review worktree is reused and fast-forwarded when
  clean), open a new session there and bind the workflow, vars pre-filled
  (`mr_role` included). The var's `when` (e.g. `role: reviewer`) must hold
  for your role on the MR. The current session is untouched.
- `axn-workflow move <state>` — transition the bound workflow to `<state>`
  (fires the entered state's `auto` actions — the on-enter hook; other
  steps still wait for the human's Run). As a *running agent* hand off with
  `"$AXN_TERM_CLI" session command axn-workflow move <state>` (see
  `axn-term session` above), or by printing a whole line
  `axn-workflow-state[<token>]: <state>` to stdout (the plugin adopts
  declared states), or — when the workflow has `tracking.file` — updating `state:` in
  that file. That's how a speckit-style agent hands a finished `plan` to
  human `plan-review`. `<token>` is the binding's secret — `$AXN_WORKFLOW_TOKEN`
  in the env of everything the workflow launches, `{{workflow_token}}` in its
  prompt templates; markers without it are ignored, so a file you `cat` can't
  drive the workflow. Print the marker with the token expanded, e.g.
  `echo "axn-workflow-state[$AXN_WORKFLOW_TOKEN]: review"`.
- `axn-workflow run [action]` — run a named action of the current state
  (name optional when the state has exactly one). Two more whole-line output
  markers extend the handoff protocol: `axn-workflow-run[<token>]: <name>` asks the
  plugin to fire that action (equivalent of pressing its Run button), and
  `axn-workflow-check[<token>]: <name> <rc>` reports a check result for a command
  action — `<state>:<name> <rc>` addresses a check on another state.
- `axn-workflow` — echo the session's bound workflow/state;
  `axn-workflow stop` — clear the binding. Both need
  `dev-workflow.enabled: true`; see docs/dev-workflow.md.

## Environment

- `AXN_SESSION_ID` is set inside sub-shell tabs (`axn-sh`) to the owning
  session's id.
- Plugin settings live in `~/.axn-term/plugins.yaml`
  (`<plugin>.enabled: true|false`, kebab-case keys normalized to camelCase).
  The `claude` plugin — including Claude Code task tracking and
  `axn-claude-resume` — is opt-in via `claude.enabled: true`.

## Claude and Codex support checks

Enable the desired agent plugin in `plugins.yaml`. `install-hooks: true`
installs the hook transport when the process is first detected; restart the
agent after that first installation so it loads the new configuration.
Codex additionally requires reviewing and trusting the exact hooks through
`/hooks`; AXN Term does not bypass that review.

```yaml
claude:
  enabled: true
  install-hooks: true
codex:
  enabled: true
  install-hooks: true
```

Both plugins expose running/blocked/completed status and resume commands
(`axn-claude-resume`, `axn-codex-resume`). Claude also parses the rendered
`Update Todos` task list. Codex currently provides lifecycle status, not a
parsed Codex plan/task list. Resume selects each CLI's latest conversation
in the working directory; it is not an exact conversation-id binding.

The desktop injects `AXN_TERM_PTY_ID` and `AXN_TERM_STATE_DIR` into each
PTY. Hook children inherit those values, so JSON on stdin and detached hook
execution do not lose the terminal identity. The script atomically writes a
private event file; foreground polling does not override hook-owned status.

After building the desktop app, run the native contract test from the repo
root (on affected Wayland systems prefix with
`WEBKIT_DISABLE_DMABUF_RENDERER=1`):

```bash
python3 flows/check-agent-support.py
# Opt-in: also use the installed, logged-in CLIs for small no-tools model
# requests and verify conversation recall after resume.
python3 flows/check-agent-support.py --live
```

The deterministic test uses fixture agent processes, real native PTYs, real
hook installation and piped JSON, and the existing `/state` and session
control API. It verifies both agents' status/attention, session isolation,
Claude task progress, and resume-command routing. Fixture checks are not
live-model proof. `--live` adds real response/resume checks; it does not grant
Codex hook trust. The test uses disposable directories beneath
`~/.local/state/axn-term-tests`, leaves logs there, and closes its own app.
`AXN_TERM_AGENT_CONFIG_ROOT` redirects only AXN Term's agent-hook installation
for this harness; it does not change the user's home, agent logins, or agent
configuration discovery.

## Gotchas

- To end a Devin session, write `/exit` and send `\r` separately — a combined
  `/exit\r` write is treated as pasted multiline input, not submission.
- Session output retained for parsing is capped (200k chars); never rely on
  scrollback for state — use screen content or fresh output.
