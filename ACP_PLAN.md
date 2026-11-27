# ACP session type — scratch plan (throwaway)

Goal: a new session/view kind where axn-term hosts an agent via the Agent
Client Protocol (JSON-RPC over stdio) with a custom chat frontend — instead
of running the agent's TUI in a PTY and scraping its screen.

Non-goal for v1: replacing PTY agent sessions. Both coexist — the TUI
session keeps hooks/scraping, the ACP session is the structured lane.

## What already exists to reuse

- **Session chrome**: `session.tasks`+`progress`, `status`
  (idle/running/blocked/completed), `attention` + OS notify, tab dots — all
  driven by `ctx.updateSession`/`setAttention`, exactly what the hook
  bridge feeds today. ACP events land on the same sinks, minus polling.
- **Sub-shell tabs** (`ctx.openSubShell`, `SubShellView`, `hookPluginFor`):
  real PTYs — the answer to ACP's `terminal/*` client methods (better than
  Zed's embedded terminal).
- **`SessionBackend` fs port** (`readFile`/`writeFile`/`statPath`,
  desktop fs-scope grants) → ACP `fs/read_text_file`/`fs/write_text_file`.
- **`agentRegistry` personas** (cli/model/args/instructions) + launchers —
  add an `acp` launch flavor; `openSession(cwd,name)` for spawning.
- **`agentResume` shared "last session"** machinery → ACP `session/list` +
  `session/resume` (no more exit-hint scraping).
- **Borrowed chat UI** from `tassistant-frontend`:
  - `apps/assistant/src/components/ChatInterface/ChatInterface.tsx`
    (~400 lines: message list, composer, streaming-event handling,
    **approve/reject action handlers** — the permission-UX skeleton)
  - `apps/flow-inspector/src/components/steps/ToolCallStep.tsx` —
    tool-call card reference
  - **Restyle, don't restyle-blind**: tassistant styles don't carry over —
    port the markup/behavior onto axn-term theme tokens (`var(--accent)`,
    `--text-secondary`, surface/attention colors — same `text-[var(--…)]`
    pattern the plugins use), `themes.ts` font settings
    (`panelFontFamily`/`panelFontSize` for the chat view, `shellFontFamily`
    for code/terminal blocks), light+dark theme variants, and the app's
    `IconButton`/`data-tip` tooltip conventions — so the view follows the
    user's configured theme like everything else.
- **Modals/pickers**: `SearchPickerModal`, `ContextMenu`, `pickFromList` —
  permission options (allow-once/always/deny), agent/persona pickers.

## The genuinely new pieces

1. **Stdio child-process seam in the backend** (the ACP agent is a spawned
   subprocess, not a PTY):
   - Desktop: Tauri command(s) — `acp_spawn(cmd,args,cwd,env)` → id,
     `acp_write(id,line)`, `acp-event` channel for stdout lines/exit.
     (Alternative: generic `spawn_pipe` primitive usable by other plugins.)
   - Web: needs a live bidirectional channel — plain `exec` can't carry a
     stdio pipe. Ramphastos duplex streams fit (`RemoteBackend` style);
     WsBackend needs a new `/ws` message type or session-host-side ACP
     hosting. Defer web to a later phase.
2. **ACP client** — `@zed-industries/agent-client-protocol` (check the
   newer `@agentclientprotocol/sdk` — the claude adapter already depends
   on it): `initialize` (caps: fs, terminal, protocolVersion),
   `auth/login`, `session/new`, `session/prompt`, `session/cancel`,
   `session/list`, `session/resume`, `session/set_mode`.
3. **Chat renderer** — `agent_message_chunk`/`agent_thought_chunk`
   markdown streaming, `tool_call`/`tool_call_update` cards (kind icon,
   locations, diff content, terminal output link), `plan` list.
4. **Permission modal** — answers `session/request_permission` with an
   optionId; pending state = `blocked` + critical attention.
5. **Composer** — prompt field (multi-line), cancel button while a turn
   runs, optional `@file` mention (content blocks).

## Event → chrome mapping

| ACP event | axn-term sink |
|---|---|
| `plan` | `session.tasks` (entry.status → Task.status) + progress |
| prompt in-flight / `stopReason` / cancel | `session.status` running/completed/idle |
| `session/request_permission` | `blocked` + critical `attention` + modal; resolve → running |
| `tool_call` | chat card; `terminal` kind → link/jump to the PTY tab |
| `terminal/create|output|release|kill` | sub-shell PTY (createSubshell), feed output, `tab.hookStatus` n/a |
| `fs/read_text_file|write_text_file` | `backend.readFile`/`writeFile` (scope = session cwd; respect `fileAccessRoots`) |
| `session/load|resume` replay | repopulate chat history in the view |

## Session model sketch — DECIDED

**An ACP session is a tab inside a session, not a session type.** The
session stays the container (main PTY + sub-view tabs); the agent chat is
one more tab kind next to git/editor/shell/browser — so sub-shells and
the file browser come for free and nothing in the session model changes.
`axn-acp <agent>` / `axn-agent <persona>` opens the tab; several tabs =
several concurrent conversations. The tab still drives session chrome
(tasks/status/attention), so the panel row and tab dot keep working even
when the chat isn't visible.

