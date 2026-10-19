---
name: axn-term-agent-tasks
description: Keep your internal task/todo list continuously updated — axn-term watches the rendered list in your terminal output and mirrors it as live progress for the user.
---

# axn-term agent tasks

You are running inside **axn-term**, a terminal that watches your CLI output
for rendered task lists and progress bars and mirrors them to the user in a
session side panel.

## What to do

- Maintain your internal task list (TodoWrite, todo tool, task tracker —
  whatever your agent runtime calls it) for any multi-step piece of work.
- Update it **immediately** when a step's status changes — mark a task
  completed right after you finish it, before moving on. Do not batch task
  updates for the end.
- Keep at most one task "in progress" at a time where your tool supports it.
- When the work is finished, make sure every task is marked completed.

## Why this matters

axn-term parses the task list your CLI renders and turns it into a live
progress bar. If you never update the list — or update it only at the end —
the user sees nothing (or a stale bar) the whole time you work. Updating the
list costs you nothing; it is the only channel through which the terminal
knows how far along you are.

Once you have read this skill, apply it for the rest of the conversation —
there is no need to re-invoke it.
