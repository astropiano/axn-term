import { useEffect, useReducer, type ComponentType } from 'react';
import { mrRole, parseMrUrl, type MrPeople, type MrRole } from './forge';
import type { ShellSession, Workspace } from '../../types';
import type { PluginApi, SessionViewContext } from './plugin';
import type { RepoCheckout } from '../repoDirectory';

/**
 * Cross-plugin contribution point for merge-request actions.
 *
 * `glab-mr` renders registered providers on each MR row — both in the full
 * merge-requests view and in the per-session MR list — without knowing who
 * registered them. Providers are React components (so they may use hooks,
 * e.g. `usePluginSettings`) receiving the MR and a view env. The env hands
 * out session-bound APIs on demand — a provider can `exec`/`openSession`
 * through any session, typically the one whose repo hosts the MR.
 *
 * Registration is module-level: a plugin calls `registerMrActions` at import
 * time. Duplicate ids replace earlier registrations (keeps hot reload and
 * re-entrant tests deterministic).
 */
export interface MrRef {
  iid: number;
  /** e.g. `!75` */
  reference: string;
  title: string;
  url: string;
  /** GitLab fullPath e.g. `group/proj` — absent on session-level summaries. */
  project?: string;
  sourceBranch?: string;
  targetBranch?: string;
}

/** View-side capabilities handed to MR action providers. */
export interface MrRowEnv {
  sessions: ShellSession[];
  /**
   * The window's workspaces in panel order — lets a provider target the
   * workspace already hosting the MR's repo, or offer a workspace picker.
   * Empty where the host cannot enumerate workspaces.
   */
  workspaces?: Workspace[];
  /**
   * The session the click came from — the panel's selection when an overview
   * opened, the session itself for a session-level MR row. A review prefers
   * its clone and its workspace over the first match, so with several clones
   * of one repo it lands where the user is working.
   */
  selectedSessionId?: string;
  /** Session-bound api for a known session id, when the view can provide it. */
  apiFor: (sessionId: string) => (SessionViewContext & PluginApi) | undefined;
  selectSession: (sessionId: string) => void;
  /**
   * Local checkouts the host plugin knows (repo-dir providers + its own
   * `repo-roots`), so a provider can find the MR's repo without an open
   * session in it. Absent where the host offers no discovery.
   */
  checkouts?: () => Promise<RepoCheckout[]>;
}

export interface MrActionProps {
  mr: MrRef;
  env: MrRowEnv;
}

export type MrActionsProvider = ComponentType<MrActionProps>;

const providers = new Map<string, MrActionsProvider>();

export function registerMrActions(id: string, provider: MrActionsProvider): void {
  providers.set(id, provider);
}

export function mrActionProviders(): MrActionsProvider[] {
  return [...providers.values()];
}

// ---------------------------------------------------------------------------
// MR details — the forge plugins' per-MR cache, read by other plugins
// ---------------------------------------------------------------------------

/** Who is on an MR plus the viewer's role, as a forge plugin knows it. */
export interface MrDetails extends MrPeople {
  /** The signed-in user the role was computed for. */
  me: string;
  role?: MrRole;
}

/**
 * Provided by a forge plugin (glab-mr for GitLab URLs, gh-pr for GitHub):
 * the per-MR people cache its overview poll and per-session fetches fill,
 * plus a single-MR fetch for a cache miss. Lets dev-workflow ask "what is my
 * role on this MR" without importing either plugin.
 */
