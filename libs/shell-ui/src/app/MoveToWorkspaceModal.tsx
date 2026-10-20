import { useMemo } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { SearchPickerModal, type PickerItem } from './SearchPickerModal';
import {
  workspaceTargets,
  type WindowLabelKind,
  type WorkspaceRef,
  type WorkspaceTarget,
} from './windowPeers';

/**
 * "Move to workspace…" picker: every workspace of every open window, grouped
 * by window and searchable (workspace or window name). The session's current
 * workspace is shown but not pickable; typing a name that matches nothing in
 * this window offers to create it here.
 */
export function MoveToWorkspaceModal({
  sessionName,
  currentWorkspaceId,
  windowId,
  ownWorkspaces,
  otherWindows,
  onPick,
  onCreate,
  onClose,
}: {
  sessionName: string;
  currentWorkspaceId: string;
  windowId: string;
  ownWorkspaces: WorkspaceRef[];
  otherWindows: ReadonlyMap<string, WorkspaceRef[]>;
  onPick: (target: WorkspaceTarget) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const format = (k: WindowLabelKind) =>
    k.kind === 'current' ? t`This window` : k.kind === 'main' ? t`Main window` : t`Window ${k.n}`;
  const targets = useMemo(
    () => workspaceTargets(windowId, ownWorkspaces, otherWindows, format),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [windowId, ownWorkspaces, otherWindows],
  );
  const byKey = new Map(targets.map((tg) => [`${tg.windowId}:${tg.workspace.id}`, tg]));
  const items: PickerItem[] = targets.map((tg) => {
    const current = tg.isCurrentWindow && tg.workspace.id === currentWorkspaceId;
    return {
      key: `${tg.windowId}:${tg.workspace.id}`,
      label: tg.workspace.name,
      group: tg.windowLabel,
      disabled: current,
      badge: current ? <Trans>current</Trans> : undefined,
    };
  });

  return (
    <SearchPickerModal
      title={<Trans>Move “{sessionName}” to workspace</Trans>}
      placeholder={t`Search workspaces or windows…`}
      items={items}
      onPick={(item) => {
        const target = byKey.get(item.key);
        if (target) onPick(target);
      }}
      onClose={onClose}
      createLabel={(name) =>
        targets.some((tg) => tg.isCurrentWindow && tg.workspace.name === name) ? null : (
          <Trans>New workspace “{name}” in this window</Trans>
        )
      }
      onCreate={onCreate}
    />
  );
}
