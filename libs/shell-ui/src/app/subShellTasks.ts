import { screenTaskPluginFor } from './session-plugins/agentHookBridge';
import type { EditorTab, Task } from '../types';

/**
 * Task tracking for agents in sub-shell tabs — the tab-level counterpart of
 * the agent plugins' screen scans, which only follow a session's main PTY.
 * Called from the tab's foreground-process tick with its visible lines; the
 * enabled plugin whose `processPattern` matches parses them (`screenTasks`).
 */

export type TabTaskPatch = Pick<EditorTab, 'tasks' | 'progress'>;

const key = (tasks: readonly Task[] | undefined) =>
  (tasks ?? []).map((t) => `${t.id}:${t.title}:${t.done}`).join('|');

/** The tab patch for this tick, or undefined when nothing changed. */
export function tabTaskPatch(
  tab: EditorTab,
  process: string | null,
  screen: () => string[],
): TabTaskPatch | undefined {
  const plugin = process ? screenTaskPluginFor(process) : undefined;
  if (!plugin?.screenTasks) {
    // The agent is gone: a finished list stays as the "done" signal, an
    // unfinished one would only go stale.
    const tasks = tab.tasks ?? [];
    if (tasks.length === 0 || tasks.every((t) => t.done)) return undefined;
    return { tasks: undefined, progress: undefined };
  }
  // No block on screen (folded, scrolled away) keeps the last list.
  const tasks = plugin.screenTasks(screen());
  if (!tasks || tasks.length === 0 || key(tasks) === key(tab.tasks)) return undefined;
  return { tasks, progress: Math.round((tasks.filter((t) => t.done).length / tasks.length) * 100) };
}
