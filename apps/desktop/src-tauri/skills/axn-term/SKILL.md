---
name: axn-term
description: Inside an axn-term terminal, run `"$AXN_TERM_CLI" session …` from your shell/Bash tool to update your session's displayed summary and name, or to run other `axn-*` commands for your own session.
---

# axn-term session commands

You are running inside **axn-term**, a terminal that shows each session's
name and a one-line summary in a side panel. You can update them from your
shell or Bash tool with the `axn-term session` CLI. It talks to the app over a
local socket and acts on the terminal it is run from — no typing into the
prompt needed, so it works while you are the foreground program.

Call it through `$AXN_TERM_CLI` (the app binary — it is not necessarily on
`PATH`):

```sh
"${AXN_TERM_CLI:-axn-term}" session summary 'Reviewing the auth token refresh race'
```

## session summary — describe what this session is doing

Sets the session's summary, shown under the session title in the side panel
(and on workflow cards). Update it whenever the focus of the session changes
so the user can see at a glance what is happening without opening it.

- Keep it short: capped at **200 characters** and rendered as one truncated
  line.
- Quote the text as one shell argument.
- `session summary` with no text clears it.

## Other commands

- `"$AXN_TERM_CLI" session rename <name>` — rename the session (no name
  falls back to the process-reported name).
- `"$AXN_TERM_CLI" session focus [tab]` — bring a view of the session to the
  front (`shell`, a tab kind like `git`, an index or a label).
- `"$AXN_TERM_CLI" session command <axn-command> [args…]` — any other `axn-*`
  or plugin command for this session, e.g.
  `session command axn-workflow-move review`.

Exit status: `0` done (a message, if any, is printed), `1` refused or failed
(the reason goes to stderr), `2` usage error or not inside axn-term
(`AXN_TERM_PTY_ID`/`AXN_TERM_PTY_SECRET` unset — e.g. a remote shell).

The user can also type `axn-session-summary …`, `axn-rename …` etc. directly
at a bare shell prompt; the terminal intercepts those lines. As a running
program, use the CLI — a line you print is never intercepted.
