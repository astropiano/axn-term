import { useCallback, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { useShellServices } from '../../services';
import { repoInfo } from '../gitClient';
import { ptyIdOf, type RepoInfo } from '../../types';
import { ContextMenu } from '../../ContextMenu';
import { openFolderLabel } from '../../platform';
import type { PluginApi, RepoMenuItem, SessionViewContext, SessionViewPlugin } from './plugin';


interface MenuPosition {
  x: number;
  y: number;
}

function RepoMenu({
  ctx,
  repo,
  cwd,
  position,
  items,
  onClose,
}: {
  ctx: SessionViewContext & PluginApi;
  repo: RepoInfo;
  cwd?: string;
  position: MenuPosition;
  /** Rows contributed by other plugins via their `repoMenuItems` hook. */
  items: RepoMenuItem[];
  onClose: () => void;
}) {
  const { services } = useShellServices();
  const folder = cwd ?? repo.root;

  return (
    <ContextMenu x={position.x} y={position.y} onClose={onClose}>
      <div className="p-2">
      <div className="mb-1 truncate px-2 py-1 text-[11px] text-[var(--text-secondary)]">
        <span className="font-semibold text-[var(--text-primary)]">Repo:</span> {repo.root}
      </div>
      <div className="my-1.5 h-px bg-[var(--hairline)]" />
      <button
        type="button"
        onClick={() => {
          void services.copyText(cwd ?? repo.root);
          onClose();
        }}
        className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
      >
        Copy folder path
      </button>
      <button
        type="button"
        onClick={() => {
          void services.copyText(repo.root);
          onClose();
        }}
        className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
      >
        Copy repo root
      </button>
      <button
        type="button"
        disabled={!repo.remote}
        onClick={() => {
          if (repo.remote) void services.copyText(repo.remote);
          onClose();
        }}
        className={`flex w-full items-center rounded px-2 py-1.5 text-left text-xs transition ${
          repo.remote
            ? 'text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
            : 'cursor-not-allowed text-[var(--text-secondary)]'
        }`}
      >
        Copy remote
      </button>
      <div className="my-1.5 h-px bg-[var(--hairline)]" />
      <button
        type="button"
        onClick={() => {
          ctx.openBrowser(folder);
          onClose();
        }}
        className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
      >
        Browse
      </button>
      <button
        type="button"
        onClick={() => {
          services.openDirectory?.(folder);
          onClose();
        }}
        className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
      >
        {openFolderLabel}
      </button>
      {items.length > 0 && <div className="my-1.5 h-px bg-[var(--hairline)]" />}
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          onClick={() => {
            item.onClick();
            onClose();
          }}
          className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
        >
          {item.label}
        </button>
      ))}
      </div>
    </ContextMenu>
  );
}

function repoIndicators(repo: RepoInfo): { color: string; text: string }[] {
  const indicators: { color: string; text: string }[] = [];
  if (repo.remoteBranchMissing) indicators.push({ color: 'text-[var(--red)]', text: '×' });
  if (repo.ahead > 0) indicators.push({ color: 'text-[var(--green)]', text: `↑${repo.ahead}` });
  if (repo.behind > 0) indicators.push({ color: 'text-[var(--red)]', text: `↓${repo.behind}` });
  if (repo.dirty) indicators.push({ color: 'text-[var(--yellow)]', text: '~' });
  if (repo.untracked > 0) indicators.push({ color: 'text-[var(--orange)]', text: `?${repo.untracked}` });
  if (indicators.length === 0) indicators.push({ color: 'text-[var(--green)]', text: '✓' });
  return indicators;
}

