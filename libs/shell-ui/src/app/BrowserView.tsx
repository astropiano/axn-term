import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirEntry } from '@axn-term/session-backend';
import { FileText, Folder, ChevronLeft, ChevronRight, ArrowUp, RefreshCw, FilePlus, FolderPlus, Copy, FolderSearch } from 'lucide-react';
import { resolvePath } from './fileService';
import { appRuntime } from './appRuntime';
import { ContextMenu, menuDividerClass, menuItemClass } from '../ContextMenu';
import { PathActionMenu } from '../PathActionMenu';
import { useSessionBackend, useShellPlatform, useShellServices } from '../services';
import { revealLabel as platformRevealLabel } from '../platform';

interface BrowserViewProps {
  path: string;
  cwd?: string;
  isVisible?: boolean;
  onOpenFile: (path: string) => void;
  onPreviewFile?: (path: string) => void;
  /** Owning session's id; plugin-hosted tabs resolve any live session. */
  sessionId?: string;
}

type BrowserMenu =
  | { kind: 'entry'; x: number; y: number; entry: DirEntry; path: string }
  | { kind: 'background'; x: number; y: number };

function splitDirBase(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf('/');
  return i === -1 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

const HISTORY_LIMIT = 20;

export function BrowserView({
  path,
  cwd,
  isVisible,
  onOpenFile,
  onPreviewFile,
  sessionId: sessionIdProp,
}: BrowserViewProps) {
  const [currentPath, setCurrentPath] = useState<string>(() => resolvePath(cwd, path));
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { services } = useShellServices();
  const backend = useSessionBackend();
  const platform = useShellPlatform();
  const sessionId = sessionIdProp ?? appRuntime()?.resolveSessionId() ?? '';
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<BrowserMenu | null>(null);
  // Inline "new file/folder" row — Enter creates, Esc cancels.
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null);
  const [createDraft, setCreateDraft] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [showHidden, setShowHidden] = useState(false);
  // Back/forward navigation — in-memory only, capped at HISTORY_LIMIT steps.
  const [history, setHistory] = useState<{ stack: string[]; index: number }>(() => ({
    stack: [resolvePath(cwd, path)],
    index: 0,
  }));
  const listRef = useRef<HTMLDivElement>(null);

  // Every user-driven navigation goes through here so it lands in history.
  const navigate = useCallback((next: string) => {
    setCurrentPath(next);
    setHistory((h) => {
      if (h.stack[h.index] === next) return h;
      const stack = h.stack.slice(0, h.index + 1);
      stack.push(next);
      if (stack.length > HISTORY_LIMIT) stack.shift();
      return { stack, index: stack.length - 1 };
    });
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    if (!backend.listDir) {
      setError('Directory listing is not available on this backend.');
      return;
    }
    setLoading(true);
    setError(null);
    backend.listDir(sessionId, currentPath)
      .then((list) => {
        const typed = list as unknown as DirEntry[];
        const sorted = typed.slice().sort((a, b) => {
          if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
          return a.isDirectory ? -1 : 1;
        });
        setEntries(sorted);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [currentPath, isVisible, reloadKey]);

  // Watch the directory while the tab is visible so filesystem changes
  // refresh the listing automatically. May reject for paths outside the fs
  // scope — the refresh button remains as the manual fallback.
  useEffect(() => {
    if (!isVisible) return;
    let unwatch: (() => void) | undefined;
    let cancelled = false;
    Promise.resolve(backend.watchDir?.(sessionId, currentPath, () => setReloadKey((k) => k + 1)) ?? (() => {}))
      .then((fn) => {
        if (cancelled) fn();
        else unwatch = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unwatch?.();
    };
  }, [currentPath, isVisible]);

  // Keyboard navigation needs focus — grab it when the tab becomes visible.
  useEffect(() => {
    if (isVisible) listRef.current?.focus();
  }, [isVisible]);

  // A pending create belongs to the directory it was started in.
  useEffect(() => {
    setCreating(null);
    setCreateError(null);
  }, [currentPath]);

  const startCreate = (kind: 'file' | 'dir') => {
    setMenu(null);
    setCreateDraft('');
    setCreateError(null);
    setCreating(kind);
  };

  const commitCreate = async () => {
    if (!creating) return;
    const name = createDraft.trim();
    if (!name) {
      setCreating(null);
      return;
    }
    if (name.includes('/') || name.includes('\\')) {
      setCreateError('enter a plain name, not a path');
      return;
    }
    if (entries.some((e) => e.name === name)) {
      setCreateError(`'${name}' already exists`);
      return;
    }
    const target = `${currentPath.replace(/\/$/, '')}/${name}`;
    try {
      if (await backend.fsExists?.(sessionId, target)) {
        setCreateError(`'${name}' already exists`);
        return;
      }
      if (creating === 'dir') {
        await backend.mkdir?.(sessionId, target);
        setSelected(name);
      } else {
        if (!backend.writeFile) throw new Error('file writes are not supported');
        await backend.writeFile(sessionId, target, '');
        onOpenFile(target);
      }
      setCreating(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setCreateError(String(e));
    }
  };

  const expandPath = useCallback(
    async (value: string): Promise<string> => {
      if (value === '~' || value.startsWith('~/')) {
        const home = await platform.homeDir();
        return home.replace(/\/$/, '') + value.slice(1);
      }
      if (value.startsWith('/')) return value;
      return `${currentPath.replace(/\/$/, '')}/${value}`;
    },
    [currentPath],
  );

  // Directory suggestions while editing the path bar.
  useEffect(() => {
    if (pathDraft === null) {
      setSuggestions([]);
      setSuggestIndex(-1);
      return;
    }
    const { dir, base } = splitDirBase(pathDraft);
    const timer = setTimeout(() => {
      expandPath(dir === '' ? '.' : dir)
        .then((absDir) => backend.listDir?.(sessionId, resolvePath(undefined, absDir)) ?? [])
        .then((list) => {
          const typed = list as unknown as DirEntry[];
          setSuggestions(
            typed
              .filter((e) => e.isDirectory && e.name.startsWith(base) && e.name !== base)
              .map((e) => `${dir}${e.name}/`)
              .sort()
              .slice(0, 10),
          );
          setSuggestIndex(-1);
        })
        .catch(() => setSuggestions([]));
    }, 120);
    return () => clearTimeout(timer);
  }, [pathDraft, expandPath]);

  const parent = currentPath.includes('/')
    ? currentPath.replace(/\/[^/]*\/?$/, '') || '/'
    : null;
  const canBack = history.index > 0;
  const canForward = history.index < history.stack.length - 1;
  // Dotfiles are filtered at render time so toggling reuses the same listing.
  const visibleEntries = showHidden
    ? entries
    : entries.filter((e) => !e.name.startsWith('.'));

  const openEntry = (entry: DirEntry) => {
    const child = resolvePath(
      undefined,
      `${currentPath.replace(/\/$/, '')}/${entry.name}`,
    );
    if (entry.isDirectory) {
      setSelected(null);
      navigate(child);
    } else if (entry.isFile || entry.isSymlink) {
      onOpenFile(child);
    }
  };

  const goUp = () => {
    if (!parent || parent === currentPath) return;
    const left = currentPath.replace(/\/$/, '').split('/').pop() ?? '';
    navigate(parent);
    // Highlight the folder we just left — the "current selected folder".
    setSelected(left);
  };

  const historyStep = (delta: -1 | 1) => {
    const next = history.index + delta;
    if (next < 0 || next >= history.stack.length) return;
    const left = currentPath.replace(/\/$/, '').split('/').pop() ?? '';
    setHistory({ stack: history.stack, index: next });
    setCurrentPath(history.stack[next]);
    // Highlight the folder we just left, like goUp does.
    setSelected(left);
  };

  const commitPath = (value: string) => {
    const draft = value;
    setPathDraft(null);
    expandPath(draft)
      .then((abs) => {
        setSelected(null);
        navigate(resolvePath(undefined, abs));
      })
      .catch(() => {});
  };

  const handlePathKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      setPathDraft(null);
    } else if (e.key === 'Enter') {
      commitPath(suggestIndex >= 0 ? suggestions[suggestIndex] : pathDraft ?? '');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (suggestions.length === 0) return;
      const pick = suggestions[suggestIndex >= 0 ? suggestIndex : 0];
      setPathDraft(pick);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSuggestIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSuggestIndex((i) => Math.max(i - 1, -1));
    }
  };

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (menu) return;
    const idx = visibleEntries.findIndex((entry) => entry.name === selected);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(
        visibleEntries[Math.min(idx + 1, visibleEntries.length - 1)]?.name ?? null,
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(visibleEntries[Math.max(idx - 1, 0)]?.name ?? null);
    } else if (e.key === 'Enter') {
      const entry = visibleEntries.find((en) => en.name === selected);
      if (entry) openEntry(entry);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      goUp();
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-[var(--terminal-bg)]">
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2">
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={() => historyStep(-1)}
            disabled={!canBack}
            data-tip="Back"
            aria-label="Back"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => historyStep(1)}
            disabled={!canForward}
            data-tip="Forward"
            aria-label="Forward"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={goUp}
            disabled={!parent || parent === currentPath}
            data-tip="Go up"
            aria-label="Go up"
            className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:pointer-events-none disabled:opacity-30"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
        </div>
        {pathDraft === null ? (
          <span
            className="min-w-0 flex-1 cursor-text truncate font-mono text-[10px] text-[var(--text-secondary)]"
            data-tip={`${currentPath} (click to edit)`}
            onClick={() => setPathDraft(currentPath)}
          >
            {currentPath}
          </span>
        ) : (
          <div className="relative min-w-0 flex-1">
            <input
              autoFocus
              type="text"
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onKeyDown={handlePathKeyDown}
              onBlur={() => setPathDraft(null)}
              spellCheck={false}
              className="w-full rounded border border-[var(--accent)] bg-[var(--bg)] px-1 font-mono text-[10px] text-[var(--text-primary)] outline-none"
            />
            {suggestions.length > 0 && (
              <ul className="absolute inset-x-0 top-full z-20 mt-0.5 max-h-48 overflow-y-auto rounded border border-[var(--border)] bg-[var(--surface)] shadow-lg">
                {suggestions.map((s, i) => (
                  <li key={s}>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        commitPath(s);
                      }}
                      className={`block w-full truncate px-2 py-1 text-left font-mono text-[10px] ${
                        i === suggestIndex
                          ? 'bg-[var(--surface-hover)] text-[var(--accent)]'
                          : 'text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
                      }`}
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          data-tip="Refresh"
          aria-label="Refresh"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)]"
        >
          <RefreshCw className={`h-3.5 w-3.5${loading ? ' animate-spin' : ''}`} />
        </button>
      </div>
      <div className="flex h-5 shrink-0 items-center border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2">
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-[10px] text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
            className="h-3 w-3 accent-[var(--accent)]"
          />
          show hidden files
        </label>
      </div>
      <div
        ref={listRef}
        tabIndex={0}
        onKeyDown={handleListKeyDown}
        onContextMenu={(e) => {
          // Entry buttons stopPropagation — this only fires on empty space.
          e.preventDefault();
          setMenu({ kind: 'background', x: e.clientX, y: e.clientY });
        }}
        className="min-h-0 flex-1 overflow-y-auto p-2 outline-none"
      >
        {loading && (
          <div className="text-[10px] text-[var(--text-secondary)]">loading...</div>
        )}
        {error && <div className="text-[10px] text-[var(--red)]">{error}</div>}
        {!loading && !error && visibleEntries.length === 0 && !creating && (
          <div className="text-[10px] text-[var(--text-secondary)]">empty directory</div>
        )}
        {creating && (
          <div
            className="mb-1.5 flex items-center gap-2 rounded bg-[var(--surface)] px-1.5 py-1"
            onContextMenu={(e) => e.stopPropagation()}
          >
            {creating === 'dir' ? (
              <FolderPlus className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
            ) : (
              <FilePlus className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
            )}
            <input
              autoFocus
              type="text"
              value={createDraft}
              placeholder={creating === 'dir' ? 'new folder name' : 'new file name'}
              onChange={(e) => {
                setCreateDraft(e.target.value);
                setCreateError(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') void commitCreate();
                else if (e.key === 'Escape') setCreating(null);
              }}
              onBlur={() => setCreating(null)}
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--bg)] px-1 font-mono text-[10px] text-[var(--text-primary)] outline-none"
            />
            {createError && (
              <span className="shrink-0 text-[10px] text-[var(--red)]">{createError}</span>
            )}
          </div>
        )}
        <ul className="space-y-0.5">
          {visibleEntries.map((entry) => (
            <li key={entry.name}>
              <button
                type="button"
                onClick={() => setSelected(entry.name)}
                onDoubleClick={() => openEntry(entry)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelected(entry.name);
                  setMenu({
                    kind: 'entry',
                    x: e.clientX,
                    y: e.clientY,
                    entry,
                    path: resolvePath(
                      undefined,
                      `${currentPath.replace(/\/$/, '')}/${entry.name}`,
                    ),
                  });
                }}
                className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] transition hover:bg-[var(--surface)] ${
                  selected === entry.name
                    ? 'bg-[var(--surface)] text-[var(--accent)]'
                    : 'text-[var(--text-primary)]'
                }`}
              >
                {entry.isDirectory ? (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
                )}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {menu?.kind === 'entry' && (
        <ContextMenu x={menu.x} y={menu.y} widthClass="w-72" onClose={() => setMenu(null)}>
          <PathActionMenu
            resolvedPath={menu.path}
            isDir={menu.entry.isDirectory}
            variant="menu"
            onEdit={onOpenFile}
            onPreview={onPreviewFile}
            onOpenDir={(p) => {
              setSelected(null);
              navigate(p);
            }}
            onDismiss={() => setMenu(null)}
          />
        </ContextMenu>
      )}
      {menu?.kind === 'background' && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="p-1">
            <div
              className="truncate px-2 py-1 font-mono text-[10px] text-[var(--text-secondary)]"
              data-tip={currentPath}
            >
              {currentPath}
            </div>
            <div className={menuDividerClass} />
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => startCreate('file')}
                className={menuItemClass}
              >
                <FilePlus className="h-3.5 w-3.5 shrink-0" />
                New file
              </button>
              <button
                type="button"
                onClick={() => startCreate('dir')}
                className={menuItemClass}
              >
                <FolderPlus className="h-3.5 w-3.5 shrink-0" />
                New folder
              </button>
              <div className={menuDividerClass} />
              <button
                type="button"
                onClick={() => {
                  void services.copyText(currentPath);
                  setMenu(null);
                }}
                className={menuItemClass}
              >
                <Copy className="h-3.5 w-3.5 shrink-0" />
                Copy path
              </button>
              {services.revealPath && (
                <button
                  type="button"
                  onClick={() => {
                    services.revealPath?.(currentPath);
                    setMenu(null);
                  }}
                  className={menuItemClass}
                >
                  <FolderSearch className="h-3.5 w-3.5 shrink-0" />
                  {services.revealLabel ?? platformRevealLabel}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setReloadKey((k) => k + 1);
                  setMenu(null);
                }}
                className={menuItemClass}
              >
                <RefreshCw className="h-3.5 w-3.5 shrink-0" />
                Refresh
              </button>
            </div>
          </div>
        </ContextMenu>
      )}
    </div>
  );
}
