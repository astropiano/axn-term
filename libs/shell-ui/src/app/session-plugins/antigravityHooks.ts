import type { AgentHookSpec, AgentHookEffect, AgentHookHost } from '@axn-term/plugin-sdk';
import { shellQuote } from '../../shellQuote';

/**
 * Antigravity CLI (`agy`) adapter for the shared agent-hook bridge
 * (`agentHookBridge.ts`). agy's hook system differs from claude/codex's in
 * three ways, so this spec uses custom install/uninstall:
 *
 * - The config file is `~/.gemini/config/hooks.json` holding *named* hook
 *   groups — `{ "<name>": { "enabled": true, "<Event>": [...] } }` — not
 *   the grouped `hooks.<Event>` schema `mergeHookSettings` writes (a
 *   top-level `hooks` key just loads as one hook literally named "hooks").
 * - The stdin payload carries no `hook_event_name` discriminator (agy
 *   knows the event from which array the hook sits under). The wrapper
 *   script below injects it as `axn_payload` wrapper so the bridge's
 *   `parseHookEvent` sees the usual shape.
 * - Every hook must answer event-shaped JSON on stdout (`{}` for most
 *   events; `Stop` requires a `decision`). The shared append-only script
 *   prints nothing, so the wrapper emits the response after logging.
 *
 * Events wired: SessionStart → idle, PreInvocation/PostToolUse → running,
 * Stop → completed (USER_CANCELED → idle). PreToolUse is skipped — its
 * response is a permission `decision` a passive observer must not take;
 * PostInvocation adds nothing over PreInvocation. agy has no
 * permission-request hook event, so there is no blocked/needs-you signal.
 */

/** Hook events axn-term registers for. */
export const AGY_HOOK_EVENTS = [
  'SessionStart',
  'PreInvocation',
  'PostToolUse',
  'Stop',
] as const;

/** Name our hook group in hooks.json — deleted wholesale on uninstall. */
const AGY_HOOK_NAME = 'axn-term';

const AGY_WRAPPER_NAME = 'agy-hook.sh';

/**
 * The per-event command installed in hooks.json: wraps the stdin JSON as
 * `{"hook_event_name":<ev>,"axn_payload":<stdin>}` into the shared
 * append-only log, then prints the response agy's hook contract requires
 * (`Stop` needs `decision`; anything but "continue" lets it stop).
 */
function agyHookScript(): string {
  return `#!/bin/sh
# axn-term bridge for Antigravity CLI (agy): the hook payload has no event
# discriminator and every hook must answer JSON on stdout, so this wraps
# the payload with the event name for agent-hook.sh and emits the contract
# response. Usage: agy-hook.sh <agent-hook.sh> <event>
ev=$2
case "$ev" in
  Stop) resp='{"decision":"stop"}' ;;
  *) resp='{}' ;;
esac
{ printf '{"hook_event_name":"%s","axn_payload":' "$ev"
  cat
  printf '}'
} | "$1" antigravity
printf '%s\n' "$resp"
`;
}

/**
 * Map an agy hook event (wrapped by agy-hook.sh — `axn_payload` holds the
 * original fields) to session status + attention. `null` for events
 * axn-term does not subscribe to / does not understand.
 */
export function mapAgyHookEvent(ev: Record<string, unknown>): AgentHookEffect | null {
  const payload =
    ev.axn_payload && typeof ev.axn_payload === 'object' && !Array.isArray(ev.axn_payload)
      ? (ev.axn_payload as Record<string, unknown>)
      : {};
  switch (ev.hook_event_name) {
    case 'SessionStart':
      return { status: 'idle', attention: null };
    case 'PreInvocation':
    case 'PostToolUse':
      return { status: 'running', attention: null };
    case 'Stop':
      // A cancelled or errored turn owes the user nothing — no badge.
      return payload.terminationReason === 'USER_CANCELED' ||
        payload.terminationReason === 'ERROR'
        ? { status: 'idle', attention: null }
        : { status: 'completed', attention: null };
    default:
      return null;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readHooksJson(host: AgentHookHost, configPath: string, home: string): Promise<Record<string, unknown>> {
  let raw = '';
  try {
    raw = await host.readFile(configPath, home);
  } catch (e) {
    // Only a missing file starts empty — malformed JSON and I/O errors must
    // not turn an existing file into a blank config.
    if (!/ENOENT|no such file|not found|os error 2/i.test(String(e))) throw e;
  }
  return asObject(raw.trim() ? JSON.parse(raw) : {});
}

/** Write our named group into ~/.gemini/config/hooks.json, preserving others. */
async function install(host: AgentHookHost, home: string, scriptPath: string): Promise<void> {
  const wrapperPath = `${home}/.axn-term/${AGY_WRAPPER_NAME}`;
  await host.writeFile(wrapperPath, agyHookScript(), home);
  await host.exec(`chmod +x ${shellQuote(wrapperPath)}`).catch(() => {});
  const configPath = `${home}/.gemini/config/hooks.json`;
  const root = await readHooksJson(host, configPath, home);
  const entry = (event: string) => ({
    type: 'command',
    command: `${shellQuote(wrapperPath)} ${shellQuote(scriptPath)} ${shellQuote(event)}`,
    timeout: 10,
  });
  const next = {
    ...root,
    [AGY_HOOK_NAME]: {
      enabled: true,
      SessionStart: [entry('SessionStart')],
      PreInvocation: [entry('PreInvocation')],
      // Tool events group handlers under { matcher, hooks } — '*' for all.
      PostToolUse: [{ matcher: '*', hooks: [entry('PostToolUse')] }],
      Stop: [entry('Stop')],
    },
  };
  if (JSON.stringify(root) !== JSON.stringify(next)) {
    await host.mkdir('.gemini/config', home);
    await host.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, home);
  }
}

/** Drop our named group; the wrapper script itself can stay (harmless). */
async function uninstall(host: AgentHookHost, home: string): Promise<void> {
  const configPath = `${home}/.gemini/config/hooks.json`;
  const root = await readHooksJson(host, configPath, home);
  if (!(AGY_HOOK_NAME in root)) return;
  const next = { ...root };
  delete next[AGY_HOOK_NAME];
  await host.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, home);
}

export const antigravityHookSpec: AgentHookSpec = {
  agent: 'antigravity',
  stateKey: 'antigravity',
  events: AGY_HOOK_EVENTS,
  // Informational — install/uninstall own the file (named-hook schema, not
  // the grouped one mergeHookSettings writes).
  configPath: '.gemini/config/hooks.json',
  install,
  uninstall,
  mapEvent: mapAgyHookEvent,
};
