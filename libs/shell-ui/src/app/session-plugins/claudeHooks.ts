import type { SessionAttention, SessionStatus } from '../../types';
import {
  agentEventFile,
  mergeHookSettings,
  parseHookEvent,
  removeHookSettings,
  type AgentHookSpec,
} from '@axn-term/plugin-sdk';

/**
 * Claude Code adapter for the shared agent-hook bridge (`agentHookBridge.ts`
 * runtime + `@axn-term/plugin-sdk` `hooks.ts` pure helpers). Subscribes to
 * Claude's lifecycle events and maps them onto the semantic status/attention
 * model.
 */

/** Hook events axn-term registers for. */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'SessionEnd',
] as const;

export interface ClaudeHookEffect {
  status?: SessionStatus;
  /** `null` clears the flag; absent leaves it unchanged. */
  attention?: SessionAttention | null;
}

/**
 * Map a hook event to session status + attention. `null` for events axn-term
 * does not subscribe to / does not understand.
 */
export function mapClaudeHookEvent(ev: Record<string, unknown>): ClaudeHookEffect | null {
  const toolSuffix =
    typeof ev.tool_name === 'string' && ev.tool_name ? `: ${ev.tool_name}` : '';
  switch (ev.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'SubagentStop':
      return { status: 'running', attention: null };
    case 'PermissionRequest':
      return {
        status: 'blocked',
        attention: { level: 'critical', message: `claude needs permission${toolSuffix}` },
      };
    case 'Notification':
      return {
        status: 'blocked',
        attention: {
          level: 'warning',
          message:
            typeof ev.message === 'string' && ev.message
              ? ev.message
              : 'claude needs input',
        },
      };
    case 'Stop':
      return { status: 'completed', attention: null };
    case 'StopFailure':
      return { status: 'blocked', attention: { level: 'critical', message: 'claude turn failed' } };
    case 'SessionStart':
      return { status: 'idle', attention: null };
    case 'SessionEnd':
      // Process-end reconciliation owns the final badge — just drop the flag.
      return { attention: null };
    default:
      return null;
  }
}

export const claudeHookSpec: AgentHookSpec = {
  agent: 'claude',
  stateKey: 'claude',
  events: HOOK_EVENTS,
  configPath: '.claude/settings.json',
  hookEntry: { timeout: 10 },
  mapEvent: mapClaudeHookEvent,
};

// --- Compatibility wrappers (older call sites/tests keep their names) ---

export function claudeEventFile(home: string, tty: string): string {
  return agentEventFile(home, 'claude', tty);
}

export function mergeClaudeHookSettings(
  settings: unknown,
  scriptPath: string,
): Record<string, unknown> {
  return mergeHookSettings(settings, claudeHookSpec, scriptPath);
}

export const removeClaudeHookSettings = removeHookSettings;
export const parseClaudeHookEvent = parseHookEvent;
