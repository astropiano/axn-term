import type { ShellSession } from './types';

/** Process liveness initializes status; hooks/tasks own it until a transition. */
export function foregroundStatusPatch(
  session: Pick<ShellSession, 'process' | 'status'>,
  process: string | undefined,
): Partial<ShellSession> {
  if (session.process === process) return {};
  return {
    process,
    status: process ? 'running' : session.status === 'completed' ? 'completed' : 'idle',
  };
}