export interface MrResolver {
  /** True for URLs this resolver serves. */
  handles: (url: string) => boolean;
  /** Synchronous cache read — undefined on a miss. */
  peek: (url: string) => MrDetails | undefined;
  /** Cache hit or one fetch; undefined when the MR cannot be resolved. */
  resolve: (url: string) => Promise<MrDetails | undefined>;
  /** Notified whenever the cache changes. Returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

const resolvers = new Map<string, MrResolver>();

export function registerMrResolver(id: string, resolver: MrResolver): void {
  resolvers.set(id, resolver);
}

/** Test seam. */
export function resetMrResolvers(): void {
  resolvers.clear();
}

function resolverFor(url: string): MrResolver | undefined {
  return [...resolvers.values()].find((r) => r.handles(url));
}

export function peekMrDetails(url: string): MrDetails | undefined {
  return resolverFor(url)?.peek(url);
}

export async function resolveMrDetails(url: string): Promise<MrDetails | undefined> {
  const r = resolverFor(url);
  return r ? r.resolve(url).catch(() => undefined) : undefined;
}

/**
 * The MR's details for rendering: the cached entry, fetched once on a miss,
 * re-rendered whenever the owning plugin's cache changes.
 */
export function useMrDetails(url: string | undefined): MrDetails | undefined {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const resolver = url ? resolverFor(url) : undefined;
  const cached = url && resolver ? resolver.peek(url) : undefined;
  useEffect(() => {
    if (!url || !resolver) return;
    const off = resolver.subscribe(bump);
    if (!resolver.peek(url)) void resolver.resolve(url).catch(() => undefined);
    return off;
  }, [url, resolver]);
  return cached;
}

/**
 * A small per-MR people cache with miss fetching, shared by both forge
 * plugins: `fill` from data already fetched, `fetchOne`/`fetchMe` on a miss.
 * Misses are fetched once at a time per MR and failures are remembered for
 * `retryMs` so a broken MR cannot turn every render into a CLI call.
 */
export function createMrPeopleCache(opts: {
  forge: 'gitlab' | 'github';
  /** Current signed-in user when an overview already knows it. */
  knownMe: (host: string) => string | undefined;
  fetchOne: (u: { host: string; project: string; iid: number; url: string }) => Promise<MrPeople | undefined>;
  fetchMe: (host: string) => Promise<string | undefined>;
  ttlMs?: number;
  retryMs?: number;
}): MrResolver & {
  fill: (url: string, people: MrPeople) => void;
  fillMe: (host: string, me: string) => void;
  clear: () => void;
} {
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const retry = opts.retryMs ?? 60_000;
  const people = new Map<string, { people: MrPeople; at: number }>();
  const failedAt = new Map<string, number>();
  const inflight = new Map<string, Promise<MrDetails | undefined>>();
  const meByHost = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const keyOf = (url: string) => {
    const u = parseMrUrl(url);
    return u && u.forge === opts.forge ? { u, key: `${u.host}/${u.project.toLowerCase()}#${u.iid}` } : undefined;
  };
  const meFor = (host: string) => opts.knownMe(host) || meByHost.get(host);
  const details = (p: MrPeople, host: string): MrDetails => {
    const me = meFor(host) ?? '';
    return { ...p, me, role: mrRole(p, me) };
  };
  const peek = (url: string) => {
    const k = keyOf(url);
    const hit = k && people.get(k.key);
    return hit && k ? details(hit.people, k.u.host) : undefined;
  };
  return {
    handles: (url) => keyOf(url) !== undefined,
    peek,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    fill: (url, p) => {
      const k = keyOf(url);
      if (!k) return;
      people.set(k.key, { people: p, at: Date.now() });
      failedAt.delete(k.key);
      notify();
    },
    fillMe: (host, me) => {
      if (!me) return;
      meByHost.set(host.toLowerCase(), me);
      notify();
    },
    clear: () => {
      people.clear();
      failedAt.clear();
      inflight.clear();
      meByHost.clear();
    },
    resolve: (url) => {
      const k = keyOf(url);
      if (!k) return Promise.resolve(undefined);
      const hit = people.get(k.key);
      if (hit && Date.now() - hit.at < ttl && meFor(k.u.host)) {
        return Promise.resolve(details(hit.people, k.u.host));
      }
      if (Date.now() - (failedAt.get(k.key) ?? 0) < retry) return Promise.resolve(peek(url));
      const running = inflight.get(k.key);
      if (running) return running;
      const job = (async () => {
        try {
          if (!meFor(k.u.host)) {
            const me = await opts.fetchMe(k.u.host).catch(() => undefined);
            if (me) meByHost.set(k.u.host, me);
          }
          const fresh = hit && Date.now() - hit.at < ttl ? hit.people : await opts.fetchOne({ ...k.u, url });
          if (!fresh) {
            failedAt.set(k.key, Date.now());
            return peek(url);
          }
          people.set(k.key, { people: fresh, at: Date.now() });
          return details(fresh, k.u.host);
        } catch {
          failedAt.set(k.key, Date.now());
          return peek(url);
        } finally {
          inflight.delete(k.key);
          notify();
        }
      })();
      inflight.set(k.key, job);
      return job;
    },
  };
}
