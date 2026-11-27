import { t } from '@lingui/core/macro';
import { i18n } from '../../i18n';
import { axnLog } from '../log';
import type { SessionViewContext, PluginApi, RepoMenuItem } from './plugin';

/**
 * "Resume last" — the shared agent-session capability used by the built-in
 * agent plugins (devin, claude, vibe, codex, antigravity).
 *
 * Each agent plugin persists its last conversation into the SESSION's
 * pluginState (`sessions[].pluginState.<agent>.last`, `at`-stamped) —
 * named from the agent's own exit hint where it prints one (devin/vibe
 * session names, claude conversation ids), else the agent's "continue
 * latest" resume line (`devin -c`, `claude -c`, `codex resume --last`,
 * `agy -c`). The in-memory `agentLasts` map tracks every agent's newest
 * record PER SESSION so the context menu can show at most one resume row:
 * the session's own newest — and only while the session still sits in the
 * conversation's directory. The capture itself stays plugin-owned — each
 * agent announces its session differently. Records written before this
 * scoping lived in app-level `pluginData.<agent>.last`; they are never
 * read — a legacy record can leak into other sessions in the same folder —
 * and the key is retired on the next capture.
 *
 * `agentResumeMenuItem` is the plugin's `sessionMenuItems` contribution: a
 * `Resume <agent> session '<name>'` row offered on any session while no
 * process runs in it — resuming the last conversation into that shell —
 * and only for the agent that owns the global last.
 */
export interface AgentLastSession {
  /** The agent's own session name/id — only when its exit hint provided one. */
  name?: string;
  /**
   * Display label — how the agent presented the conversation while it ran
   * (the terminal title it set, e.g. via `/rename`, with its own
   * `'<cli>: '` prefix stripped), else the session's custom name. `name`
   * stays the machine identity (resume id/session slug); `title` is what
   * the menu row and panel button show.
   */
  title?: string;
  /** Directory the conversation ran in — agents scope sessions per directory. */
  cwd?: string;
  /** Shell line that resumes it (`cd … &&` folded in where the cwd is known). */
  command: string;
  /** Record time — decides which agent owns the global last. */
  at: number;
}

// CLI aliases an agent may prefix its terminal title with (`'claude: Fix
// auth'` → 'Fix auth'). The plugin id itself is always an alias.
const AGENT_TITLE_ALIASES: Record<string, string[]> = {
  antigravity: ['agy'],
};

/** Strip the agent's own `<cli>:`/`<cli> -` prefix from a title it set. */
export function stripAgentTitlePrefix(title: string, agent: string): string {
  const aliases = [agent, ...(AGENT_TITLE_ALIASES[agent] ?? [])];
  const re = new RegExp(`^(?:${aliases.join('|')})\\s*[:\\-\\u2013\\u2014|]\\s*`, 'i');
  return title.replace(re, '').trim();
}

// What an agent shows before the conversation has a name of its own.
const GENERIC_AGENT_TITLES = new Set([
  'claude',
  'claude code',
  'devin',
  'codex',
  'opencode',
  'agy',
  'antigravity',
  'gemini',
  'vibe',
  'mistral vibe',
]);

/**
 * A title an agent set, reduced to the conversation's name: the status glyph
 * agents animate in front of it (`✳`/`◐`/braille spinners) and their own
 * `<cli>:` prefix are dropped; the generic default ("Claude Code") and an
 * empty title — what an agent sets when it exits — are no name at all.
 */
export function cleanAgentTitle(raw: string | undefined, agent: string): string | undefined {
  if (!raw) return undefined;
  const title = stripAgentTitlePrefix(raw.replace(/^[\p{So}\p{Cf}\s]+/u, '').trim(), agent);
  if (!title || GENERIC_AGENT_TITLES.has(title.toLowerCase())) return undefined;
  // The shell's own title (`user@host: ~/dir`, a bare path) — what arrives in
  // the moments after the agent exits, while the foreground poll still says
  // the agent runs. Never a conversation name.
  if (/^[\w.+-]+@[\w.-]+:/.test(title) || /^[/~]/.test(title)) return undefined;
  return title;
}

