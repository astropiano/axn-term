import { useEffect, useState } from 'react';
import type { ShellSession, Task } from '../types';

export interface TaskStep {
  id: string;
  title: string;
  status: string;
}

export interface AgentTask {
  id: string;
  title: string;
  status: string;
  mode: string;
  summary: string;
  steps: TaskStep[];
  decisions: string[];
  openQuestions: string[];
  nextAction: string;
  updatedAt: string;
}

export interface TaskStateSnapshot {
  currentTaskId: string | null;
  tasks: AgentTask[];
}

function toTasks(list: AgentTask[]): Task[] {
  return list.map((t) => ({
    id: t.id,
    title: t.title,
    done: t.status === 'completed',
  }));
}

function computeProgress(list: AgentTask[]): number {
  if (list.length === 0) return 0;
  const completed = list.filter((t) => t.status === 'completed').length;
  return Math.round((completed / list.length) * 100);
}

export function useAgentTasks(
  sessionId: string | null,
  updateSession: (sessionId: string, patch: Partial<ShellSession>) => void,
  active = true,
  /**
   * The /tasks endpoint, resolved per connect attempt (web appends a fresh
   * auth token). Absent or resolving to `null` disables the tasks stream
   * entirely — desktop has none.
   */
  tasksWsUrl?: () => string | null | Promise<string | null>,
) {
  const [snapshot, setSnapshot] = useState<TaskStateSnapshot | null>(null);

  useEffect(() => {
    if (!sessionId || !tasksWsUrl || !active) {
      setSnapshot(null);
      // Tasks are only replaced by a fresh update (websocket payload or
      // parsed output); a stopped task runner must not wipe them.
      return;
    }

    let running = true;
    let ws: WebSocket | null = null;

    void (async () => {
      const url = await tasksWsUrl();
      if (!running || !url) return;
      const socket = new WebSocket(url);
      ws = socket;

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'subscribe', sessionId }));
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'tasks') {
            const payload = message.payload as TaskStateSnapshot;
            if (running) {
              setSnapshot(payload);
              // status is process-driven; do not mark the session as running
              // just because there are still tasks in the remote state.
              updateSession(sessionId, {
                tasks: toTasks(payload.tasks),
                progress: computeProgress(payload.tasks),
              });
            }
          }
        } catch {
          // ignore malformed messages
        }
      };

      socket.onerror = (error) => {
        console.error('Tasks WebSocket error', error);
      };
    })().catch((e) => console.warn('Tasks WebSocket URL unavailable', e));

    return () => {
      running = false;
      ws?.close();
    };
  }, [sessionId, tasksWsUrl, updateSession, active]);

  return snapshot;
}
