import type { SessionAttention, SessionStatus } from './api';

/**
 * Agent hook bridge — pure, dependency-free pieces of axn-term's agent-hook
 * transport, consumable by plugin authors.
 *
 * CLI agents with a lifecycle hook system (Claude Code, Codex, Gemini CLI)
 * run configured hook commands with the event JSON on stdin. axn-term
 * installs one script — `agent-hook.sh <agent>` — which writes that JSON to
 * `$AXN_TERM_STATE_DIR/<agent>-events/pty-<id>.json` (one file per PTY).
 * Legacy terminals without the injected identity fall back to the TTY.
 * The host resolves the session's event file and applies the
 * spec's `mapEvent` result onto the session's status/attention.
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

/**
 * Shell script installed as the hook command (`agent-hook.sh <agent>`):
 * stores the stdin event JSON as the latest event for the invoking PTY.
 * Always exits 0 — a hook failure must never block the agent.
 */
export function agentHookScript(): string {
  return `#!/bin/sh
# axn-term bridge — agent hooks write their event JSON keyed by the
# invoking PTY; one file per PTY, atomically replaced per event. Usage:
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
cat > "$tmp" 2>/dev/null && mv -f "$tmp" "$d/$n.json" 2>/dev/null
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
