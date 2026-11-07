import { useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUp, FileText, Folder } from 'lucide-react';
import type { DirEntry } from '@axn-term/session-backend';
import { useSessionBackend, useShellPlatform } from '../services';
import { childPath, sortEntries } from './browserTree';
import { expandPathArg, resolvePath } from './fileService';

/**
 * Embedded-browser path picker — the web stand-in for the native file dialogs
 * the desktop build uses (platform.pickDirectory). Directories are listed
 * through the session backend's fs ops and navigated like the axn-browse
 * view: click a folder to enter it, '..' or the up button to leave it, or
 * type a path (~ expanded) into the path row.
 *
 * `mode` decides what the primary action returns: 'dir' picks the browsed
 * folder ("New session in folder…"), 'file' picks the selected file — file
 * rows stay greyed out in dir mode, files not matching `extensions` grey
 * out in file mode.
 */
export function FilePickerModal({
  mode,
  sessionId,
  startDir,
  extensions,
  onPick,
  onCancel,
}: {
  mode: 'file' | 'dir';
  /** Session the backend's fs ops are routed through (ptyIdOf). */
  sessionId: string;
  /** Absolute dir to open in — defaults to the platform home. */
  startDir?: string;
  /** File-mode suffix filter (e.g. ['json']), matched case-insensitively. */
  extensions?: string[];
  onPick: (path: string) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const backend = useSessionBackend();
  const platform = useShellPlatform();
  const [currentPath, setCurrentPath] = useState<string | null>(
    startDir ? resolvePath(undefined, startDir) : null,
  );
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Start dir: explicit startDir wins, then the platform home, then '/'.
  useEffect(() => {
    if (currentPath) return;
    let alive = true;
    platform
      .homeDir()
      .then((home) => {
        if (alive) setCurrentPath(resolvePath(undefined, home || '/'));
      })
      .catch(() => {
        if (alive) setCurrentPath('/');
      });
    return () => {
      alive = false;
    };
  }, [currentPath, platform]);

  useEffect(() => {
    if (!currentPath) return;
    if (!backend.listDir) {
      setError('Directory listing is not available on this backend.');
      return;
    }
    let alive = true;
    setEntries(null);
    backend
      .listDir(sessionId, currentPath)
      .then((list) => {
        if (!alive) return;
        setEntries(sortEntries(list));
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setEntries([]);
        setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [backend, currentPath, sessionId]);

  // Navigating resets the path row to the directory shown and drops any
  // file selection — it belonged to the previous directory.
  useEffect(() => {
    setPathDraft(currentPath ?? '');
    setSelected(null);
  }, [currentPath]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const parent =
    currentPath && currentPath !== '/'
      ? currentPath.slice(0, currentPath.lastIndexOf('/')) || '/'
      : null;

  const extOk = (name: string) =>
    !extensions?.length ||
    extensions.some((ext) => name.toLowerCase().endsWith(`.${ext.toLowerCase()}`));

  // A typed path resolves through statPath: a dir is entered, a file is
  // picked outright in file mode — same grammar as the terminal.
  const submitDraft = () => {
    void (async () => {
      const home = await platform.homeDir().catch(() => undefined);
      const path = resolvePath(currentPath ?? '/', expandPathArg(pathDraft, home));
      if (!backend.statPath) {
        setCurrentPath(path);
        return;
      }
      const stat = await backend.statPath(sessionId, '/', path).catch(() => null);
      if (stat?.isDir) {
        setCurrentPath(stat.path);
      } else if (stat?.isFile && mode === 'file' && extOk(stat.path)) {
        onPick(stat.path);
      } else if (!stat) {
        setError(t`No such path: ${path}`);
      }
    })();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="flex h-[26rem] w-[28rem] max-w-[90vw] flex-col rounded border border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-primary)]">
          {mode === 'file' ? <Trans>Open file</Trans> : <Trans>Select folder</Trans>}
        </h2>
        <div className="mb-2 flex items-center gap-1">
          <button
            type="button"
            onClick={() => parent && setCurrentPath(parent)}
            disabled={!parent}
            aria-label="Up"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <input
            ref={inputRef}
            type="text"
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitDraft();
            }}
            className="h-6 min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg)] py-1">
          {error && <div className="px-2 py-1 text-[11px] text-[var(--red)]">{error}</div>}
          {!entries && !error && (
            <div className="px-2 py-1 text-[11px] italic text-[var(--text-secondary)]">
              <Trans>loading…</Trans>
            </div>
          )}
          {entries && entries.length === 0 && !error && (
            <div className="px-2 py-1 text-[11px] italic text-[var(--text-secondary)]">
              <Trans>empty</Trans>
            </div>
          )}
          {parent && (
            <button
              type="button"
              onClick={() => setCurrentPath(parent)}
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            >
              <ArrowUp className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
              <span className="truncate">..</span>
            </button>
          )}
          {entries?.map((entry) => {
            const path = childPath(currentPath ?? '/', entry.name);
            if (entry.isDirectory) {
              return (
                <button
                  key={entry.name}
                  type="button"
                  onClick={() => setCurrentPath(path)}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                  <span className="truncate">{entry.name}</span>
                </button>
              );
            }
            const pickable = mode === 'file' && extOk(entry.name);
            return (
              <button
                key={entry.name}
                type="button"
                disabled={!pickable}
                onClick={() => setSelected(path)}
                onDoubleClick={() => pickable && onPick(path)}
                className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] ${
                  pickable
                    ? 'text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
                    : 'text-[var(--text-secondary)] opacity-50'
                } ${selected === path ? 'bg-[var(--accent)]/20' : ''}`}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                <span className="truncate">{entry.name}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          >
            <Trans>Cancel</Trans>
          </button>
          {mode === 'dir' ? (
            <button
              type="button"
              disabled={!currentPath}
              onClick={() => currentPath && onPick(currentPath)}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs text-[var(--text-inverted)] hover:opacity-90 disabled:opacity-40"
            >
              <Trans>Select this folder</Trans>
            </button>
          ) : (
            <button
              type="button"
              disabled={!selected}
              onClick={() => selected && onPick(selected)}
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-xs text-[var(--text-inverted)] hover:opacity-90 disabled:opacity-40"
            >
              <Trans>Open</Trans>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
