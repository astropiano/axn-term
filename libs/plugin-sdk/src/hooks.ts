import type { SessionAttention, SessionStatus } from './api';

/**
 * Agent hook bridge — pure, dependency-free pieces of axn-term's agent-hook
 * transport, consumable by plugin authors.
 *
 * CLI agents with a lifecycle hook system (Claude Code, Codex, Gemini CLI)
 * run configured hook commands with the event JSON on stdin. axn-term
 * installs one script — `agent-hook.sh <agent>` — which appends that JSON as
 * one line to `$AXN_TERM_STATE_DIR/<agent>-events/pty-<id>.jsonl` (one
 * append-only log per PTY, rotated to `.jsonl.1` past 64 KB). Legacy
 * terminals without the injected identity fall back to the TTY. The host
 * reads the log from where it left off (`readHookLog`) and applies each
 * event's `mapEvent` result, in order, onto the status/attention of the
 * session or sub-shell tab owning the PTY — a PermissionRequest followed
 * within one poll by another event is no longer lost.
 *
 * A plugin contributes an `AgentHookSpec`: which events to subscribe to,
 * which agent config file to merge hook entries into, and how an event maps
 * onto the semantic status/attention model. Everything else — script,
 * transport, polling, precedence — is shared.
 */

/** Semantic effect a hook event maps to — the agent-agnostic sink. */
export interface AgentHookEffect {
  status?: SessionStatus;
  /** `null` clears the flag; absent leaves it unchanged. */
  attention?: SessionAttention | null;
}

/**
 * Minimal host file/shell ops handed to custom `install`/`uninstall`
 * implementations — the same shape `ctx.readFile`/`exec`/`mkdir`/`writeFile`
 * expose on the plugin API.
 */
export interface AgentHookHost {
  readFile(path: string, baseDir?: string): Promise<string>;
  writeFile(path: string, contents: string, baseDir?: string): Promise<void>;
  mkdir(path: string, baseDir?: string): Promise<boolean>;
  exec(command: string): Promise<string>;
}

/** Per-agent adapter consumed by the hook bridge. */
export interface AgentHookSpec {
  /** Short id used in file names, log targets and event dirs ('claude', 'codex', 'gemini'). */
  agent: string;
  /**
   * pluginState key the live attention flag is read from — defaults to the
   * declaring plugin's `stateKey` (or `agent`).
   */
  stateKey?: string;
  /** Hook events to register entries for. */
  events: readonly string[];
  /** Hook config file relative to $HOME (e.g. '.claude/settings.json', '.codex/hooks.json'). */
  configPath: string;
  /** Extra fields on the command-hook entry (e.g. claude/codex support `timeout`). */
  hookEntry?: Record<string, unknown>;
  /**
   * Custom install when the agent's config is not the grouped JSON schema —
   * e.g. OpenCode registers hooks through a `.js` plugin file. Receives the
   * resolved `$HOME` and the installed `agent-hook.sh` path; the shared
   * script is still written first. Default: `mergeHookSettings` into
   * `configPath`. Pair with `uninstall`.
   */
  install?(host: AgentHookHost, home: string, scriptPath: string): Promise<void>;
  /** Custom removal — default: `removeHookSettings` on `configPath`. */
  uninstall?(host: AgentHookHost, home: string): Promise<void>;
  /** Map a parsed hook event JSON to a semantic effect. `null` = not ours / ignored. */
  mapEvent(ev: Record<string, unknown>): AgentHookEffect | null;
}

/** Hook commands axn-term owns — current script plus legacy per-agent scripts. */
const AXN_HOOK_MARKERS = [
  '.axn-term/agent-hook.sh',
  '.axn-term/claude-hook.sh',
];

export function agentHookScriptPath(home: string): string {
  return `${home}/.axn-term/agent-hook.sh`;
}

export function agentEventDir(home: string, agent: string): string {
  return `${home}/.axn-term/${agent}-events`;
}

