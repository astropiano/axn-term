import { pickOrCreate } from '../pickerHost';

/**
 * ACP-capable agents suggested in the "New agent session…" picker — launch
 * lines for agents speaking ACP natively or through an adapter. The create
 * row accepts any command line (split on whitespace).
 */
export const SUGGESTED_ACP_AGENTS: { label: string; argv: string }[] = [
  { label: 'Claude Code', argv: 'claude-agent-acp' },
  { label: 'Codex', argv: 'codex-acp' },
  { label: 'OpenCode', argv: 'opencode acp' },
  { label: 'Gemini CLI', argv: 'gemini --acp' },
  { label: 'Mistral Vibe', argv: 'vibe acp' },
];

/**
 * The "New agent session…" picker: resolves the chosen agent command as
 * argv (picked suggestion or typed custom line), or null when dismissed.
 */
export async function pickAcpAgent(): Promise<string[] | null> {
  const result = await pickOrCreate({
    title: 'New agent session',
    placeholder: 'Search agents or type a command…',
    createLabel: (q) => `Custom agent command "${q}"`,
    items: SUGGESTED_ACP_AGENTS.map((a) => ({
      key: a.argv,
      label: a.label,
      detail: a.argv,
    })),
  });
  if (!result) return null;
  return result.key.split(/\s+/).filter(Boolean);
}