/** The last non-empty OSC 0/2 window title in a chunk of terminal output. */
export function lastOscTitle(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let last: string | undefined;
  for (const m of text.matchAll(/\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
    if (m[1]) last = m[1];
  }
  return last;
}

/**
 * Remember the conversation's name WHILE the agent runs. By exit the agent
 * has cleared its terminal title (Claude Code sets an empty one) and the shell
 * has put its own back, so the name has to be caught on the way: call this
 * from the agent plugin's `onOutput` while its process is foreground. The
 * title comes straight from the chunk's OSC sequence when it carries one,
 * else from the session's `autoName`. Only a changed name touches state.
 */
export function noteAgentTitle(
  ctx: SessionViewContext & PluginApi,
  agent: string,
  text?: string,
): void {
  const session = ctx.getSession?.() ?? ctx.session;
  const title =
    cleanAgentTitle(lastOscTitle(text), agent) ?? cleanAgentTitle(session?.autoName, agent);
  if (!title) return;
  const seen = (ctx.pluginState as { seenTitle?: unknown } | undefined)?.seenTitle;
  if (seen === title) return;
  ctx.updatePluginState({ seenTitle: title });
}

/**
 * The label to store for a conversation being recorded now: an explicit one,
 * the name seen while the agent ran, the one an earlier record of the same
 * conversation had, then — only while the agent is still foreground, so
 * `autoName` is still its title and not the shell's — the terminal title, and
 * finally the user's custom session name.
 */
function recordTitle(
  ctx: SessionViewContext & PluginApi,
  agent: string,
  previous: AgentLastSession | undefined,
): string | undefined {
  const session = ctx.getSession?.() ?? ctx.session;
  const seen = (ctx.pluginState as { seenTitle?: unknown } | undefined)?.seenTitle;
  return (
    (typeof seen === 'string' && seen ? seen : undefined) ??
    previous?.title ??
    (session?.process || session?.agentInput ? cleanAgentTitle(session?.autoName, agent) : undefined) ??
    cleanAgentTitle(session?.customName, agent)
  );
}

/** How many conversations a plugin keeps for the right-click list. */
export const AGENT_HISTORY_MAX = 5;

/** Identity of a conversation: its resume id, else where and how it resumes. */
function historyKey(e: Pick<AgentLastSession, 'name' | 'cwd' | 'command'>): string {
  return e.name ? `id:${e.name}` : `cmd:${e.cwd ?? ''}\u0000${e.command}`;
}

/** Newest-first history with `entry` upserted (the same conversation moves to the front). */
export function upsertAgentHistory(
  history: AgentLastSession[],
  entry: AgentLastSession,
  max = AGENT_HISTORY_MAX,
): AgentLastSession[] {
  const key = historyKey(entry);
  return [entry, ...history.filter((e) => historyKey(e) !== key)].slice(0, max);
}

function parseRecord(l: unknown): AgentLastSession | undefined {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return undefined;
  const r = l as Partial<AgentLastSession>;
  if (typeof r.command !== 'string' || !r.command) return undefined;
  return {
    name: typeof r.name === 'string' && r.name ? r.name : undefined,
    title: typeof r.title === 'string' && r.title ? r.title : undefined,
    cwd: typeof r.cwd === 'string' && r.cwd ? r.cwd : undefined,
    command: r.command,
    at: typeof r.at === 'number' ? r.at : 0,
  };
}

/**
 * The plugin's remembered conversations, newest first: its `history` list
 * plus `last` (records written before the list existed are only in `last`).
 */
export function agentHistory(ctx: SessionViewContext & PluginApi): AgentLastSession[] {
  const state = ctx.pluginState as { history?: unknown } | undefined;
  const listed = Array.isArray(state?.history)
    ? state.history.flatMap((r) => parseRecord(r) ?? [])
    : [];
  const last = lastAgentSession(ctx);
  const merged = last ? upsertAgentHistory(listed, last, Infinity) : listed;
  return merged.sort((a, b) => b.at - a.at).slice(0, AGENT_HISTORY_MAX);
}

// Every agent's newest last-session record FOR A SESSION — keyed
// `sessionId\0agent`: a session offers at most one resume row, and only
// ever a conversation that ran in that session. In-memory per window (each
// webview has its own React tree), seeded from the plugins' persisted
// records on read.
const agentLasts = new Map<string, AgentLastSession>();

const lastKey = (sessionId: string, agent: string) => `${sessionId}\u0000${agent}`;

/** Register an agent's record — a persisted one on read, a fresh one on write. */
function registerAgentLast(sessionId: string, agent: string, last: AgentLastSession): void {
  const key = lastKey(sessionId, agent);
  const current = agentLasts.get(key);
  if (!current || last.at >= current.at) agentLasts.set(key, last);
}

function unregisterAgentLast(sessionId: string, agent: string): void {
  agentLasts.delete(lastKey(sessionId, agent));
}

/** The newest last-session record across agents for this session. */
function latestAgentLast(
  sessionId: string,
): { agent: string; last: AgentLastSession } | undefined {
  let best: { agent: string; last: AgentLastSession } | undefined;
  for (const [key, last] of agentLasts) {
    if (!key.startsWith(`${sessionId}\u0000`)) continue;
    if (!best || last.at > best.last.at) best = { agent: key.slice(sessionId.length + 1), last };
  }
  return best;
}

/** Path comparison for the per-folder gate: trailing slashes don't differ. */
function normalizeCwd(cwd?: string): string | undefined {
  const c = cwd?.replace(/\/+$/, '');
  return c || undefined;
}

/** Tests — reset the in-memory last-session registry. */
export function clearAgentLasts(): void {
  agentLasts.clear();
}

/** The plugin's own recorded last session — `undefined` when none was captured. */
export function lastAgentSession(
  ctx: SessionViewContext & PluginApi,
): AgentLastSession | undefined {
  return parseRecord((ctx.pluginState as { last?: unknown } | undefined)?.last);
}

/**
 * Store the just-exited conversation as this agent's last session — now
 * globally the newest, since it was just recorded. Idempotent — an
 * unchanged record (same name/cwd/command) keeps its stamp.
 */
export function rememberLastAgentSession(
  ctx: SessionViewContext & PluginApi,
  agent: string,
  last: Omit<AgentLastSession, 'at'>,
): void {
  const current = lastAgentSession(ctx);
  const history = agentHistory(ctx);
  const previous = history.find((e) => historyKey(e) === historyKey(last));
  const title = last.title ?? recordTitle(ctx, agent, previous);
  const unchanged =
    current !== undefined &&
    current.name === last.name &&
    current.title === title &&
    current.cwd === last.cwd &&
    current.command === last.command;
  // Decided by content, not by comparing stamps: a changed record written
  // in the same millisecond as the previous one has an equal `at`.
  const stamped: AgentLastSession = { ...last, title, at: unchanged ? current.at : Date.now() };
  registerAgentLast(ctx.getSession().id, agent, stamped);
  if (unchanged) return;
  // The name seen during the run belongs to this record now — the next run
  // starts without one.
  ctx.updatePluginState({
    last: stamped,
    history: upsertAgentHistory(history, stamped),
    seenTitle: undefined,
  });
  // Retire the legacy app-level record so it stops seeding other sessions.
  ctx.updateAppState({ last: undefined });
}

/**
 * Drop the last-session record — e.g. when the agent reports the session is
 * gone. With `name`, only a record carrying that name is cleared so a newer
 * capture is never erased.
 */
export function forgetLastAgentSession(
  ctx: SessionViewContext & PluginApi,
  agent: string,
  name?: string,
): void {
  const current = lastAgentSession(ctx);
  if (!current || (name && current.name !== name)) return;
  unregisterAgentLast(ctx.getSession().id, agent);
  const key = historyKey(current);
  // The conversation is gone — it leaves the right-click list too; the
  // newest of the others becomes the last again.
  const rest = agentHistory(ctx).filter((e) => historyKey(e) !== key);
  const [next] = rest;
  if (next) registerAgentLast(ctx.getSession().id, agent, next);
  ctx.updatePluginState({ last: next, history: rest });
  ctx.updateAppState({ last: undefined });
}

/**
 * The resumable record this agent shows in the panel/menu right now — its
 * own persisted `last` (seeded into the registry on read) only while the
 * session is idle and this agent owns the globally newest record, else
 * `undefined`. Shared gate for `agentResumeMenuItem` and `agentResumePanel`.
 */
export function resumableAgentLast(
  ctx: SessionViewContext & PluginApi,
  agent: string,
): AgentLastSession | undefined {
  // Seed this agent's persisted record into the registry before comparing —
  // after a restart the map is empty until each agent touched ctx once.
  const session = ctx.getSession();
  const last = lastAgentSession(ctx);
  if (last) registerAgentLast(session.id, agent, last);
  // session.process is the foreground pgrp leader (absent at the shell
  // prompt); agentInput additionally marks an agent seen only by title so
  // far — either one means the session is not idle.
  if (session.process || session.agentInput || !last) return undefined;
  // Per session AND per folder: a resume row belongs to the session the
  // conversation ran in, and only while that session sits in the same
  // directory — a fresh session elsewhere never sees it.
  if (normalizeCwd(last.cwd) !== normalizeCwd(session.cwd)) return undefined;
  if (latestAgentLast(session.id)?.agent !== agent) return undefined;
  return last;
}

/** The label a record is shown as — the display title wins over the raw name/id. */
export function agentLastLabel(last: AgentLastSession): string | undefined {
  return last.title ?? last.name;
}

/**
 * Resume a record into the session's shell. Dispatches the stored line like
 * a typed command, so plugin bookkeeping (`onCommand` remembered-name
 * invalidation, cwd tracking) sees it — and writes the resolved line to the
 * PTY. Where command dispatch is unavailable the stored line is written
 * directly. Shared by the session-menu row and the panel button.
 */
export function resumeAgentSession(
  ctx: SessionViewContext & PluginApi,
  agent: string,
  last: AgentLastSession,
  via: string,
): void {
  void (async () => {
    let line = last.command;
    try {
      const resolved = await ctx.runCommand?.(line);
      if (resolved === false) return;
      if (typeof resolved === 'string') line = resolved;
    } catch {
      /* dispatch failed — write the stored line directly */
    }
    try {
      await ctx.writeToSession(`${line}\r`);
      axnLog('info', `${agent}-resume`, `resumed last session via ${via}: ${line}`);
    } catch (e) {
      axnLog('warn', `${agent}-resume`, `resume write failed: ${String(e)}`);
    }
  })();
}

/**
 * The plugin's session context-menu capability: `Resume <agent> session
 * '<name>'` (or `Resume <agent> session` for agents whose resume targets the
 * latest conversation). Offered only while no process runs in the session —
 * an idle shell — and only for the agent owning the globally newest last
 * record: a session's menu shows at most one resume row.
 */
export function agentResumeMenuItem(
  ctx: SessionViewContext & PluginApi,
  agent: string,
): RepoMenuItem[] {
  const last = resumableAgentLast(ctx, agent);
  if (!last) return [];
  const name = agentLastLabel(last);
  return [
    {
      label: i18n._(t`Resume ${agent} session${name ? ` '${name}'` : ''}`),
      onClick: () => resumeAgentSession(ctx, agent, last, 'menu'),
    },
  ];
}