/** Event file for a tty such as `/dev/ttys003` or `/dev/pts/0`. */
export function agentEventFile(home: string, agent: string, tty: string): string {
  return `${agentEventDir(home, agent)}/${tty.replace(/^\/dev\//, '').replace(/\//g, '_')}.json`;
}

/** Explicit PTY identity survives piped stdin and detached hook processes. */
export function agentPtyEventFile(stateDir: string, agent: string, ptyId: string): string {
  return `${stateDir}/${agent}-events/pty-${ptyId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
}

/** The append-only event log next to a (legacy latest-event) `.json` file. */
export function agentEventLog(eventFile: string): string {
  return eventFile.replace(/\.json$/, '.jsonl');
}

/** Read position in an event log: chars consumed + the first line seen (rotation check). */
export interface HookLogCursor {
  offset: number;
  head: string;
}

function completeLines(text: string, from: number): { lines: string[]; end: number } {
  const end = text.lastIndexOf('\n') + 1;
  if (end <= from) return { lines: [], end: from };
  return { lines: text.slice(from, end).split('\n').filter((l) => l.trim()), end };
}

/**
 * New complete lines of an event log since `cursor` (all of them on the
 * first read). A log that shrank or starts differently was rotated: the rest
 * of `<log>.1` past the old offset comes first. Resolves null when the log
 * does not exist (yet). A trailing partial line waits for the next read.
 */
export async function readHookLog(
  read: (path: string) => Promise<string>,
  path: string,
  cursor: HookLogCursor | undefined,
): Promise<{ lines: string[]; cursor: HookLogCursor } | null> {
  let text: string;
  try {
    text = await read(path);
  } catch {
    return null;
  }
  const head = text.slice(0, text.indexOf('\n') + 1);
  const lines: string[] = [];
  let from = cursor?.offset ?? 0;
  if (cursor && (text.length < cursor.offset || !text.startsWith(cursor.head))) {
    const rotated = await read(`${path}.1`).catch(() => '');
    if (rotated.startsWith(cursor.head)) lines.push(...completeLines(rotated, cursor.offset).lines);
    from = 0;
  }
  const fresh = completeLines(text, from);
  lines.push(...fresh.lines);
  return { lines, cursor: { offset: fresh.end, head } };
}

/**
 * Shell script installed as the hook command (`agent-hook.sh <agent>`):
 * appends the stdin event JSON as one line to the invoking PTY's event log.
 * Each append is a single `cat` of at most ~3.5 KB — oversized payloads (tool
 * output) shrink to the fields the bridge maps — so concurrent hooks never
 * interleave. Always exits 0 — a hook failure must never block the agent.
 */
export function agentHookScript(): string {
  return `#!/bin/sh
# axn-term bridge — agent hooks append their event JSON, one line each, to
# the invoking PTY's log; rotated to .jsonl.1 past 64 KB. Usage:
#   agent-hook.sh <agent> [hook-event]
agent=$1
case "$agent" in
  ''|*[!a-z]*) exit 0 ;;
esac
# Process-exit reconciliation clears attention. Do not replace a final Stop
# event with SessionEnd before the UI has had a chance to read completion.
if [ "$2" = SessionEnd ]; then
  cat >/dev/null
  exit 0
fi
if [ -n "$AXN_TERM_PTY_ID" ]; then
  n=pty-$(printf %s "$AXN_TERM_PTY_ID" | sed 's/[^a-zA-Z0-9_-]/_/g')
