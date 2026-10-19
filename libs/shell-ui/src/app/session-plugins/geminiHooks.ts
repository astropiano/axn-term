import type { AgentHookSpec, AgentHookEffect } from '@axn-term/plugin-sdk';

/**
 * Gemini CLI adapter for the shared agent-hook bridge (`agentHookBridge.ts`).
 * Gemini's hooks live in `~/.gemini/settings.json` under `hooks` using the
 * same grouped `hooks.<Event> = [{ matcher?, hooks: [...] }]` schema, and
 * command hooks receive the event JSON on stdin with a `hook_event_name`
 * field — only the event names differ from Claude's.
 */

/** Hook events axn-term registers for. */
export const GEMINI_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'BeforeTool',
  'AfterTool',
  'Notification',
] as const;

/**
 * Map a gemini hook event to session status + attention. `null` for events
 * axn-term does not subscribe to / does not understand.
 */
export function mapGeminiHookEvent(ev: Record<string, unknown>): AgentHookEffect | null {
  const toolSuffix =
    typeof ev.tool_name === 'string' && ev.tool_name ? `: ${ev.tool_name}` : '';
  switch (ev.hook_event_name) {
    case 'BeforeAgent':
    case 'BeforeTool':
    case 'AfterTool':
      return { status: 'running', attention: null };
    case 'AfterAgent':
      return { status: 'completed', attention: null };
    case 'Notification':
      return {
        status: 'blocked',
        attention: {
          level: ev.notification_type === 'ToolPermission' ? 'critical' : 'warning',
          message:
            typeof ev.message === 'string' && ev.message
              ? ev.message
              : `gemini needs input${toolSuffix}`,
        },
      };
    case 'SessionStart':
      return { status: 'idle', attention: null };
    case 'SessionEnd':
      // Process-end reconciliation owns the final badge — just drop the flag.
      return { attention: null };
    default:
      return null;
  }
}

export const geminiHookSpec: AgentHookSpec = {
  agent: 'gemini',
  stateKey: 'gemini',
  events: GEMINI_HOOK_EVENTS,
  configPath: '.gemini/settings.json',
  mapEvent: mapGeminiHookEvent,
};
