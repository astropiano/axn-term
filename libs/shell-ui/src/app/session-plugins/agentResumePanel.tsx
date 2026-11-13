import { t } from '@lingui/core/macro';
import { i18n } from '../../i18n';
import { Play } from 'lucide-react';
import type { ReactNode } from 'react';
import type { SessionViewContext, PluginApi } from './plugin';
import { agentLastLabel, resumableAgentLast, resumeAgentSession } from './agentResume';

/**
 * The plugin's session-panel contribution: a `Resume <agent> session
 * '<name>'` button inside the selected session's card (the `render` hook).
 * Shown under the same gate as the session-menu row — idle session, this
 * agent owns the globally newest last record — and additionally only while
 * the plugin's `resume-button` setting is on (default). The context-menu row
 * stays available regardless.
 *
 * Plain function (not a component): the ctx is rebuilt on every panel
 * render, so no local state is needed.
 */
export function agentResumePanel(
  ctx: SessionViewContext & PluginApi,
  agent: string,
): ReactNode {
  const settings = ctx.pluginSettings as { resumeButton?: boolean } | undefined;
  if (settings?.resumeButton === false) return null;
  const last = resumableAgentLast(ctx, agent);
  if (!last) return null;
  const name = agentLastLabel(last);
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => resumeAgentSession(ctx, agent, last, 'panel')}
        data-tip={last.command}
        className="flex max-w-full items-center gap-1.5 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--accent)] hover:bg-[var(--bg)]"
      >
        <Play className="h-2.5 w-2.5 shrink-0" />
        <span className="truncate">
          {i18n._(t`Resume ${agent} session${name ? ` '${name}'` : ''}`)}
        </span>
      </button>
    </div>
  );
}
