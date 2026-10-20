import type { EditorTab } from '../types';
import { DEVIN_PROCESS_RE } from '../processPatterns';
import { parseClaudeResumeHint } from './session-plugins/claude';
import { parseDevinSessionName } from './session-plugins/devinTasks';
import { shellQuote } from '../shellQuote';

/**
 * Agent conversations in sub-shell tabs — the tab-level counterpart of the
 * claude/devin plugins' restore (plugins only see the session's main PTY).
 *
 * - Talk tabs (`tab.agent` set: git-inspect "talk", workflow agent
 *   sub-shells) are the conversation: once run they always resume it, via
 *   `resumeCommand` — now with the exact id/name from the exit hint.
 * - Plain tabs where the user starts an agent follow the sessions' rule: the
 *   tab records the running agent (`agentActive`, from its foreground
 *   process) and the exact resume line (`agentResume`), and resumes only
 *   when the agent was still running when the app went away.
 */

export type TabAgent = NonNullable<EditorTab['agentActive']>;

/** Keeps the tab usable once the resumed agent exits. */
const THEN_SHELL = '; exec "${SHELL:-sh}" -l';

/** `<agent command>; exec $SHELL -l` — the tab stays a shell afterwards. */
export function withLoginShell(command: string): string {
  return `${command}${THEN_SHELL}`;
}

const FALLBACK: Record<TabAgent, string> = {
  claude: 'claude -c',
  devin: 'devin -c',
};


/** The agent a foreground process name belongs to, if any. */
export function agentOfProcess(process: string | null | undefined): TabAgent | undefined {
  if (!process) return undefined;
  if (DEVIN_PROCESS_RE.test(process)) return 'devin';
  if (/claude/i.test(process)) return 'claude';
  return undefined;
}

/** The exact resume line in an agent's exit output, once it is complete. */
export function captureAgentResume(agent: TabAgent, output: string): string | undefined {
  if (agent === 'claude') {
    const hint = parseClaudeResumeHint(output);
    if (!hint) return undefined;
    const worktree = hint.worktree ? ` --worktree ${shellQuote(hint.worktree)}` : '';
    return `claude${worktree} --resume ${hint.id}`;
  }
  const name = parseDevinSessionName(output, true);
  return name ? `devin -r ${name}` : undefined;
}

/**
 * What a sub-shell tab runs when it (re)spawns: the running-at-close agent
 * resumed exactly (or via its fallback), else the existing behaviour — a
 * talk tab's `resumeCommand`, the seed `command`, or an interactive shell.
 */
export function subShellSpawnCommand(tab: EditorTab): string | undefined {
  const agent = tab.agentActive;
  if (agent && !tab.agent) {
    const resume = tab.agentResume?.startsWith(`${agent} `) ? tab.agentResume : FALLBACK[agent];
    return `${resume}${THEN_SHELL}`;
  }
  return tab.resumeCommand ?? tab.command ?? undefined;
}

// Graceful stop on app close: each mounted sub-shell running an agent
// registers a closer (Ctrl-C pairs + wait for the exit hint), and the app's
// collect-and-close path awaits them before the state is saved.
const closers = new Map<string, () => Promise<void>>();

export function registerSubShellCloser(tabId: string, closer: () => Promise<void>): () => void {
  closers.set(tabId, closer);
  return () => {
    if (closers.get(tabId) === closer) closers.delete(tabId);
  };
}

export async function runSubShellClosers(timeoutMs = 8000): Promise<void> {
  if (closers.size === 0) return;
  await Promise.race([
    Promise.allSettled([...closers.values()].map((close) => close())),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
