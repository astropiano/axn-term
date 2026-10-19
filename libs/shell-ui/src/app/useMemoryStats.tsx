import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { MemoryStats } from '@axn-term/session-backend';
import { useSessionBackend } from '../services';

export type { MemoryStats };
export type { SessionMemory } from '@axn-term/session-backend';

const MemoryStatsContext = createContext<MemoryStats | null>(null);

/**
 * Polls `backend.getMemoryStats` while `active` is true — i.e. while at
 * least one enabled plugin declares `needsMemoryStats`. Components read the
 * latest snapshot via `useMemoryStats()`; it is null until the first poll
 * returns — and stays null on backends without memory stats.
 */
export function MemoryStatsProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const backend = useSessionBackend();
  const [stats, setStats] = useState<MemoryStats | null>(null);

  useEffect(() => {
    const getStats = backend.getMemoryStats?.bind(backend);
    if (!active || !getStats) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await getStats();
        if (!cancelled) setStats(s);
      } catch {
        // Keep the last snapshot — a failed poll must not blank the UI.
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, backend]);

  return <MemoryStatsContext.Provider value={stats}>{children}</MemoryStatsContext.Provider>;
}

export function useMemoryStats(): MemoryStats | null {
  return useContext(MemoryStatsContext);
}
