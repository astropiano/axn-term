import { useEffect, useState } from 'react';
import { appRuntime } from '../appRuntime';
import { shellServices } from '../../services';
import { ContextMenu, menuDividerClass, menuItemClass } from '../../ContextMenu';
import { PathActionMenu } from '../../PathActionMenu';
import {
  Check,
  Eye,
  FileText,
  Folder,
  FolderHeart,
  Globe,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { SessionViewPlugin } from './plugin';

// ---------------------------------------------------------------------------
// Bookmark model — persisted in window state under pluginData['awesome-list']
// ---------------------------------------------------------------------------

export interface AwesomeItem {
  id?: string;
  path: string;
  label?: string;
}

export type AwesomeKind = 'url' | 'dir' | 'file' | 'missing';

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

export function kindOf(path: string, stat?: PathStat | null): AwesomeKind {
  if (isUrl(path)) return 'url';
  if (stat?.isDir) return 'dir';
  if (stat?.isFile) return 'file';
  return 'missing';
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
  if (kind === 'url') return <Globe className={cls} />;
  if (kind === 'dir') return <Folder className={cls} />;
  return <FileText className={cls} />;
}

// ---------------------------------------------------------------------------
// Full-area view — the bookmark list
// ---------------------------------------------------------------------------

function AwesomeListView({
  appState,
  updateAppState,
  openTab,
  close,
}: {
  appState: unknown;
  updateAppState: (patch: Record<string, unknown>) => void;
  openTab?: (tab: { path: string; kind: 'editor' | 'browser' | 'preview' }) => void;
  close: () => void;
}) {
  const items = readItems(appState);
  const [draft, setDraft] = useState('');
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

  // Resolve filesystem kind lazily per path (URLs are never statted).
  useEffect(() => {
    let cancelled = false;
    for (const item of items) {
      if (isUrl(item.path) || item.path in stats) continue;
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
    // stat_path expands ~/ and absolutizes — store the resolved path.
    const path = await resolveBookmarkPath(raw);
    save([...items, { id: crypto.randomUUID(), path }]);
    setDraft('');
  };

  const open = (item: AwesomeItem) => {
    const kind = kindOf(item.path, stats[item.path]);
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3">
        <FolderHeart className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-primary)]">
          awesome list
        </span>
        <span className="text-[10px] text-[var(--text-secondary)]">
          {items.length} bookmark{items.length === 1 ? '' : 's'}
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
          placeholder="Add a folder, file or URL — e.g. ~/.colima/default/colima.yaml"
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        <button
          type="button"
          onClick={() => void addItem()}
          data-tip="Add bookmark"
          aria-label="Add bookmark"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <div className="px-2 py-3 text-[11px] italic text-[var(--text-secondary)]">
            No bookmarks yet — add a folder, file or URL above.
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {items.map((item, index) => {
              const kind = kindOf(item.path, stats[item.path]);
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
              return (
                <div
                  key={key}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, item, index });
                  }}
                  className="group flex items-center gap-2 rounded px-2 py-1.5 transition hover:bg-[var(--surface)]"
                >
                  <button
                    type="button"
                    onClick={() => open(item)}
                    data-tip={
                      kind === 'url'
                        ? `${item.path}\nOpen externally`
                        : kind === 'dir'
                          ? `${item.path}\nOpen in browser tab`
                          : `${item.path}\nOpen in editor tab`
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <KindIcon kind={kind} />
                    <span className="shrink-0 text-[11px] font-semibold text-[var(--text-primary)]">
                      {item.label ?? basename(item.path)}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--text-secondary)]">
                      {item.path}
                    </span>
                    {kind === 'missing' && (
                      <span className="shrink-0 rounded bg-[var(--orange)]/15 px-1 text-[9px] text-[var(--orange)]">
                        not found
                      </span>
                    )}
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
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
                      data-tip="Edit bookmark"
                      aria-label="Edit bookmark"
                      className={actionButton}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => save(items.filter((_, i) => i !== index))}
                      data-tip="Remove bookmark"
                      aria-label="Remove bookmark"
                      className={`${actionButton} hover:text-[var(--red)]`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {menu &&
        (() => {
          const kind = kindOf(menu.item.path, stats[menu.item.path]);
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
  version: '0.1.0',
  hostsTabs: true,
  commands: [
    {
      // `axn-awesome` manages the bookmark list from the shell:
      //   axn-awesome            — print the numbered list
      //   axn-awesome add <path|url> [label]
      //   axn-awesome rm <n|path>
      name: 'axn-awesome',
      takesArg: true,
      run: async (ctx, arg) => {
        const items = readItems(ctx.appState);
        const [sub, subArg] = splitHead(arg ?? '');
        const print = (lines: string[]) =>
          `printf '%s\\n' ${lines.map(shQuote).join(' ')}`;

        if (sub === 'add') {
          const [raw, label] = splitHead(subArg);
          if (!raw) {
            return `echo ${shQuote('usage: axn-awesome add <path|url> [label]')}`;
          }
          const cwd = (await ctx.getCwd()) ?? ctx.session.cwd;
          const path = await resolveBookmarkPath(raw, cwd);
          const item: AwesomeItem = {
            id: crypto.randomUUID(),
            path,
            label: unquote(label) || undefined,
          };
          ctx.updateAppState({ items: [...items, item] });
          return `echo ${shQuote(`awesome: added ${item.label ?? path}`)}`;
        }

        if (sub === 'rm' || sub === 'remove') {
          const needle = unquote(subArg);
          if (!needle) {
            return `echo ${shQuote('usage: axn-awesome rm <n|path>')}`;
          }
          const idx = /^\d+$/.test(needle)
            ? Number(needle) - 1
            : items.findIndex(
                (it) =>
                  it.path === needle ||
                  it.path.endsWith(`/${needle}`) ||
                  it.label === needle,
              );
          const item = idx >= 0 && idx < items.length ? items[idx] : undefined;
          if (!item) {
            return `echo ${shQuote(`awesome: no bookmark ${needle}`)}`;
          }
          ctx.updateAppState({ items: items.filter((_, i) => i !== idx) });
          return `echo ${shQuote(`awesome: removed ${item.label ?? item.path}`)}`;
        }

        if (sub && sub !== 'ls' && sub !== 'list') {
          return `echo ${shQuote('usage: axn-awesome [ls|add <path|url> [label]|rm <n|path>]')}`;
        }
        return print(
          items.length === 0
            ? ['awesome list: no bookmarks — add one with `axn-awesome add <path|url>`']
            : items.map(
                (it, i) => `${i + 1}. ${it.label ? `${it.label} — ` : ''}${it.path}`,
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
        data-tip={`awesome list — ${count} bookmarked path${count === 1 ? '' : 's'} & URLs`}
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
  renderView: ({ appState, updateAppState, openTab, close }) => (
    <AwesomeListView
      appState={appState}
      updateAppState={updateAppState}
      openTab={openTab}
      close={close}
    />
  ),
};
