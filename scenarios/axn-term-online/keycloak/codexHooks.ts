import type { AgentHookSpec, AgentHookEffect } from '@axn-term/plugin-sdk';

/**
 * Codex CLI adapter for the shared agent-hook bridge (`agentHookBridge.ts`).
 * Codex's hook system (≥0.144) is modelled on Claude Code's — same
 * `hook_event_name` stdin payload and the same grouped
 * `hooks.<Event> = [{ matcher?, hooks: [...] }]` schema in
 * `~/.codex/hooks.json`.
 *
 * Caveat: Codex requires new/changed hooks to be reviewed and trusted via
 * `/hooks` before they run — after enabling installHooks the user approves
 * the entries once inside codex.
 */

/** Hook events axn-term registers for. */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
  'SessionEnd',
] as const;

/**
 * Map a codex hook event to session status + attention. `null` for events
 * axn-term does not subscribe to / does not understand.
 */
export function mapCodexHookEvent(ev: Record<string, unknown>): AgentHookEffect | null {
  const toolSuffix =
    typeof ev.tool_name === 'string' && ev.tool_name ? `: ${ev.tool_name}` : '';
  switch (ev.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'SubagentStart':
    case 'SubagentStop':
      return { status: 'running', attention: null };
    case 'PermissionRequest':
      return {
        status: 'blocked',
        attention: { level: 'critical', message: `codex needs permission${toolSuffix}` },
      };
    case 'Stop':
      return { status: 'completed', attention: null };
    case 'Interrupt':
      // The user aborted the turn — nothing is still owed to them.
      return { status: 'idle', attention: null };
    case 'SessionStart':
      return { status: 'idle', attention: null };
    case 'SessionEnd':
      // Process-end reconciliation owns the final badge — just drop the flag.
      return { attention: null };
    default:
      return null;
  }
}

export const codexHookSpec: AgentHookSpec = {
  agent: 'codex',
  stateKey: 'codex',
  events: CODEX_HOOK_EVENTS,
  configPath: '.codex/hooks.json',
  hookEntry: { timeout: 10 },
  mapEvent: mapCodexHookEvent,
};
