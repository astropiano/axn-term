import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionBackend } from '@axn-term/session-backend';
import type { EditorTab, ShellSession, Task } from '../../types';
import type { PlanEntry } from './types';
import type { AcpPipe } from './acpClient';
import { acpHandlers } from './acpHandlers';
import { AcpChatView } from './AcpChatView';

/** ACP plan entries → the tab's `Task[]` + done-share badge. */
export function planToTasks(entries: PlanEntry[]): { tasks: Task[]; progress: number } {
  const tasks: Task[] = entries.map((e, i) => ({
    id: `acp-${i}`,
    title: e.content,
    done: e.status === 'completed',
  }));
  const progress = tasks.length
    ? Math.round((tasks.filter((t) => t.done).length / tasks.length) * 100)
    : 0;
  return { tasks, progress };
}

/**
 * A `kind: 'acp'` session tab: spawns the agent process through
 * `backend.spawnProcess`, hosts `AcpChatView`, and maps ACP state onto the
 * shared tab chrome — turn lifecycle → `hookStatus`, pending permission →
 * `hookAttention` (rolls into session attention + OS notify), plan →
 * `tasks`/`progress`, and the assigned ACP session id → `acpSessionId` so a
 * remount resumes via `session/load`.
 */
export function AcpSessionTab({
  session,
  tab,
  backend,
  isVisible,
  onUpdateTab,
  notify,
  onAxnCommand,
}: {
  session: ShellSession;
  tab: EditorTab;
  backend: SessionBackend;
  isVisible: boolean;
  onUpdateTab?: (patch: Partial<EditorTab>) => void;
  notify?: (title: string, message?: string) => void;
  /** `/axn-*` composer lines → axn-term command dispatch. */
  onAxnCommand?: (line: string) => Promise<string | false | undefined>;
}) {
  const [pipe, setPipe] = useState<AcpPipe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const visibleRef = useRef(isVisible);
  visibleRef.current = isVisible;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  // The pipe lives for the tab's mount lifetime: the effect cleanup kills
  // the child, so a StrictMode double-effect just respawns it cleanly.
  useEffect(() => {
    setPipe(null);
    setError(null);
    const argv = tab.acpCommand ?? [];
    if (!backend.spawnProcess) {
      setError('agent chat needs a process backend — not supported in this environment yet');
      return;
    }
    if (argv.length === 0) {
      setError('no agent command configured for this tab');
      return;
    }
    let alive = true;
    let spawned: AcpPipe | undefined;
    backend
      .spawnProcess(argv[0], argv.slice(1), tab.cwd ?? session.cwd)
      .then((p) => {
        if (!alive) {
          p.close();
          return;
        }
        spawned = p;
        setPipe(p);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
      spawned?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.acpCommand]);

  // Agent→client services (fs port + invisible terminal PTYs) — stable per
  // session/backend so the pipe lifetime isn't churned.
  const handlers = useMemo(() => acpHandlers(session, backend), [session.id, backend]);

  return pipe ? (
    <AcpChatView
      pipe={pipe}
      cwd={tab.cwd ?? session.cwd}
      resumeSessionId={tab.acpSessionId}
      onSessionId={(id) => {
        if (tabRef.current.acpSessionId !== id) onUpdateTab?.({ acpSessionId: id });
      }}
      onTurn={(status) => {
        if ((tabRef.current.hookStatus ?? undefined) !== status)
          onUpdateTab?.({ hookStatus: status });
      }}
      onPlan={(entries: PlanEntry[]) => {
        const { tasks, progress } = planToTasks(entries);
        onUpdateTab?.({ tasks, progress });
      }}
      onAttention={(attention) => {
        onUpdateTab?.({ hookAttention: attention });
        if (attention && !visibleRef.current) {
          notifyRef.current?.(
            `${session.name} · ${tabRef.current.label ?? 'agent'}`,
            attention.message,
          );
        }
      }}
      onAxnCommand={onAxnCommand}
      handlers={handlers}
    />
  ) : (
    <div className="flex h-full items-center justify-center p-4 text-sm text-[var(--text-secondary)]">
      {error ?? 'starting agent…'}
    </div>
  );
}