else
  t=$(tty < /dev/tty 2>/dev/null) || exit 0
  case "$t" in /dev/*) ;; *) exit 0 ;; esac
  n=$(printf %s "$t" | sed 's|^/dev/||; s|/|_|g')
fi
d="\${AXN_TERM_STATE_DIR:-$HOME/.axn-term}/$agent-events"
umask 077
mkdir -p "$d" 2>/dev/null || exit 0
tmp=$(mktemp "$d/.event.XXXXXX") || exit 0
trap 'rm -f "$tmp"' EXIT HUP INT TERM
# One event per line: raw newlines in JSON only ever separate tokens.
tr '\r\n' '  ' > "$tmp" 2>/dev/null || exit 0
if [ "$(wc -c < "$tmp")" -gt 3500 ]; then
  f=
  for k in hook_event_name tool_name notification_type; do
    v=$(grep -o '"'"$k"'"[[:space:]]*:[[:space:]]*"[^"\\]*"' "$tmp" | head -n 1)
    [ -n "$v" ] && f="$f$v,"
  done
  printf '{%s"axn_truncated":true}' "$f" > "$tmp"
fi
printf '\n' >> "$tmp"
log="$d/$n.jsonl"
if [ -f "$log" ] && [ "$(wc -c < "$log")" -gt 65536 ]; then
  # One rotator at a time, re-checking under the lock: a second mv would
  # replace the .1 the host has not finished reading with a fresh log.
  [ -n "$(find "$log.lock" -prune -mmin +1 2>/dev/null)" ] && rmdir "$log.lock" 2>/dev/null
  if mkdir "$log.lock" 2>/dev/null; then
    [ "$(wc -c < "$log")" -gt 65536 ] && mv -f "$log" "$log.1" 2>/dev/null
    rmdir "$log.lock" 2>/dev/null
  fi
fi
cat "$tmp" >> "$log" 2>/dev/null
exit 0
`;
}

interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}

function withoutAxnHooks(groups: unknown[]): unknown[] {
  return groups.flatMap((group) => {
    const hooks = (group as HookGroup | undefined)?.hooks;
    if (!Array.isArray(hooks)) return [group];
    const kept = hooks.filter((h) => !(typeof h?.command === 'string' &&
      AXN_HOOK_MARKERS.some((m) => h.command!.includes(m))));
    if (kept.length === hooks.length) return [group];
    return kept.length ? [{ ...group as HookGroup, hooks: kept }] : [];
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Merge axn-term hook entries into the agent's parsed hook config. Claude
 * Code, Codex and Gemini CLI share the grouped schema
 * `hooks.<Event> = [{ matcher?, hooks: [{ type:'command', command, ... }] }]`.
 * Idempotent, preserves unrelated settings and non-axn hooks.
 */
export function mergeHookSettings(
  settings: unknown,
  spec: AgentHookSpec,
  scriptPath: string,
): Record<string, unknown> {
  const root = asObject(settings);
  const hooks = { ...asObject(root.hooks) };
  for (const event of spec.events) {
    const entry = {
      type: 'command',
      command: `${shellQuote(scriptPath)} ${spec.agent} ${shellQuote(event)}`,
      ...spec.hookEntry,
    };
    const groups = Array.isArray(hooks[event])
      ? withoutAxnHooks(hooks[event] as unknown[])
      : [];
    hooks[event] = [...groups, { hooks: [entry] }];
  }
  return { ...root, hooks };
}

/**
 * Remove axn-term hook entries from parsed settings — both current
 * `agent-hook.sh` and legacy `claude-hook.sh` commands. Event arrays emptied
 * by the removal are dropped, as is `hooks` itself when nothing remains.
 */
export function removeHookSettings(settings: unknown): Record<string, unknown> {
  const root = asObject(settings);
  const hooks = { ...asObject(root.hooks) };
  for (const key of Object.keys(hooks)) {
    if (!Array.isArray(hooks[key])) continue;
    const kept = withoutAxnHooks(hooks[key] as unknown[]);
    if (kept.length) hooks[key] = kept;
    else delete hooks[key];
  }
  const next = { ...root };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

/** Parse an event file's JSON. `null` on missing/garbage content. */
export function parseHookEvent(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const ev = parsed as Record<string, unknown>;
    return typeof ev.hook_event_name === 'string' ? ev : null;
  } catch {
    return null;
  }
}
