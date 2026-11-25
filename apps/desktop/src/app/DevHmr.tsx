import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

interface DevHmrStatus {
  enabled: boolean;
  repo: string | null;
  vite: 'idle' | 'installing' | 'starting' | 'running' | 'exited';
  port: number | null;
  error: string | null;
  log: string[];
  useRealState: boolean;
  realStateConflict: boolean;
  portHolder: { pids: number[]; command: string | null; cwd: string | null } | null;
}

const VITE_LABEL: Record<DevHmrStatus['vite'], string> = {
  idle: 'stopped',
  installing: 'installing…',
  starting: 'starting…',
  running: 'running',
  exited: 'exited',
};

const btn =
  'rounded border border-[var(--border)] px-2 py-1 text-[var(--text-primary)] hover:bg-[var(--surface)] disabled:opacity-40';

/**
 * The axn-term-hmr control window (#axn-dev): pick the checkout the spawned
 * vite dev server runs in, start/stop it, open the terminal window on its
 * URL, and tail its output.
 */
export function DevHmrWindow() {
  const [status, setStatus] = useState<DevHmrStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [repoInput, setRepoInput] = useState('');
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    invoke<DevHmrStatus>('dev_hmr_status').then((s) => {
      setStatus(s);
      setRepoInput((v) => v || (s.repo ?? ''));
    }).catch(() => {});
    const un = listen<DevHmrStatus>('dev-hmr-status', (e) => {
      setStatus(e.payload);
      setRepoInput((v) => v || (e.payload.repo ?? ''));
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [status?.log.length]);

  const run = useCallback((cmd: string, args?: Record<string, unknown>) => {
    setBusy(true);
    void invoke(cmd, args)
      .catch((e) => console.error(cmd, e))
      .finally(() => setBusy(false));
  }, []);

  const pickFolder = useCallback(async () => {
    const dir = await open({ directory: true, title: 'axn-term checkout / worktree' });
    if (typeof dir === 'string') {
      setRepoInput(dir);
      run('dev_hmr_set_repo', { repo: dir });
    }
  }, [run]);

  const applyRepo = useCallback(() => {
    const v = repoInput.trim();
    if (v && v !== status?.repo) run('dev_hmr_set_repo', { repo: v });
  }, [repoInput, status?.repo, run]);

  const running = status?.vite === 'running' || status?.vite === 'starting';

  return (
    <div className="flex h-screen flex-col gap-3 bg-[var(--bg)] p-4 text-xs text-[var(--text-primary)]">
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
          checkout
        </div>
        <div className="flex items-center gap-2">
          <input
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyRepo()}
            onBlur={applyRepo}
            placeholder="/path/to/axn-term checkout"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <button className={btn} onClick={() => void pickFolder()}>
            Browse…
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
          vite:
        </span>
        <span>{status ? VITE_LABEL[status.vite] : '…'}</span>
        {status?.port && (
          <span className="font-mono text-[var(--text-secondary)]">
            http://127.0.0.1:{status.port}
          </span>
        )}
        <label
          className="flex items-center gap-1 whitespace-nowrap"
          data-tip={running ? 'Stop vite to change the state mode' : 'Use ~/.axn-term state and configuration'}
        >
          <input
            type="checkbox"
            checked={status?.useRealState ?? false}
            disabled={busy || running}
            onChange={(e) => run('dev_hmr_set_real_state', { useRealState: e.target.checked })}
          />
          <span>Use real axn-term state</span>
        </label>
        <span className="flex-1" />
        {running ? (
          <button className={btn} disabled={busy} onClick={() => run('dev_hmr_stop')}>
            Stop
          </button>
        ) : (
          <button
            className={btn}
            disabled={busy || !status?.repo || status?.realStateConflict}
            onClick={() => run('dev_hmr_start')}
          >
            Start
          </button>
        )}
        <button
          className={btn}
          disabled={busy || status?.vite !== 'running' || status?.realStateConflict}
          onClick={() => run('dev_hmr_open_main')}
        >
          Open window
        </button>
        <button
          className={btn}
          disabled={busy || !status?.repo || running}
          data-tip="pnpm install in the checkout"
          onClick={() => run('dev_hmr_install')}
        >
          pnpm install
        </button>
      </div>

      {status?.useRealState && (
        <div className="rounded border border-[var(--warning,#d9a441)] px-2 py-1 text-[11px] text-[var(--warning,#d9a441)]">
          Warning: real-state HMR shares application data with axn-term. Do not run both at the same time.
        </div>
      )}

      {status?.portHolder && (
        <div className="flex items-center gap-2 rounded border border-[var(--warning,#d9a441)] px-2 py-1 text-[11px] text-[var(--warning,#d9a441)]">
          <span className="min-w-0 break-all">
            port is held by {status.portHolder.command || 'another process'}
            {status.portHolder.pids.length > 0 && ` (pid ${status.portHolder.pids.join(', ')})`}
          </span>
          <span className="flex-1" />
          <button
            className={btn}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await invoke('dev_hmr_free_port');
                await invoke('dev_hmr_start');
              } catch (e) {
                console.error('dev_hmr_free_port/dev_hmr_start', e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Kill &amp; start
          </button>
        </div>
      )}

      {status?.realStateConflict && (
        <div className="rounded border border-[var(--error,#f66)] px-2 py-1 text-[var(--error,#f66)]">
          The normal axn-term app is currently running. Close it before starting real-state HMR.
        </div>
      )}

      {status?.error && (
        <div className="rounded border border-[var(--border)] px-2 py-1 break-all text-[var(--error,#f66)]">
          {status.error}
        </div>
      )}

      <pre
        ref={logRef}
        className="min-h-0 flex-1 overflow-auto rounded border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap text-[var(--text-secondary)]"
      >
        {status?.log.join('\n') || 'vite output appears here'}
      </pre>
    </div>
  );
}
