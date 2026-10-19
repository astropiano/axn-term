import { Trans, useLingui } from '@lingui/react/macro';
import { ContextMenu, menuItemClass } from './ContextMenu';
import type { Workspace } from './types';

/**
 * Anchored workspace chooser — the shared ContextMenu popup, listing the
 * window's workspaces in panel order. Used when an action can target any
 * workspace (e.g. dev-workflow's MR review falling back to a user pick
 * when no workspace hosts the repo). `onPick` receives the workspace and
 * the picker closes itself.
 */
export function WorkspacePicker({
  x,
  y,
  workspaces,
  title,
  onPick,
  onClose,
}: {
  /** Client coordinates to anchor the popup at (e.g. the click event's). */
  x: number;
  y: number;
  workspaces: Workspace[];
  /** Small caption row on top of the list. */
  title?: string;
  onPick: (workspace: Workspace) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  return (
    <ContextMenu x={x} y={y} onClose={onClose}>
      <div className="px-2 pt-1.5 pb-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {title ?? t`Open in workspace`}
      </div>
      {workspaces.map((ws) => (
        <button
          key={ws.id}
          type="button"
          className={menuItemClass}
          data-tip={ws.defaultFolder ?? ws.name}
          onClick={() => {
            onPick(ws);
            onClose();
          }}
        >
          <span className="truncate">{ws.name}</span>
        </button>
      ))}
      {workspaces.length === 0 && (
        <div className="px-2 py-1.5 text-[11px] italic text-[var(--text-secondary)]">
          <Trans>no workspaces</Trans>
        </div>
      )}
    </ContextMenu>
  );
}
