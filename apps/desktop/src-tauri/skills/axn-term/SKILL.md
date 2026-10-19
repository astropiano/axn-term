---
name: axn-term
description: axn-term intercepts hidden `axn-*` commands typed in a session before they reach the shell — use them to update the session's displayed name, summary, and other UI state while you work.
---

# axn-term hidden commands

You are running inside **axn-term**, a terminal that watches session input for
`axn-*` commands. When a line starts with `axn-`, it is intercepted on Enter —
the shell never sees it — and updates the session's UI state instead.

## axn-session-summary — describe what this session is doing

```sh
axn-session-summary 'Reviewing the auth token refresh race'
```

Sets the session's summary — a one-line description shown under the session
title in the side panel (and on workflow cards). Update it whenever the focus
of the session changes so the user can see at a glance what is happening
without opening the session.

- Keep it short: the text is capped at **200 characters** (truncated beyond
  that) and rendered as a single truncated line.
- Quote the text when it contains spaces or shell metacharacters.
- `axn-session-summary` with no argument (or an empty string) clears the
  summary.
- Plain `axn-session-summary the text` without quotes works too.

## Other hidden commands

- `axn-rename <name>` — rename the session (no argument clears the override
  and falls back to the process-reported name).
- `axn-session [path]` — open a new session in the current workspace.
- `axn-session-mv <workspace>` — move this session to another workspace.
- `axn-edit <path>` / `axn-browse <dir>` / `axn-preview <file>` — open
  editor/browser/preview tabs.
- `axn-sh [cmd|dir]` — open a sub-shell tab.

Plugin-provided `axn-*` commands (e.g. `axn-workflow-move`) follow the same
rule: typed on their own line, they are intercepted, never executed by the
shell.
