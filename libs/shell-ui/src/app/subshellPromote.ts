import { ptyIdOf } from '../types';
import type { EditorTab, ShellSession } from '../types';

/** Default label for a sub-view tab (also used by the session tab strip). */
export function defaultTabLabel(tab: EditorTab): string {
  return (
    tab.command ??
    (tab.cwd ? `sh · ${tab.cwd.split('/').filter(Boolean).pop() ?? tab.cwd}` : 'sh')
  );
}

export interface SubShellPromotePlan {
  /** Session patch applying the promotion. */
  patch: Pick<ShellSession, 'mainPtyId' | 'editors' | 'activeTab'>;
  /**
   * Backend `set_subshell_parent` calls: `[ptyId, newParentId]` — the
   * promoted PTY becomes root, the demoted main shell is re-parented to it.
   */
  reparent: [string, string | null][];
  /** PTY ids whose views unmount during the swap but must stay alive. */
  keepAlive: string[];
}

/**
 * Plan a sub-shell → main-shell swap. The tab's PTY becomes the session's
 * main shell (`mainPtyId`); the previous main PTY takes the tab's place as a
 * sub-shell tab labeled with the session's name. `null` when the tab is not
 * a sub-shell of this session or already is the main shell.
 */
export function planSubShellPromote(
  session: ShellSession,
  tabId: string,
): SubShellPromotePlan | null {
  const tab = (session.editors ?? []).find((e) => e.id === tabId && e.kind === 'shell');
  const oldPtyId = ptyIdOf(session);
  if (!tab || oldPtyId === tabId) return null;
  return {
    patch: {
      mainPtyId: tabId,
      editors: (session.editors ?? []).map((e) =>
        e.id === tabId
          ? { id: oldPtyId, path: '', kind: 'shell' as const, label: session.name }
          : e,
      ),
      activeTab: 'shell',
    },
    reparent: [
      [tabId, null],
      [oldPtyId, tabId],
    ],
    keepAlive: [tabId, oldPtyId],
  };
}

export interface TurnIntoWorkspacePlan {
  /** Workspace name — the session's current name. */
  workspaceName: string;
  /** Sessions adopted from sub-shell tabs, in tab order (id = live PTY id). */
  sessions: { id: string; name: string; cwd?: string }[];
  /** Session patch removing the adopted sub-shell tabs. */
  patch: Pick<ShellSession, 'editors' | 'activeTab'>;
}

/**
 * Plan "turn into workspace": the session itself stays first in a new
 * workspace named after it; every sub-shell tab becomes a standalone session
 * (its PTY is detached and reattached by the new session's ShellTerminal).
 * `null` when the session has no sub-shell tabs.
 */
export function planTurnIntoWorkspace(session: ShellSession): TurnIntoWorkspacePlan | null {
  const shellTabs = (session.editors ?? []).filter((e) => e.kind === 'shell');
  if (shellTabs.length === 0) return null;
  return {
    workspaceName: session.name,
    sessions: shellTabs.map((tab) => ({
      id: tab.id,
      name: tab.label ?? defaultTabLabel(tab),
      cwd: tab.cwd,
    })),
    patch: {
      editors: (session.editors ?? []).filter((e) => e.kind !== 'shell'),
      activeTab: 'shell',
    },
  };
}
