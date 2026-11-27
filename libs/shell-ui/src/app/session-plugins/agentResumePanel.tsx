import { t } from '@lingui/core/macro';
import { i18n } from '../../i18n';
import { Play } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ContextMenu, menuDividerClass, menuItemClass } from '../../ContextMenu';
import { PluginIcon } from '../iconGlyph';
import type { SessionViewContext, PluginApi } from './plugin';
import {
  agentHistory,
  agentLastLabel,
  resumableAgentLast,
  resumeAgentSession,
  type AgentLastSession,
} from './agentResume';

/** `3h ago`-style age of a record; empty for a record without a stamp. */
export function ageLabel(at: number, now = Date.now()): string {
  if (!at) return '';
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return 'now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The folder a record ran in, shortened to its last segment. */
function folderOf(cwd: string | undefined): string {
  return cwd?.replace(/\/+$/, '').split('/').pop() || cwd || '';
}

/**
 * The resume button with a right-click list of the other remembered
 * conversations (`history`, newest first) — each resumes with its own stored
 * line, `cd` into its folder included.
 */
function ResumeButton({
  ctx,
  agent,
  plugin,
  last,
}: {
  ctx: SessionViewContext & PluginApi;
  agent: string;
  plugin?: { logo?: string; iconKey?: string };
  last: AgentLastSession;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const name = agentLastLabel(last);
  // quotes stay out of the message: ICU treats a single quote as an escape
  const quoted = `'${name}'`;
  const entries = agentHistory(ctx);
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => resumeAgentSession(ctx, agent, last, 'panel')}
        onContextMenu={(e) => {
          if (entries.length < 2) return;
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        data-tip={`${agent}: ${last.command}`}
        className="flex max-w-full items-center gap-1.5 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--accent)] hover:bg-[var(--bg)]"
      >
        {/* the agent's mark — the plugin's logo, or the user's override from the icon bag */}
        {plugin?.logo !== undefined ? (
          <PluginIcon plugin={{ id: agent, ...plugin }} className="h-3 w-3 shrink-0" />
        ) : (
          <Play className="h-2.5 w-2.5 shrink-0" />
        )}
        <span className="truncate">
          {name ? i18n._(t`Resume ${quoted}`) : i18n._(t`Resume`)}
        </span>
      </button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} widthClass="w-72">
          <div className="px-2 py-1 text-[11px] text-[var(--text-secondary)]">
            {i18n._(t`Resume an earlier ${agent} session`)}
          </div>
          <div className={menuDividerClass} />
          {entries.map((entry) => (
            <button
              key={`${entry.name ?? entry.command}@${entry.at}`}
              type="button"
              className={menuItemClass}
              data-tip={entry.command}
              onClick={() => {
                setMenu(null);
                resumeAgentSession(ctx, agent, entry, 'panel-history');
              }}
            >
              <span className="min-w-0 flex-1 truncate">{agentLastLabel(entry) ?? entry.command}</span>
              <span className="shrink-0 text-[10px] text-[var(--text-secondary)]">
                {[folderOf(entry.cwd), ageLabel(entry.at)].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
        </ContextMenu>
      )}
    </div>
  );
}

/**
 * The plugin's session-panel contribution: a `Resume <agent> session
 * '<name>'` button inside the selected session's card (the `render` hook).
 * Shown under the same gate as the session-menu row — idle session, this
 * agent owns the globally newest last record — and additionally only while
 * the plugin's `resume-button` setting is on (default). The context-menu row
 * stays available regardless. Right-click lists the earlier conversations.
 */
export function agentResumePanel(
  ctx: SessionViewContext & PluginApi,
  agent: string,
  plugin?: { logo?: string; iconKey?: string },
): ReactNode {
  const settings = ctx.pluginSettings as { resumeButton?: boolean } | undefined;
  if (settings?.resumeButton === false) return null;
  const last = resumableAgentLast(ctx, agent);
  if (!last) return null;
  return <ResumeButton ctx={ctx} agent={agent} plugin={plugin} last={last} />;
}
