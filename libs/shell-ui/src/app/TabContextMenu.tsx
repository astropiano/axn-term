import { useEffect, useRef, useState } from 'react';
import { BrushCleaning, Copy, MoveRight, Pencil, SquareTerminal, X } from 'lucide-react';
import { ContextMenu } from '../ContextMenu';
import type { EditorTab } from '../types';
import { defaultTabLabel } from './subshellPromote';

/**
 * Right-click menu for tabs: rename (inline input, sub-shell tabs only),
 * "Move to" targets (sessions ↔ tab-hosting plugin views), and close.
 */
export function TabContextMenu({
  tab,
  position,
  onClose,
  onRename,
  onMakeMain,
  onCopyPath,
  onCloseTab,
  moveTargets,
  onMoveTo,
}: {
  tab: EditorTab;
  position: { x: number; y: number };
  onClose: () => void;
  /** Only provided for sub-shell tabs — they are the renamable kind. */
  onRename?: (label: string) => void;
  /** Only provided for sub-shell tabs — promotes the tab to the main shell. */
  onMakeMain?: () => void;
  /** Only provided for sub-shell tabs — copies the tab shell's live cwd. */
  onCopyPath?: () => void;
  onCloseTab: () => void;
  /** "Move to" targets — plugin views for session tabs, sessions for hosted tabs. */
  moveTargets?: { id: string; label: string }[];
  onMoveTo?: (targetId: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(tab.label ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);


  const tabLabel =
    tab.kind === 'shell'
      ? (tab.label ?? defaultTabLabel(tab))
      : tab.path.split('/').pop() || tab.path;

  const commitRename = () => {
    const trimmed = name.trim();
    // Non-empty sets the tab label; empty clears it → default label.
    if (trimmed ? trimmed !== tab.label : tab.label) onRename?.(trimmed);
    onClose();
  };

  const resetLabel = () => {
    onRename?.('');
    onClose();
  };

  const itemClass =
    'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs text-[var(--text-primary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-2)]';

  return (
    <ContextMenu
      x={position.x}
      y={position.y}
      onClose={onClose}
      className="rounded-[var(--radius-lg)] bg-[var(--elevated)] p-1 shadow-[var(--shadow-pop)]"
    >
      <div className="flex items-center gap-1 pr-1">
        {renaming && onRename ? (
          <input
            ref={inputRef}
            type="text"
            value={name}
            placeholder={defaultTabLabel(tab)}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setName(tab.label ?? '');
                setRenaming(false);
              }
            }}
            className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
          />
        ) : (
          <div
            className="min-w-0 flex-1 truncate px-2 py-1 text-[11px] text-[var(--text-secondary)]"
            data-tip={tab.kind === 'shell' ? tabLabel : tab.path}
          >
            {tabLabel}
          </div>
        )}
        {onRename && tab.label && (
          <button
            type="button"
            data-tip="Reset to default name"
            aria-label="Reset to default name"
            onClick={resetLabel}
            className="shrink-0 rounded p-1 text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <BrushCleaning className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="my-1 h-px bg-[var(--hairline)]" />
      {!renaming && onRename && (
        <button type="button" onClick={() => setRenaming(true)} className={itemClass}>
          <Pencil className="h-3.5 w-3.5 shrink-0" />
          Rename…
        </button>
      )}
      {onMakeMain && (
        <button
          type="button"
          onClick={() => {
            onMakeMain();
            onClose();
          }}
          className={itemClass}
        >
          <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
          Make main shell
        </button>
      )}
      {onCopyPath && (
        <button
          type="button"
          onClick={() => {
            onCopyPath();
            onClose();
          }}
          className={itemClass}
        >
          <Copy className="h-3.5 w-3.5 shrink-0" />
          Copy path
        </button>
      )}
      {moveTargets && moveTargets.length > 0 && (
        <>
          <div className="px-2 pb-0.5 pt-1 text-[11px] font-semibold text-[var(--text-secondary)]">
            Move to
          </div>
          {moveTargets.map((target) => (
            <button
              key={target.id}
              type="button"
              onClick={() => {
                onMoveTo?.(target.id);
                onClose();
              }}
              className={itemClass}
            >
              <MoveRight className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{target.label}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-[var(--hairline)]" />
        </>
      )}
      <button
        type="button"
        onClick={() => {
          onCloseTab();
          onClose();
        }}
        className={itemClass}
      >
        <X className="h-3.5 w-3.5 shrink-0" />
        Close tab
      </button>
    </ContextMenu>
  );
}
