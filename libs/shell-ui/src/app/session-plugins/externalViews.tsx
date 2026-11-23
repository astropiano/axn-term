import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ExternalLink, Globe, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { shellServices } from '../../services';
import { EmptyState } from '../EmptyState';
import { PanelHeader } from '../PanelHeader';
import { echoReply } from '../../shellQuote';
import { fieldClass, ghostButtonClass, secondaryButtonClass } from '../chromeStyles';
import { viewKey } from '../railOrder';
import {
  allowFrameOrigin,
  EXTERNAL_VIEWS_ID,
  isWebUrl,
  removeView,
  runtimeViews,
  type RuntimeView,
} from '../viewHost';
import type { PluginAppCommandContext, RailEntry, SessionViewPlugin } from './plugin';

/** One `views` entry in plugins.yaml. `urlCommand` (desktop) prints the URL on open. */
export interface ExternalViewEntry {
  id: string;
  title: string;
  url?: string;
  urlCommand?: string;
  logo?: string;
}

const newId = () => Math.random().toString(36).slice(2, 10);

// An id for an entry that has no usable one: the same on every read (the
// rail, the view lookup and `axn-views select` each normalise separately).
function derivedId(seed: string, seen: ReadonlySet<string>): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  let id = `v${(hash >>> 0).toString(36)}`;
  while (seen.has(id)) id += 'x';
  return id;
}

/**
 * The `views` list as the plugin uses it: ids made unique and slash-free,
 * entries with neither an http(s) `url` nor a `urlCommand` dropped (their
 * titles reported, for the Settings warning).
 */
export function normalizeViews(section: unknown): { views: ExternalViewEntry[]; dropped: string[] } {
  const raw = (section as { views?: unknown } | undefined)?.views;
  const views: ExternalViewEntry[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : '';
    const url = typeof r.url === 'string' && r.url.trim() ? r.url.trim() : undefined;
    const urlCommand =
      typeof r.urlCommand === 'string' && r.urlCommand.trim() ? r.urlCommand.trim() : undefined;
    if (!(url && isWebUrl(url)) && !urlCommand) {
      dropped.push(title || String(r.url ?? r.id ?? '?'));
      continue;
    }
    let id = typeof r.id === 'string' ? r.id : '';
    if (!id || id.includes('/') || seen.has(id)) {
      id = derivedId(`${views.length}|${title}|${url ?? ''}|${urlCommand ?? ''}`, seen);
    }
    seen.add(id);
    const entry: ExternalViewEntry = { id, title: title || (url ? new URL(url).host : urlCommand!) };
    if (url && isWebUrl(url)) entry.url = url;
    if (urlCommand) entry.urlCommand = urlCommand;
    if (typeof r.logo === 'string' && r.logo) entry.logo = r.logo;
    views.push(entry);
  }
  return { views, dropped };
}

/** The address to frame: `url`, else the trimmed output of `urlCommand`, which must be http(s). */
export async function resolveEntryUrl(
  entry: Pick<ExternalViewEntry, 'url' | 'urlCommand'>,
  exec: ((command: string) => Promise<string>) | undefined,
): Promise<string> {
  if (entry.url) return entry.url;
  if (!entry.urlCommand) throw new Error('no url');
  if (!exec) throw new Error('open a session first: the URL command runs in one');
  const out = (await exec(entry.urlCommand)).trim();
  if (!isWebUrl(out)) throw new Error(`\`${entry.urlCommand}\` did not print an http(s) URL`);
  return out;
}

/** Fails with a readable reason when nothing answers at `url` (stopped server, wrong port). */
export async function checkReachable(
  url: string,
  fetcher: (url: string, init: RequestInit) => Promise<unknown> = fetch,
): Promise<void> {
  try {
    await fetcher(url, { mode: 'no-cors', cache: 'no-store' });
  } catch {
    throw new Error(`${hostOf(url)} is not reachable`);
  }
}

function openExternal(url: string): void {
  (shellServices()?.openExternal ?? ((u: string) => window.open(u, '_blank', 'noopener')))(url);
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
}

