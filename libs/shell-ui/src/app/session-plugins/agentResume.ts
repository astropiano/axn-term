import { t } from '@lingui/core/macro';
import { i18n } from '../../i18n';
import { axnLog } from '../log';
import type { SessionViewContext, PluginApi, RepoMenuItem } from './plugin';

/**
 * "Resume last" — the shared agent-session capability used by the built-in
 * agent plugins (devin, claude, vibe, codex, antigravity).
 *
 * There is exactly ONE last session across all agents: whichever agent
 * conversation exited most recently. Each agent plugin persists its own
 * record into its app-level pluginData (`pluginData.<settingsKey>.last`,
 * `at`-stamped) — named from the agent's own exit hint where it prints one
 * (devin/vibe session names, claude conversation ids), else the agent's
 * "continue latest" resume line (`devin -c`, `claude -c`,
 * `codex resume --last`, `agy -c`). The in-memory `agentLasts` map
 * tracks every agent's newest record so the session context menu can show
 * the row for the globally latest one only. The capture itself stays
 * plugin-owned — each agent announces its session differently.
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

/**
 * The conversation's display label at record time: the process-reported
 * terminal title (`autoName` — the agent's `/rename`/topic line) wins, the
 * user's custom session name is the fallback. The generic default name is
 * not a label worth persisting.
 */
function sessionDisplayTitle(
  ctx: SessionViewContext & PluginApi,
  agent: string,
): string | undefined {
  const session = ctx.getSession?.() ?? ctx.session;
  const raw = session?.autoName ?? session?.customName;
  if (!raw) return undefined;
  const title = stripAgentTitlePrefix(raw, agent);
  return title || undefined;
}

// Every agent's newest last-session record — the winner by `at` is the one
// resumable from the menu. In-memory per window (each webview has its own
// React tree), seeded from the plugins' persisted records on read.
const agentLasts = new Map<string, AgentLastSession>();

/** Register an agent's record — a persisted one on read, a fresh one on write. */
function registerAgentLast(agent: string, last: AgentLastSession): void {
  const current = agentLasts.get(agent);
  if (!current || last.at >= current.at) agentLasts.set(agent, last);
}

function unregisterAgentLast(agent: string): void {
  agentLasts.delete(agent);
}

/** The globally newest last-session record across agents. */
function latestAgentLast(): { agent: string; last: AgentLastSession } | undefined {
  let best: { agent: string; last: AgentLastSession } | undefined;
  for (const [agent, last] of agentLasts) {
    if (!best || last.at > best.last.at) best = { agent, last };
  }
  return best;
}

/** Tests — reset the in-memory last-session registry. */
export function clearAgentLasts(): void {
  agentLasts.clear();
}

/** The plugin's own recorded last session — `undefined` when none was captured. */
export function lastAgentSession(
  ctx: SessionViewContext & PluginApi,
): AgentLastSession | undefined {
  const last = (ctx.appState as { last?: unknown } | undefined)?.last;
  if (!last || typeof last !== 'object' || Array.isArray(last)) return undefined;
  const l = last as AgentLastSession;
  if (typeof l.command !== 'string' || !l.command) return undefined;
  return {
    name: typeof l.name === 'string' && l.name ? l.name : undefined,
    title: typeof l.title === 'string' && l.title ? l.title : undefined,
    cwd: typeof l.cwd === 'string' && l.cwd ? l.cwd : undefined,
    command: l.command,
    at: typeof l.at === 'number' ? l.at : 0,
  };
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
  const title = last.title ?? sessionDisplayTitle(ctx, agent);
  const stamped: AgentLastSession = {
    ...last,
    title,
    at:
      current?.name === last.name &&
      current?.title === title &&
      current?.cwd === last.cwd &&
      current?.command === last.command
        ? current.at
        : Date.now(),
  };
  registerAgentLast(agent, stamped);
  if (stamped.at === current?.at) return;
  ctx.updateAppState({ last: stamped });
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
  unregisterAgentLast(agent);
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
  const last = lastAgentSession(ctx);
  if (last) registerAgentLast(agent, last);
  const session = ctx.getSession();
  // session.process is the foreground pgrp leader (absent at the shell
  // prompt); agentInput additionally marks an agent seen only by title so
  // far — either one means the session is not idle.
  if (session.process || session.agentInput || !last) return undefined;
  if (latestAgentLast()?.agent !== agent) return undefined;
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