**Shell-less sessions — DECIDED.** A session's main view is a property,
not the session type: `mainView: 'shell' | 'agent'` (name `agent`/`chat`
in UI — keep `acp` internal). Resolution order: the session's own
`mainView` → the workspace's `mainView` (same slot `defaultFolder`
occupies on the Workspace record — an "agent research" workspace can
default to chat) → `sessionDefaults.mainView` in config.yaml → `shell`.
Chosen per session at creation ("New session" vs "New agent session"
rows). Shell-less consequences, accepted up front:

- No bare prompt → `axn-*` typed interception can't work. Replacement:
  slash commands in the composer, two tiers — agent-advertised
  `availableCommands` (passed through to the agent) and axn-term's own
  `/axn-*` commands (routed through `ctx.runCommand`, never reach the
  agent) — plus session/workspace context menus.
- `session.cwd` becomes explicit (ACP `session/new` takes `cwd`) — no
  more probing `/proc/<pid>/cwd` for these sessions.
- Process-bound plugins (hooks, `fg-process`) have nothing to bind to —
  the plugin model already tolerates absent optional methods; sub-shell
  tabs still get their own PTY + hook wiring.
- `axn-sh`/sub-shells/editors/git tabs unchanged — they're their own
  PTYs.

Explicitly NOT rebuilding Zed: no editor, no buffer model, no LSP.
Diffs in tool-call cards are read-only; file actions go through the
existing `axn-edit`/`axn-browse` tabs; `terminal/*` requests land in real
sub-shell tabs. The chat tab is a conversation lane, not an IDE.
- `pluginData.<key>.acp` = { agentCmd, sessionId, cwd, historyCapped } —
  history replay via `session/resume`, not state.json blobs.
- Window tear-off/adopt: no xterm replay needed — the target window
  `session/resume`s the same conversation id. Nicer than PTY sessions.

## Agents to target (in order)

1. `claude-agent-acp` (`@agentclientprotocol/claude-agent-acp`) — official
   adapter, richest feature set (todos, permissions, terminals, edit review).
2. `codex-acp` — ACP-org adapter.
3. `vibe` — Mistral Vibe speaks ACP natively; we already have a vibe plugin.
4. `opencode acp` — native.
5. `gemini --acp` — API-key/enterprise only (consumer sunset).
6. `agy` — no native ACP (issue #31 open); community `agy-acp` wraps a PTY +
   reads the conversation SQLite DB — possible but fragile; keep as backlog.

Persona shape: `agents.personas.<n>: { acp: 'npx -y @agentclientprotocol/claude-agent-acp', cwd?, env? }`
or `{ cli: claude, acp: true }` resolved via a small registry of known
ACP launch lines (same `agentLauncherFor` seam, new output kind).

## Phases

- **M1 (desktop only)**: `acp_spawn/write/event` commands; `AcpClient` in
  `libs/` wrapping the SDK; minimal chat view (streamed text + composer);
  session create/prompt/cancel; `plan`→`session.tasks`, turn→`status`.
- **M2**: `request_permission` modal (+attention); `tool_call` cards with
  diffs; `fs/*` via backend; error/auth surfaces.
- **M3**: `terminal/*` → sub-shell PTY tabs; personas + pickers;
  `session/list`+`resume` → resume row + history replay; window adopt.
- **M4**: web transport (ramphastos stream or `/ws` pipe message);
  `agy` via `agy-acp` if still wanted.

## Testing

- Fixture agent: tiny node script speaking NDJSON JSON-RPC (echo
  initialize, canned session/update streams, a permission round-trip) —
  same style as `agentTransport.test.ts` real-PTY fixtures.
- Unit: update→tasks/status/attention mapping on the `agentTestkit`
  harness; hooks untouched.
- E2E: `tests/acp-e2e.mjs` against session-host once web lands (pattern:
  `remote-backend-e2e.mjs`).

## Open questions

- Session type vs plugin view tab (see sketch) — decide after checking how
  `SubShellView`/`hostsTabs` mount.
- Which SDK line: `@zed-industries/agent-client-protocol` 0.4.x vs
  `@agentclientprotocol/sdk` 0.14.x (v2 spec: `session/resume`/`list`).
- Capabilities: we support `terminal` + `fs` + `loadSession`; `subagents`
  and `_meta` extensions can wait.
- Auth UX: agent `authMethods` → login flow in-view (browser open +
  env/API-key field).

## Implementation status (checkpoint)

Done (commits on feat/acp-session):
- `libs/shell-ui/src/app/acp/types.ts` — ACP wire subset
- `acpClient.ts` — NDJSON JSON-RPC over `AcpPipe` (init/sessionNew/prompt/cancel, permission+update dispatch, generic errors for fs/terminal)
- `AcpChatView.tsx` — themed chat UI (tassistant pattern, axn tokens)
- `tauriPipe.ts` — `tauriAcpPipe(cmd,args,cwd)` → AcpPipe
- `lib.rs` — `acp_spawn`/`acp_write`/`acp_close` + `acp-event-<id>` (NOT cargo-checked yet)

Next slice (mounting + chrome):
1. Tab kind or `mainView` path to mount `<AcpChatView pipe={await tauriAcpPipe(...)} cwd={session.cwd}/>` — entry point `axn-acp` command + "New agent session" row; see ShellApp tab render block (~line 2131 in apps/web-era ShellApp.tsx, `ed.kind ===` switch) and `openTab` in plugin API.
2. Map to chrome: plan→`session.tasks`, turn→`session.status`, permission→`attention` (currently view-local `turn` state).
3. `cargo check` the Rust before pushing.
