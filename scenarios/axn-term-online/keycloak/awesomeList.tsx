import { useEffect, useState } from 'react';
import { appRuntime } from '../appRuntime';
import { shellServices } from '../../services';
import { ContextMenu, menuDividerClass, menuItemClass } from '../../ContextMenu';
import { PathActionMenu } from '../../PathActionMenu';
import { pickFromList } from '../pickerHost';
import {
  Check,
  Copy,
  Eye,
  FileText,
  Folder,
  FolderHeart,
  Globe,
  Pencil,
  Plus,
  Search,
  Terminal,
  TerminalSquare,
  TextCursorInput,
  Trash2,
  X,
} from 'lucide-react';
import type { SessionViewContext, PluginApi, SessionViewPlugin } from './plugin';
import { shellQuote } from '../../shellQuote';
import type { ShellSession, Workspace } from '../../types';

// ---------------------------------------------------------------------------
// Bookmark model — persisted in window state under pluginData['awesome-list']
// ---------------------------------------------------------------------------

export interface AwesomeItem {
  id?: string;
  /** Bookmarked path/URL — or the shell command when `type === 'command'`. */
  path: string;
  label?: string;
  type?: 'command';
}

export type AwesomeKind = 'url' | 'dir' | 'file' | 'missing' | 'command';