function GitStatus({
  ctx,
  repo,
  cwd,
}: {
  ctx: SessionViewContext & PluginApi;
  repo: RepoInfo;
  cwd?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition>({ x: 0, y: 0 });
  const branch = repo.branch ?? '(detached)';
  const indicators = repoIndicators(repo);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setMenuOpen(true);
  }, []);

  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 overflow-hidden font-mono text-[11px]"
      onContextMenu={handleContextMenu}
    >
      <div
        className="flex min-w-0 cursor-pointer items-center gap-1 select-none text-[var(--text-primary)]"
        data-tip={`${repo.group ?? ''}/${repo.name}`}
      >
        {repo.group && <span className="truncate text-[var(--text-secondary)]">{repo.group}</span>}
        {repo.group && <span className="text-[var(--text-secondary)]">/</span>}
        <span className="truncate font-semibold">{repo.name}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        <span
          className={`min-w-0 truncate ${repo.branch ? 'text-[var(--cyan)]' : 'text-[var(--yellow)]'}`}
          data-tip={branch}
        >
          {branch}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {indicators.map((ind, i) => (
            <span key={i} className={ind.color}>
              {ind.text}
            </span>
          ))}
        </span>
      </div>
      {menuOpen && (
        <RepoMenu
          ctx={ctx}
          repo={repo}
          cwd={cwd}
          position={menuPos}
          items={ctx.repoMenuItems(repo)}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * The session-row repo element (branch icon + indicators). Right-click opens
 * the same `RepoMenu` the panel block uses — including `repoMenuItems` rows
 * contributed by other plugins (e.g. git-inspect's "Git changes…"). The session
 * row owns the surrounding context menu, so the events stop here.
 */
function GitStatusRow({
  ctx,
  repo,
  cwd,
}: {
  ctx: SessionViewContext & PluginApi;
  repo: RepoInfo;
  cwd?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition>({ x: 0, y: 0 });
  const branch = repo.branch ?? '(detached)';

  return (
    <>
      <span
        className="flex shrink-0 items-center gap-1 font-mono text-[10px] leading-none"
        data-tip={`${repo.root}\n${branch}`}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
          setMenuOpen(true);
        }}
        // A held right-button would otherwise start the row's long-press
        // session menu while the repo menu is already open.
        onMouseDown={(e) => {
          if (e.button === 2) e.stopPropagation();
        }}
      >
        <GitBranch className="h-2.5 w-2.5 shrink-0 text-[var(--cyan)]" />
        <span className="flex shrink-0 items-center gap-0.5">
          {repoIndicators(repo).map((ind, i) => (
            <span key={i} className={ind.color}>
              {ind.text}
            </span>
          ))}
        </span>
      </span>
      {menuOpen && (
        <RepoMenu
          ctx={ctx}
          repo={repo}
          cwd={cwd}
          position={menuPos}
          items={ctx.repoMenuItems(repo)}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </>
  );
}

const REFRESH_DELAY_MS = 400;
const MIN_REFRESH_INTERVAL_MS = 1500;
const refreshTimers = new Map<string, number>();
const lastRefresh = new Map<string, number>();

/**
 * Refresh once the terminal goes quiet — a settling PTY stream means the
 * foreground command finished and the shell prompt came back. This catches
 * every way a command can be submitted (typed, history recall, aliases,
 * paste), which tracking the input line cannot.
 */
async function refreshRepo(ctx: SessionViewContext & PluginApi) {
  lastRefresh.set(ctx.session.id, Date.now());
  const cwd = (await ctx.getCwd()) ?? ctx.session.cwd;
  if (!cwd) return;
  try {
    // execGit routes by PTY id — session.id diverges after a sub-shell was
    // promoted to main, and remote backends key the lookup on it.
    const repo = await repoInfo(ptyIdOf(ctx.getSession()), cwd);
    if (JSON.stringify(repo) !== JSON.stringify(ctx.getSession().repo)) {
      ctx.updateSession(ctx.session.id, { repo: repo ?? undefined });
    }
  } catch {
    // ignore
  }
}

function scheduleRefresh(ctx: SessionViewContext & PluginApi) {
  const id = ctx.session.id;
  const existing = refreshTimers.get(id);
  if (existing !== undefined) window.clearTimeout(existing);
  const elapsed = Date.now() - (lastRefresh.get(id) ?? 0);
  const delay = Math.max(REFRESH_DELAY_MS, MIN_REFRESH_INTERVAL_MS - elapsed);
  refreshTimers.set(
    id,
    window.setTimeout(() => {
      refreshTimers.delete(id);
      void refreshRepo(ctx);
    }, delay),
  );
}

export const gitStatusPlugin: SessionViewPlugin = {
  id: 'git-status',
  title: 'git',
  version: '0.1.0',
  settings: [
    {
      key: 'showInPanel',
      label: 'Show branch in panel',
      description: 'Branch, dirty/staged/untracked indicators and repo actions under the session.',
      type: 'boolean',
      default: true,
    },
    {
      key: 'showInTitle',
      label: 'Show git status in title',
      description: 'Branch icon and dirty/staged/untracked indicators in the session row.',
      type: 'boolean',
      default: true,
    },
  ],
  onOutput: (ctx, text) => {
    if (!text) return;
    scheduleRefresh(ctx);
  },
  onSessionOpen: (ctx) => {
    void refreshRepo(ctx);
  },
  onClose: (ctx) => {
    const timer = refreshTimers.get(ctx.session.id);
    if (timer !== undefined) window.clearTimeout(timer);
    refreshTimers.delete(ctx.session.id);
    lastRefresh.delete(ctx.session.id);
  },
  sessionFields: [
    {
      id: 'branch',
      label: 'Git branch',
      kind: 'inline',
      zone: 'title',
      // Searchable: the branch and repo name the badge shows.
      search: (ctx) => {
        const settings = ctx.pluginSettings as { showInTitle?: boolean } | undefined;
        if (settings?.showInTitle === false) return null;
        const repo = ctx.session.repo;
        return repo ? [repo.branch ?? '', repo.name] : null;
      },
      value: (ctx) => {
        const settings = ctx.pluginSettings as { showInTitle?: boolean } | undefined;
        if (settings?.showInTitle === false) return null;
        const repo = ctx.session.repo;
        if (!repo) return null;
        return <GitStatusRow ctx={ctx} repo={repo} cwd={ctx.session.cwd} />;
      },
      tip: (ctx) => {
        const settings = ctx.pluginSettings as { showInTitle?: boolean } | undefined;
        if (settings?.showInTitle === false) return null;
        const repo = ctx.session.repo;
        if (!repo) return null;
        return `⎇ ${repo.name} @ ${repo.branch ?? '(detached)'} — ${repoIndicatorLegend(repo).join(', ')}`;
      },
    },
    {
      id: 'repo',
      label: 'Git repository',
      kind: 'block',
      zone: 'selected',
      search: (ctx) => {
        const settings = ctx.pluginSettings as
          | { showInPanel?: boolean; showInHeader?: boolean }
          | undefined;
        if ((settings?.showInPanel ?? settings?.showInHeader) === false) return null;
        const repo = ctx.session.repo;
        return repo ? [repo.branch ?? '', repo.name] : null;
      },
      value: (ctx) => {
        const settings = ctx.pluginSettings as
          | { showInPanel?: boolean; showInHeader?: boolean }
          | undefined;
        // `showInHeader` is the legacy key so existing plugins.yaml values apply.
        if ((settings?.showInPanel ?? settings?.showInHeader) === false) return null;
        const { session } = ctx;
        if (!session.repo) return null;
        return <GitStatus ctx={ctx} repo={session.repo} cwd={session.cwd} />;
      },
    },
  ],
};

/** The row badge's indicator glyphs decoded into `<marker>: <meaning>` form. */
export function repoIndicatorLegend(repo: RepoInfo): string[] {
  const parts: string[] = [];
  if (repo.remoteBranchMissing) parts.push('×: remote branch missing');
  if (repo.ahead > 0) parts.push(`↑${repo.ahead}: ahead of origin`);
  if (repo.behind > 0) parts.push(`↓${repo.behind}: behind origin`);
  if (repo.dirty) parts.push('~: uncommitted changes');
  if (repo.untracked > 0) parts.push(`?${repo.untracked}: untracked files`);
  return parts.length ? parts : ['✓: clean'];
}