function ExternalView({
  entry,
  runtime,
  active,
  exec,
  close,
}: {
  entry: ExternalViewEntry;
  runtime: boolean;
  active: boolean;
  exec: ((command: string) => Promise<string>) | undefined;
  close: () => void;
}) {
  const { t } = useLingui();
  const [url, setUrl] = useState<string | undefined>(entry.url);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const execRef = useRef(exec);
  execRef.current = exec;

  const resolve = useCallback(() => {
    setError(null);
    setUrl(undefined);
    resolveEntryUrl(entry, execRef.current)
      .then(async (resolved) => {
        await allowFrameOrigin(resolved);
        await checkReachable(resolved);
        setUrl(resolved);
      })
      .catch((e: unknown) => setError(String((e as Error)?.message ?? e)));
    // the entry decides what to resolve; exec is read live from the ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.url, entry.urlCommand]);
  useEffect(resolve, [resolve]);

  // A hidden iframe still reports visibilityState 'visible'; pages that
  // throttle while hidden listen for this instead.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ axn: 'view-visibility', visible: active }, '*');
  }, [active, url, nonce]);

  const reload = () => {
    resolve();
    setNonce((n) => n + 1);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <PanelHeader icon={<Globe className="h-4 w-4" />} title={entry.title} meta={hostOf(url)}>
        <div className="flex-1" />
        <button type="button" onClick={reload} aria-label={t`Reload`} data-tip={t`Reload`} className={ghostButtonClass}>
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        {url && (
          <button
            type="button"
            onClick={() => openExternal(url)}
            aria-label={t`Open in browser`}
            data-tip={t`Open in browser`}
            className={ghostButtonClass}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
        {runtime && (
          <button
            type="button"
            onClick={() => removeView(viewKey(EXTERNAL_VIEWS_ID, entry.id))}
            aria-label={t`Close this view`}
            data-tip={t`Close this view`}
            className={ghostButtonClass}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button type="button" onClick={close} aria-label={t`Back to the session`} data-tip={t`Back to the session`} className={ghostButtonClass}>
          <X className="h-3.5 w-3.5" />
        </button>
      </PanelHeader>
      <div className="min-h-0 flex-1">
        {error ? (
          <EmptyState icon={<Globe />} title={<Trans>Could not open {entry.title}</Trans>} description={error}>
            <div className="flex gap-2">
              <button type="button" onClick={reload} className={secondaryButtonClass}>
                <Trans>Retry</Trans>
              </button>
              {url && (
                <button type="button" onClick={() => openExternal(url)} className={secondaryButtonClass}>
                  <Trans>Open in browser</Trans>
                </button>
              )}
            </div>
          </EmptyState>
        ) : url ? (
          <iframe
            key={`${entry.id} ${url} ${nonce}`}
            ref={frame}
            src={url}
            title={entry.title}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : null}
      </div>
    </div>
  );
}

function ExternalViewsSettings({
  settings,
  update,
}: {
  settings: Record<string, unknown>;
  update: (patch: Record<string, unknown>) => void;
}) {
  const { t } = useLingui();
  const raw = Array.isArray(settings.views) ? (settings.views as Partial<ExternalViewEntry>[]) : [];
  const { dropped } = normalizeViews(settings);
  const write = (next: Partial<ExternalViewEntry>[]) => update({ views: next });
  const set = (i: number, patch: Partial<ExternalViewEntry>) =>
    write(raw.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-[var(--text-secondary)]">
        <Trans>
          Each view gets its own rail item. Give a URL, or a command that prints one when the view
          opens (for addresses carrying a token — it is never saved).
        </Trans>
      </p>
      {raw.map((v, i) => (
        <div key={v.id ?? i} className="flex flex-col gap-1.5 rounded-[var(--radius-md)] bg-[var(--raised)] p-2">
          <div className="flex gap-1.5">
            <input className={`${fieldClass} flex-1`} placeholder={t`Title`} value={v.title ?? ''} onChange={(e) => set(i, { title: e.target.value })} />
            <input className={`${fieldClass} w-28`} placeholder={t`Icon`} value={v.logo ?? ''} onChange={(e) => set(i, { logo: e.target.value || undefined })} />
            <button type="button" aria-label={t`Remove`} data-tip={t`Remove`} className={ghostButtonClass} onClick={() => write(raw.filter((_, j) => j !== i))}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <input className={fieldClass} placeholder="https://…" value={v.url ?? ''} onChange={(e) => set(i, { url: e.target.value || undefined })} />
          <input className={`${fieldClass} font-mono`} placeholder={t`or a command printing the URL, e.g. launchpad url mr`} value={v.urlCommand ?? ''} onChange={(e) => set(i, { urlCommand: e.target.value || undefined })} />
        </div>
      ))}
      {dropped.length > 0 && (
        <p className="text-[11px] text-[var(--orange)]">
          <Trans>Not shown (needs an http(s) URL or a command): {dropped.join(', ')}</Trans>
        </p>
      )}
      <button type="button" className={`${secondaryButtonClass} self-start`} onClick={() => write([...raw, { id: newId(), title: '' }])}>
        <Plus className="mr-1 h-3.5 w-3.5" />
        <Trans>Add view</Trans>
      </button>
    </div>
  );
}

const USAGE = 'usage: axn-views open <url> [title] | select <key|title> | close <key> | current';
const echo = (text: string) => echoReply(text);

/** `axn-views …` — app level, so `axn-term command` can drive it from any process. */
async function axnViews(ctx: PluginAppCommandContext, arg: string | undefined): Promise<string> {
  const [sub = '', ...rest] = (arg ?? '').split(/\s+/).filter(Boolean);
  switch (sub) {
    case 'open': {
      const [url, ...title] = rest;
      if (!url) throw new Error(USAGE);
      return echo(ctx.openView({ url, title: title.join(' ') || undefined }));
    }
    case 'select': {
      const wanted = rest.join(' ');
      const entries = externalViewsPlugin.railEntries!({ pluginSettings: ctx.pluginSettings });
      const byTitle = entries.find((e) => e.title === wanted);
      const key = byTitle ? viewKey(EXTERNAL_VIEWS_ID, byTitle.id) : wanted;
      if (!wanted || !ctx.selectView(key)) throw new Error(`no such view: ${wanted}`);
      return echo(key);
    }
    case 'close': {
      if (!ctx.removeView(rest.join(' '))) throw new Error(`not a runtime view: ${rest.join(' ')}`);
      return echo('closed');
    }
    case 'current':
      return echo(JSON.stringify(ctx.activeView()));
    default:
      throw new Error(USAGE);
  }
}

const runtimeEntry = (view: RuntimeView): ExternalViewEntry => ({
  id: view.id,
  title: view.title,
  url: view.url,
  logo: view.logo,
});

/**
 * Any http(s) page as a rail view: one rail item per `views` entry in
 * plugins.yaml, plus the views opened at runtime (`openView`, `axn-views
 * open`). Views stay mounted while hidden so pages keep their state.
 */
export const externalViewsPlugin: SessionViewPlugin = {
  id: EXTERNAL_VIEWS_ID,
  title: 'External views',
  logo: 'Globe',
  defaultEnabled: false,
  keepViewMounted: true,
  railEntries: ({ pluginSettings }): RailEntry[] => [
    ...normalizeViews(pluginSettings).views.map((v) => ({ id: v.id, title: v.title, logo: v.logo })),
    ...runtimeViews().map((v) => ({ id: v.id, title: v.title, logo: v.logo, runtime: true })),
  ],
  renderView: ({ pluginSettings, entryId, active, close, sessions, sessionApi }) => {
    const runtime = runtimeViews().find((v) => v.id === entryId);
    const entry = runtime
      ? runtimeEntry(runtime)
      : normalizeViews(pluginSettings).views.find((v) => v.id === entryId);
    if (!entry) return null;
    const api = sessions[0] ? sessionApi(sessions[0].id) : undefined;
    return (
      <ExternalView
        entry={entry}
        runtime={runtime !== undefined}
        active={active}
        exec={api ? (command) => api.exec(command) : undefined}
        close={close}
      />
    );
  },
  commands: [
    {
      name: 'axn-views',
      takesArg: true,
      completeArg: (_ctx, prefix) => ['open', 'select', 'close', 'current'].filter((s) => s.startsWith(prefix)),
      appRun: (ctx, arg) => axnViews(ctx, arg),
    },
  ],
  renderSettings: ({ settings, update }) => <ExternalViewsSettings settings={settings} update={update} />,
};