interface PathStat {
  path: string;
  isFile: boolean;
  isDir: boolean;
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function isUrl(path: string): boolean {
  return URL_RE.test(path);
}

/** Normalized bookmark list from the plugin's persisted app state. */
export function readItems(appState: unknown): AwesomeItem[] {
  const items = (appState as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (i): i is AwesomeItem =>
      !!i &&
      typeof i === 'object' &&
      typeof (i as AwesomeItem).path === 'string' &&
      (i as AwesomeItem).path.length > 0,
  );
}

export function isCommandItem(item: AwesomeItem): boolean {
  return item.type === 'command';
}

export function kindOf(
  item: AwesomeItem,
  stat?: PathStat | null,
): AwesomeKind {
  if (item.type === 'command') return 'command';
  if (isUrl(item.path)) return 'url';
  if (stat?.isDir) return 'dir';
  if (stat?.isFile) return 'file';
  return 'missing';
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** Split a leading token (honoring quotes) off an argument string. */
export function splitHead(arg: string): [string, string] {
  const m = /^(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s+([\s\S]*))?$/.exec(arg.trim());
  if (!m) return ['', ''];
  return [m[1] ?? m[2] ?? m[3] ?? '', (m[4] ?? '').trim()];
}

function unquote(s: string): string {
  const m = /^(["'])([\s\S]*)\1$/.exec(s.trim());
  return m ? m[2] : s.trim();
}

/**
 * Parse a command spec — `[label =] command`. ` = ` (spaces on both sides)
 * separates an optional display label from the command, so `FOO=bar make`
 * stays a plain command.
 */
export function splitCommandSpec(raw: string): { command: string; label?: string } | null {
  const m = /^([\s\S]*?) = ([\s\S]+)$/.exec(raw.trim());
  const command = (m ? m[2] : raw).trim();
  if (!command) return null;
  const label = m?.[1].trim();
  return { command, label: label || undefined };
}

/** Case-insensitive filter over label and path/command text. */
export function matchesQuery(item: AwesomeItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    item.path.toLowerCase().includes(q) ||
    (item.label ?? '').toLowerCase().includes(q)
  );
}

/** Resolve a bookmark path via stat_path — expands ~/, makes it absolute. */
export async function resolveBookmarkPath(
  raw: string,
  cwd?: string | null,
): Promise<string> {
  if (isUrl(raw)) return raw;
  const stat = await appRuntime()?.statPath(raw, cwd ?? undefined).catch(() => null);
  return stat?.path ?? raw;
}

function KindIcon({ kind }: { kind: AwesomeKind }) {
  const cls = 'h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]';
  if (kind === 'command') return <Terminal className={cls} />;
  if (kind === 'url') return <Globe className={cls} />;
  if (kind === 'dir') return <Folder className={cls} />;
  return <FileText className={cls} />;
}

// ---------------------------------------------------------------------------
// Full-area view — the bookmark list
// ---------------------------------------------------------------------------

type Ctx = SessionViewContext & PluginApi;

function AwesomeListView({
  appState,
  updateAppState,
  openTab,
  close,
  sessions,
  workspaces,
  selectedSessionId,
  sessionApi,
  selectSession,
}: {
  appState: unknown;
  updateAppState: (patch: Record<string, unknown>) => void;
  openTab?: (tab: { path: string; kind: 'editor' | 'browser' | 'preview' }) => void;
  close: () => void;
  sessions: ShellSession[];
  workspaces: Workspace[];
  selectedSessionId?: string;
  sessionApi: (sessionId: string) => Ctx | undefined;
  selectSession: (sessionId: string) => void;
}) {
  const items = readItems(appState);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [stats, setStats] = useState<Record<string, PathStat | null>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editPath, setEditPath] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    item: AwesomeItem;
    index: number;
  } | null>(null);

  const save = (next: AwesomeItem[]) => updateAppState({ items: next });
  const itemKey = (item: AwesomeItem, index: number) => item.id ?? `${item.path}#${index}`;

  // Resolve filesystem kind lazily per path (URLs and commands never stat).
  useEffect(() => {
    let cancelled = false;
    for (const item of items) {
      if (isCommandItem(item) || isUrl(item.path) || item.path in stats) continue;
      appRuntime()
        ?.statPath(item.path)
        .then((s) => {
          if (!cancelled) setStats((prev) => ({ ...prev, [item.path]: s }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const addItem = async () => {
    const raw = draft.trim();
    if (!raw) return;
    // A leading `>` stores a favorite command: `> [label =] command`.
    if (raw.startsWith('>')) {
      const spec = splitCommandSpec(raw.slice(1));
      if (!spec) return;
      save([...items, { id: crypto.randomUUID(), path: spec.command, label: spec.label, type: 'command' }]);
      setDraft('');
      return;
    }
    // stat_path expands ~/ and absolutizes — store the resolved path.
    const path = await resolveBookmarkPath(raw);
    save([...items, { id: crypto.randomUUID(), path }]);
    setDraft('');
  };

  // The session selected when the view was opened — the default target for
  // running/typing commands. Falls back to the only session, else a picker
  // asks where to run (a stored command may be destructive — no silent
  // default among many sessions).
  const currentSession =
    sessions.find((s) => s.id === selectedSessionId) ??
    (sessions.length === 1 ? sessions[0] : undefined);

  /** Pick the session a command runs in — directly when unambiguous. */
  const pickSession = async (verb: string): Promise<ShellSession | undefined> => {
    if (sessions.length === 1) return sessions[0];
    if (sessions.length === 0) return undefined;
    const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name;
    const grouped = workspaces.length > 1;
    const key = await pickFromList({
      title: `${verb} in session…`,
      items: sessions.map((s) => ({
        key: s.id,
        label: s.name,
        detail: [s.process, s.cwd].filter(Boolean).join(' · ') || undefined,
        group: grouped ? (wsName(s.workspaceId) ?? 'Sessions') : undefined,
        badge: s.id === selectedSessionId ? 'current' : undefined,
      })),
    });
    return sessions.find((s) => s.id === key);
  };

  /**
   * Send a favorite command to a session — `target` when given (the current
   * session), else a picker chooses. `submit` presses Enter — routed
   * through runCommand first so `axn-*` favorites dispatch correctly;
   * without it the line is typed at the prompt, ready to edit.
   */
  const sendToSession = async (
    item: AwesomeItem,
    submit: boolean,
    target?: ShellSession,
  ) => {
    const session = target ?? (await pickSession(submit ? 'Run command' : 'Insert command'));
    const api = session && sessionApi(session.id);
    if (!session || !api) return;
    if (submit) {
      const res = api.runCommand ? await api.runCommand(item.path) : undefined;
      if (res !== false) {
        await api.writeToSession(`${typeof res === 'string' ? res : item.path}\r`);
      }
    } else {
      await api.writeToSession(item.path);
    }
    selectSession(session.id);
  };

  const copyCommand = (item: AwesomeItem) => {
    void shellServices()?.copyText(item.path);
  };

  const open = (item: AwesomeItem) => {
    if (isCommandItem(item)) {
      void sendToSession(item, true, currentSession);
      return;
    }
    const kind = kindOf(item, stats[item.path]);
    if (kind === 'url') {
      (shellServices()?.openExternal ?? ((u: string) => window.open(u, '_blank', 'noopener')))(item.path);
      return;
    }
    openTab?.({ path: item.path, kind: kind === 'dir' ? 'browser' : 'editor' });
  };

  const startEdit = (item: AwesomeItem, index: number) => {
    setEditing(itemKey(item, index));
    setEditPath(item.path);
    setEditLabel(item.label ?? '');
  };

  const commitEdit = (index: number) => {
    const path = editPath.trim();
    if (!path) return;
    const label = editLabel.trim();
    save(
      items.map((item, i) =>
        i === index ? { ...item, path, label: label || undefined } : item,
      ),
    );
    setEditing(null);
  };

  const actionButton =
    'flex h-5 w-5 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]';

  // Filtered rows keep their index into `items` for edit/remove.
  const indexed = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => matchesQuery(item, query));
  const commandRows = indexed.filter(({ item }) => isCommandItem(item));
  const placeRows = indexed.filter(({ item }) => !isCommandItem(item));
  const grouped = items.some(isCommandItem);
  const filtering = query.trim().length > 0;

  const bookmarkCount = items.length - items.filter(isCommandItem).length;
  const commandCount = items.length - bookmarkCount;

  const sectionHeader = (label: string) => (
    <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
      {label}
    </div>
  );

  const renderRow = (item: AwesomeItem, index: number) => {
    const kind = kindOf(item, stats[item.path]);
    const key = itemKey(item, index);
    if (editing === key) {
      return (
        <div key={key} className="flex items-center gap-1 rounded px-2 py-1">
          <input
            type="text"
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
            placeholder="Label (optional)"
            className="w-36 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <input
            type="text"
            value={editPath}
            onChange={(e) => setEditPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit(index);
              if (e.key === 'Escape') setEditing(null);
            }}
            autoFocus
            className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--surface)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-primary)] outline-none"
          />
          <button
            type="button"
            onClick={() => commitEdit(index)}
            data-tip="Save"
            aria-label="Save"
            className={actionButton}
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            data-tip="Cancel"
            aria-label="Cancel"
            className={actionButton}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      );
    }

    const command = kind === 'command';
    const tip = command
      ? `${item.path}\n${currentSession ? `Run in ${currentSession.name}` : 'Pick a session to run in'}`
      : kind === 'url'
        ? `${item.path}\nOpen externally`
        : kind === 'dir'
          ? `${item.path}\nOpen in browser tab`
          : `${item.path}\nOpen in editor tab`;
    return (
      <div
        key={key}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, item, index });
        }}
        // Disabled buttons swallow pointer events — the "no session" tip
        // lives on the row so it still shows.
        data-tip={command && sessions.length === 0 ? 'No session to run in' : undefined}
        className="group flex items-center gap-2 rounded px-2 py-1.5 transition hover:bg-[var(--surface)]"
      >
        <button
          type="button"
          onClick={() => open(item)}
          disabled={command && sessions.length === 0}
          data-tip={command && sessions.length === 0 ? undefined : tip}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
        >
          <KindIcon kind={kind} />
          <span className="shrink-0 text-[11px] font-semibold text-[var(--text-primary)]">
            {item.label ?? (command ? item.path : basename(item.path))}
          </span>
          {(command ? item.label !== undefined : true) && (
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--text-secondary)]">
              {item.path}
            </span>
          )}
          {kind === 'missing' && (
            <span className="shrink-0 rounded bg-[var(--orange)]/15 px-1 text-[9px] text-[var(--orange)]">
              not found
            </span>
          )}
        </button>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 pointer-coarse:opacity-100">
          {command && (
            <>
              <button
                type="button"
                onClick={() => void sendToSession(item, false, currentSession)}
                disabled={sessions.length === 0}
                data-tip={
                  currentSession
                    ? `Type into ${currentSession.name} — no Enter`
                    : 'Type into a session — no Enter'
                }
                aria-label="Type into session"
                className={actionButton}
              >
                <TextCursorInput className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => copyCommand(item)}
                data-tip="Copy command"
                aria-label="Copy command"
                className={actionButton}
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {kind === 'file' && (
            <button
              type="button"
              onClick={() => openTab?.({ path: item.path, kind: 'preview' })}
              data-tip="Preview"
              aria-label="Preview"
              className={actionButton}
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => startEdit(item, index)}
            data-tip={command ? 'Edit command' : 'Edit bookmark'}
            aria-label={command ? 'Edit command' : 'Edit bookmark'}
            className={actionButton}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => save(items.filter((_, i) => i !== index))}
            data-tip={command ? 'Remove command' : 'Remove bookmark'}
            aria-label="Remove"
            className={`${actionButton} hover:text-[var(--red)]`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3">
        <FolderHeart className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-primary)]">
          awesome list
        </span>
        <span className="text-[10px] text-[var(--text-secondary)]">
          {bookmarkCount > 0 && `${bookmarkCount} bookmark${bookmarkCount === 1 ? '' : 's'}`}
          {bookmarkCount > 0 && commandCount > 0 && ' · '}
          {commandCount > 0 && `${commandCount} command${commandCount === 1 ? '' : 's'}`}
          {items.length === 0 && '0 bookmarks'}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={close}
          data-tip="Close"
          aria-label="Close"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addItem();
          }}
          placeholder="Add a path or URL — or '> a command'  (> label = cmd)"
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        <button
          type="button"
          onClick={() => void addItem()}
          data-tip="Add to awesome list"
          aria-label="Add to awesome list"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
            if (e.key === 'Enter' && indexed[0]) open(indexed[0].item);
          }}
          placeholder="Filter…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent py-0.5 text-[11px] text-[var(--text-primary)] outline-none"
        />
        {filtering && (
          <span className="shrink-0 text-[10px] text-[var(--text-secondary)]">
            {indexed.length} of {items.length}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <div className="px-2 py-3 text-[11px] italic text-[var(--text-secondary)]">
            No bookmarks yet — add a path, URL or {'>'} command above.
          </div>
        ) : indexed.length === 0 ? (
          <div className="px-2 py-3 text-[11px] italic text-[var(--text-secondary)]">
            No matches for “{query.trim()}”.
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {commandRows.length > 0 && (
              <>
                {grouped && sectionHeader('Commands')}
                {commandRows.map(({ item, index }) => renderRow(item, index))}
              </>
            )}
            {placeRows.length > 0 && (
              <>
                {grouped && sectionHeader('Bookmarks')}
                {placeRows.map(({ item, index }) => renderRow(item, index))}
              </>
            )}
          </div>
        )}
      </div>

      {menu &&
        (() => {
          const kind = kindOf(menu.item, stats[menu.item.path]);
          if (kind === 'command') {
            return (
              <ContextMenu
                x={menu.x}
                y={menu.y}
                widthClass="w-64"
                onClose={() => setMenu(null)}
              >
                <button
                  type="button"
                  disabled={!currentSession}
                  onClick={() => {
                    const item = menu.item;
                    setMenu(null);
                    void sendToSession(item, true, currentSession);
                  }}
                  className={`${menuItemClass} disabled:opacity-40 disabled:hover:bg-transparent`}
                >
                  <Terminal className="h-3.5 w-3.5 shrink-0" />
                  Run in {currentSession?.name ?? 'session'}
                </button>
                <button
                  type="button"
                  disabled={sessions.length === 0}
                  onClick={() => {
                    const item = menu.item;
                    setMenu(null);
                    void sendToSession(item, true);
                  }}
                  className={`${menuItemClass} disabled:opacity-40 disabled:hover:bg-transparent`}
                >
                  <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
                  Run in another session…
                </button>
                <button
                  type="button"
                  disabled={!currentSession}
                  onClick={() => {
                    const item = menu.item;
                    setMenu(null);
                    void sendToSession(item, false, currentSession);
                  }}
                  className={`${menuItemClass} disabled:opacity-40 disabled:hover:bg-transparent`}
                >
                  <TextCursorInput className="h-3.5 w-3.5 shrink-0" />
                  Type into {currentSession?.name ?? 'session'} — no Enter
                </button>
                <button
                  type="button"
                  onClick={() => {
                    copyCommand(menu.item);
                    setMenu(null);
                  }}
                  className={menuItemClass}
                >
                  <Copy className="h-3.5 w-3.5 shrink-0" />
                  Copy command
                </button>
                <div className={menuDividerClass} />
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null);
                    startEdit(menu.item, menu.index);
                  }}
                  className={menuItemClass}
                >
                  <Pencil className="h-3.5 w-3.5 shrink-0" />
                  Edit command
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenu(null);
                    save(items.filter((_, i) => i !== menu.index));
                  }}
                  className={`${menuItemClass} hover:text-[var(--red)]`}
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0" />
                  Remove
                </button>
              </ContextMenu>
            );
          }
          return (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              widthClass="w-72"
              onClose={() => setMenu(null)}
            >
              <PathActionMenu
                resolvedPath={menu.item.path}
                isDir={kind === 'dir'}
                isUrl={kind === 'url'}
                variant="menu"
                onEdit={(p) => openTab?.({ path: p, kind: 'editor' })}
                onPreview={(p) => openTab?.({ path: p, kind: 'preview' })}
                onOpenDir={(p) => openTab?.({ path: p, kind: 'browser' })}
                onDismiss={() => setMenu(null)}
                extraItems={
                  <>
                    <div className={menuDividerClass} />
                    <button
                      type="button"
                      onClick={() => {
                        setMenu(null);
                        startEdit(menu.item, menu.index);
                      }}
                      className={menuItemClass}
                    >
                      <Pencil className="h-3.5 w-3.5 shrink-0" />
                      Edit bookmark
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenu(null);
                        save(items.filter((_, i) => i !== menu.index));
                      }}
                      className={`${menuItemClass} hover:text-[var(--red)]`}
                    >
                      <Trash2 className="h-3.5 w-3.5 shrink-0" />
                      Remove
                    </button>
                  </>
                }
              />
            </ContextMenu>
          );
        })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const awesomeListPlugin: SessionViewPlugin = {
  id: 'awesome-list',
  title: 'awesome list',
  version: '0.2.0',
  hostsTabs: true,
  commands: [
    {
      // `axn-awesome` manages the bookmark list from the shell:
      //   axn-awesome            — print the numbered list
      //   axn-awesome add <path|url> [label]
      //   axn-awesome cmd [<label> =] <command>
      //   axn-awesome run <n|name>  — run a stored command in this shell
      //   axn-awesome rm <n|name>
      name: 'axn-awesome',
      takesArg: true,
      // `axn-awesome <Tab>` completes subcommand names; after `run`/`rm` it
      // completes the item's index, label (quoted when it has spaces) and —
      // for path bookmarks — its basename, the needles findIndex accepts.
      completeArg: (ctx, prefix) => {
        if (!/\s/.test(prefix)) {
          return ['ls', 'add', 'cmd', 'run', 'rm'].filter(
            (s) => s.startsWith(prefix) && s !== prefix,
          );
        }
        const [sub, subArg] = splitHead(prefix);
        if (sub !== 'run' && sub !== 'rm' && sub !== 'remove') return [];
        const needle = unquote(subArg).replace(/^["']/, '');
        const seen = new Set<string>();
        const names: string[] = [];
        const push = (n?: string) => {
          if (n && n.startsWith(needle) && n !== needle && !seen.has(n)) {
            seen.add(n);
            names.push(n);
          }
        };
        readItems(ctx.appState).forEach((it, i) => {
          if (sub === 'run' && !isCommandItem(it)) return;
          push(String(i + 1));
          push(it.label);
          if (sub !== 'run' && !isCommandItem(it)) push(basename(it.path));
        });
        return names.map((n) => `${sub} ${n.includes(' ') ? `"${n}"` : n}`);
      },
      run: async (ctx, arg) => {
        const items = readItems(ctx.appState);
        const [sub, subArg] = splitHead(arg ?? '');
        const print = (lines: string[]) =>
          `printf '%s\\n' ${lines.map(shellQuote).join(' ')}`;
        const findIndex = (needle: string) =>
          /^\d+$/.test(needle)
            ? Number(needle) - 1
            : items.findIndex(
                (it) =>
                  it.path === needle ||
                  it.path.endsWith(`/${needle}`) ||
                  it.label === needle,
              );

        if (sub === 'add') {
          const [raw, label] = splitHead(subArg);
          if (!raw) {
            return `echo ${shellQuote('usage: axn-awesome add <path|url> [label]')}`;
          }
          const cwd = (await ctx.getCwd()) ?? ctx.session.cwd;
          const path = await resolveBookmarkPath(raw, cwd);
          const item: AwesomeItem = {
            id: crypto.randomUUID(),
            path,
            label: unquote(label) || undefined,
          };
          ctx.updateAppState({ items: [...items, item] });
          return `echo ${shellQuote(`awesome: added ${item.label ?? path}`)}`;
        }

        if (sub === 'cmd') {
          const spec = splitCommandSpec(subArg);
          if (!spec) {
            return `echo ${shellQuote('usage: axn-awesome cmd [<label> =] <command>')}`;
          }
          const item: AwesomeItem = {
            id: crypto.randomUUID(),
            path: spec.command,
            label: spec.label,
            type: 'command',
          };
          ctx.updateAppState({ items: [...items, item] });
          return `echo ${shellQuote(`awesome: added command ${item.label ?? item.path}`)}`;
        }

        if (sub === 'run') {
          const needle = unquote(subArg);
          if (!needle) {
            return `echo ${shellQuote('usage: axn-awesome run <n|name>')}`;
          }
          const item = items[findIndex(needle)];
          if (!item) {
            return `echo ${shellQuote(`awesome: no item ${needle}`)}`;
          }
          if (!isCommandItem(item)) {
            return `echo ${shellQuote(`awesome: ${item.label ?? item.path} is a bookmark, not a command`)}`;
          }
          // Route through the session's command dispatch — the same path
          // clicking the row takes — so stored `axn-*` favorites dispatch
          // instead of reaching the shell verbatim. A plain command comes
          // back undefined and replaces the typed line.
          const res = ctx.runCommand ? await ctx.runCommand(item.path) : undefined;
          return res === undefined ? item.path : res;
        }

        if (sub === 'rm' || sub === 'remove') {
          const needle = unquote(subArg);
          if (!needle) {
            return `echo ${shellQuote('usage: axn-awesome rm <n|name>')}`;
          }
          const idx = findIndex(needle);
          const item = idx >= 0 && idx < items.length ? items[idx] : undefined;
          if (!item) {
            return `echo ${shellQuote(`awesome: no bookmark ${needle}`)}`;
          }
          ctx.updateAppState({ items: items.filter((_, i) => i !== idx) });
          return `echo ${shellQuote(`awesome: removed ${item.label ?? item.path}`)}`;
        }

        if (sub && sub !== 'ls' && sub !== 'list') {
          return `echo ${shellQuote('usage: axn-awesome [ls|add <path|url> [label]|cmd [<label> =] <command>|run <n|name>|rm <n|name>]')}`;
        }
        return print(
          items.length === 0
            ? ['awesome list: no bookmarks — add one with `axn-awesome add <path|url>` or `axn-awesome cmd <command>`']
            : items.map((it, i) =>
                isCommandItem(it)
                  ? `${i + 1}. ${it.label ? `${it.label} — ` : ''}$ ${it.path}`
                  : `${i + 1}. ${it.label ? `${it.label} — ` : ''}${it.path}`,
              ),
        );
      },
    },
  ],
  renderRail: ({ viewActive, toggleView, appState }) => {
    const count = readItems(appState).length;
    return (
      <button
        type="button"
        onClick={toggleView}
        data-tip={`awesome list — ${count} favorite${count === 1 ? '' : 's'} (paths, URLs & commands)`}
        className={`flex flex-col items-center gap-0.5 rounded px-1 py-0.5 transition ${
          viewActive
            ? 'bg-[var(--surface)] text-[var(--accent)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
        }`}
      >
        <FolderHeart className="h-3.5 w-3.5" />
        {count > 0 && (
          <span className="select-none text-[8px] font-bold leading-none">{count}</span>
        )}
      </button>
    );
  },
  renderView: ({ appState, updateAppState, openTab, close, sessions, workspaces, selectedSessionId, sessionApi, selectSession }) => (
    <AwesomeListView
      appState={appState}
      updateAppState={updateAppState}
      openTab={openTab}
      close={close}
      sessions={sessions}
      workspaces={workspaces}
      selectedSessionId={selectedSessionId}
      sessionApi={sessionApi}
      selectSession={selectSession}
    />
  ),
};
