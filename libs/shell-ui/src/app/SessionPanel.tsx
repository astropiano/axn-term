import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, Fragment } from 'react';
import { Plus, Save, FolderOpen, ChevronRight, ChevronDown, ChevronUp, Trash2, Bot, SquareTerminal, Copy, Check, Pencil, BrushCleaning, LayoutGrid, X } from 'lucide-react';
import dynamicIconImports from 'lucide-react/dynamicIconImports';
import { useSessionBackend, useShellPlatform } from '../services';
import { SessionView } from './SessionView';
import { useSettings } from '../SettingsProvider';
import { usePluginSettings } from './PluginSettingsProvider';
import { createPluginApi } from './session-plugins/plugin';
import { AttentionDot } from './AttentionDot';
import { sessionAttention, summarizeAttention } from './attention';
import { IconButton } from './IconButton';
import { sanitizeSvgIcon } from './sanitizeSvg';
import type { AgentCli, ShellSession, Workspace } from '../types';
import { ptyIdOf } from '../types';
import type { RepoMenuItem, SessionViewPlugin } from './session-plugins/plugin';
import type { TaskStateSnapshot } from './useAgentTasks';

interface SessionPanelProps {
  workspaces: Workspace[];
  sessions: ShellSession[];
  selectedSessionId: string;
  taskState: TaskStateSnapshot | null;
  onSelectWorkspace: (id: string) => void;
  onSelectSession: (id: string) => void;
  onAddWorkspace: () => void;
  onSaveWorkspaceSet: () => Promise<void> | void;
  onLoadWorkspaceSet: () => Promise<void> | void;
  onRenameWorkspace: (id: string, name: string) => void;
  onDeleteWorkspace: (id: string) => void;
  onToggleWorkspace: (id: string) => void;
  updateWorkspace: (workspaceId: string, patch: Partial<Workspace>) => void;
  onAddSession: (workspaceId?: string, cwd?: string, name?: string) => void;
  onMoveSession: (sessionId: string, workspaceId: string, beforeSessionId?: string | null) => void;
  onReorderWorkspace: (workspaceId: string, targetIndex: number) => void;
  onMoveWorkspace: (workspaceId: string, delta: -1 | 1) => void;
  onRenameSession: (id: string, name: string) => void;
  onDuplicateSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  updateSession: (sessionId: string, patch: Partial<ShellSession>) => void;
  mergePluginState: (sessionId: string, stateKey: string, patch: Record<string, unknown>) => void;
  plugins: readonly SessionViewPlugin[];
  onOpenBrowser: (sessionId: string, path: string) => void;
  onOpenTab: (
    sessionId: string,
    tab: { path: string; kind: 'editor' | 'browser' | 'preview' | 'git' },
  ) => void;
  onOpenSubShell: (
    sessionId: string,
    command?: string,
    cwd?: string,
    label?: string,
    agent?: AgentCli,
  ) => string | undefined;
  onTurnIntoWorkspace: (sessionId: string) => void;
  pluginData: Record<string, unknown>;
  mergePluginData: (key: string, patch: Record<string, unknown>) => void;
}

const statusColor: Record<string, string> = {
  idle: 'var(--yellow)',
  running: 'var(--green)',
  blocked: 'var(--orange)',
  completed: 'var(--blue)',
};

const statusLabel: Record<string, string> = {
  idle: 'idle',
  running: 'running',
  blocked: 'blocked',
  completed: 'completed',
};

const LONG_PRESS_MS = 600;

interface MenuPosition {
  x: number;
  y: number;
}

function useContextMenuTrigger(onOpen: (pos: MenuPosition) => void) {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

  const startLongPress = useCallback(
    (x: number, y: number) => {
      didLongPress.current = false;
      longPressTimer.current = setTimeout(() => {
        didLongPress.current = true;
        onOpen({ x, y });
      }, LONG_PRESS_MS);
    },
    [onOpen],
  );

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onOpen({ x: e.clientX, y: e.clientY });
    },
    [onOpen],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      startLongPress(e.clientX, e.clientY);
    },
    [startLongPress],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      startLongPress(touch?.clientX ?? 0, touch?.clientY ?? 0);
    },
    [startLongPress],
  );

  const wrapClick = useCallback(
    <T extends React.MouseEvent>(handler?: (e: T) => void) =>
      (e: T) => {
        if (didLongPress.current) {
          didLongPress.current = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        handler?.(e);
      },
    [],
  );

  return {
    onContextMenu: handleContextMenu,
    onMouseDown: handleMouseDown,
    onMouseUp: cancelLongPress,
    onMouseLeave: cancelLongPress,
    onTouchStart: handleTouchStart,
    onTouchEnd: cancelLongPress,
    wrapClick,
  };
}

// Inline rename editing for the workspace header — triggered programmatically
// from the workspace context menu, so it must not swallow pointer events the
// header needs for click-toggle and drag-and-drop.
function useEditableName(value: string, onChange: (name: string) => void) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEdit = useCallback(() => {
    setEditValue(value);
    setEditing(true);
  }, [value]);

  const commit = useCallback(() => {
    onChange(editValue.trim() || value);
    setEditing(false);
  }, [editValue, onChange, value]);

  const input = editing ? (
    <input
      ref={inputRef}
      type="text"
      value={editValue}
      onChange={(e) => setEditValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setEditValue(value);
          setEditing(false);
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  ) : null;

  return { editing, input, startEdit };
}

function AddWorkspaceButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton onClick={onClick} title="New workspace">
      <Plus className="h-3.5 w-3.5" />
    </IconButton>
  );
}

function WorkspaceContextMenu({
  workspace,
  position,
  canDelete,
  canMoveUp,
  canMoveDown,
  onClose,
  onRename,
  onMove,
  onDelete,
  onSetDefaultFolder,
  onClearDefaultFolder,
  hasSession,
  pluginItems,
}: {
  workspace: Workspace;
  position: MenuPosition;
  canDelete: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onClose: () => void;
  onRename: () => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
  /** Set workspace.defaultFolder from the representative session's live cwd. */
  onSetDefaultFolder: () => void;
  onClearDefaultFolder: () => void;
  /** False when the workspace has no sessions — folder-from-session hidden. */
  hasSession: boolean;
  /** Rows contributed by enabled plugins via `workspaceMenuItems`. */
  pluginItems?: RepoMenuItem[];
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const x = Math.min(position.x, window.innerWidth - 240);
  const y = Math.min(position.y, window.innerHeight - 200);

  const itemClass =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]';
  const disabled = ' pointer-events-none opacity-40';

  return (
    <div
      ref={menuRef}
      style={{ top: y, left: x }}
      className="fixed z-50 w-56 rounded-lg bg-[var(--surface)] p-1 shadow-2xl"
    >
      <div
        className="truncate px-2 py-1 text-[10px] text-[var(--text-secondary)]"
        data-tip={workspace.name}
      >
        {workspace.name}
      </div>
      {workspace.defaultFolder && (
        <div
          className="flex items-center gap-2 truncate px-2 py-1 text-[10px] text-[var(--text-secondary)]"
          data-tip={`default folder: ${workspace.defaultFolder}`}
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{workspace.defaultFolder.split('/').filter(Boolean).pop()}</span>
        </div>
      )}
      <div className="my-1 h-px bg-[var(--border)]" />
      <button
        type="button"
        onClick={() => {
          onRename();
          onClose();
        }}
        className={itemClass}
      >
        <Pencil className="h-3.5 w-3.5 shrink-0" />
        Rename workspace…
      </button>
      {hasSession && (
        <button
          type="button"
          onClick={() => {
            onSetDefaultFolder();
            onClose();
          }}
          className={itemClass}
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          Set default folder to session dir
        </button>
      )}
      {workspace.defaultFolder && (
        <button
          type="button"
          onClick={() => {
            onClearDefaultFolder();
            onClose();
          }}
          className={itemClass}
        >
          <BrushCleaning className="h-3.5 w-3.5 shrink-0" />
          Clear default folder
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          onMove(-1);
          onClose();
        }}
        className={`${itemClass}${canMoveUp ? '' : disabled}`}
      >
        <ChevronUp className="h-3.5 w-3.5 shrink-0" />
        Move up
      </button>
      <button
        type="button"
        onClick={() => {
          onMove(1);
          onClose();
        }}
        className={`${itemClass}${canMoveDown ? '' : disabled}`}
      >
        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        Move down
      </button>
      {pluginItems && pluginItems.length > 0 && (
        <>
          <div className="my-1 h-px bg-[var(--border)]" />
          {pluginItems.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                item.onClick();
                onClose();
              }}
              className={itemClass}
            >
              {item.label}
            </button>
          ))}
        </>
      )}
      {canDelete && (
        <>
          <div className="my-1 h-px bg-[var(--border)]" />
          <button
            type="button"
            onClick={() => {
              onDelete();
              onClose();
            }}
            className={`${itemClass} hover:text-[var(--red)]`}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            Delete workspace
          </button>
        </>
      )}
    </div>
  );
}

function WorkspaceHeader({
  workspace,
  isCollapsed,
  canDelete,
  canMoveUp,
  canMoveDown,
  isDragging,
  onToggle,
  onAddSession,
  onRename,
  onMove,
  onDelete,
  onSetDefaultFolder,
  onClearDefaultFolder,
  hasSession,
  pluginItems,
  onDragStart,
  onDragEnd,
}: {
  workspace: Workspace;
  isCollapsed: boolean;
  canDelete: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  isDragging: boolean;
  onToggle: () => void;
  onAddSession: () => void;
  onRename: (name: string) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
  onSetDefaultFolder: () => void;
  onClearDefaultFolder: () => void;
  hasSession: boolean;
  pluginItems?: RepoMenuItem[];
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}) {
  const { editing, input, startEdit } = useEditableName(workspace.name, onRename);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition>({ x: 0, y: 0 });
  const {
    onContextMenu,
    onMouseDown,
    onMouseUp: cancelLongPress,
    onMouseLeave,
    onTouchStart,
    onTouchEnd,
    wrapClick,
  } = useContextMenuTrigger((pos) => {
    setMenuPos(pos);
    setMenuOpen(true);
  });

  return (
    <>
      <div
        className={`group flex items-center gap-1 text-xs text-[var(--text-primary)]${
          isDragging ? ' opacity-40' : ''
        }`}
        onClick={wrapClick(onToggle)}
        draggable={!editing}
        onDragStart={(e) => {
          // Keep a press-and-hold drag from opening the context menu mid-drag.
          cancelLongPress();
          onDragStart(e);
        }}
        onDragEnd={onDragEnd}
        onContextMenu={onContextMenu}
        onMouseDown={onMouseDown}
        onMouseUp={cancelLongPress}
        onMouseLeave={onMouseLeave}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        data-tip={`${workspace.name} (drag to reorder, right-click for options)`}
      >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        data-tip={isCollapsed ? 'Expand' : 'Collapse'}
        aria-label={isCollapsed ? 'Expand' : 'Collapse'}
        className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
      >
        {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {editing ? (
        <div className="flex-1 px-1" onClick={(e) => e.stopPropagation()}>
          {input && (
            <input
              {...(input.props as React.InputHTMLAttributes<HTMLInputElement>)}
              className="w-full rounded border border-[var(--accent)] bg-[var(--bg)] px-1.5 py-0.5 text-xs text-[var(--text-primary)] outline-none"
            />
          )}
        </div>
      ) : (
        <span className="flex-1 cursor-pointer truncate py-1.5 pl-1 font-semibold">
          {workspace.name}
        </span>
      )}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAddSession();
        }}
        data-tip="New session in workspace"
        aria-label="New session in workspace"
        className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] opacity-0 transition hover:bg-[var(--surface)] hover:text-[var(--accent)] group-hover:opacity-100"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {canDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          data-tip="Delete workspace"
          aria-label="Delete workspace"
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-secondary)] opacity-0 transition hover:bg-[var(--surface)] hover:text-[var(--red)] group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
      </div>

      {menuOpen && (
        <WorkspaceContextMenu
          workspace={workspace}
          position={menuPos}
          canDelete={canDelete}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          onClose={() => setMenuOpen(false)}
          onRename={startEdit}
          onMove={onMove}
          onDelete={onDelete}
          onSetDefaultFolder={onSetDefaultFolder}
          onClearDefaultFolder={onClearDefaultFolder}
          hasSession={hasSession}
          pluginItems={pluginItems}
        />
      )}
    </>
  );
}

interface SessionContextMenuProps {
  session: ShellSession;
  workspaces: Workspace[];
  position: MenuPosition;
  onClose: () => void;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  onMove: (workspaceId: string) => void;
  onSubShell: () => void;
  onBrowse: () => void;
  onCloseSession: () => void;
  onTurnIntoWorkspace?: () => void;
  /** Rows contributed by enabled plugins via `sessionMenuItems`. */
  pluginItems?: RepoMenuItem[];
}

function SessionContextMenu({
  session,
  workspaces,
  position,
  onClose,
  onDuplicate,
  onRename,
  onMove,
  onSubShell,
  onBrowse,
  onCloseSession,
  onTurnIntoWorkspace,
  pluginItems,
}: SessionContextMenuProps) {
  const [renaming, setRenaming] = useState(false);
  // A foreground process makes "Close session" a kill — confirm inline
  // inside the menu instead of closing without a word.
  const [confirmClose, setConfirmClose] = useState(false);
  const [name, setName] = useState(session.name);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  const x = Math.min(position.x, window.innerWidth - 240);
  const y = Math.min(position.y, window.innerHeight - 300);

  const commitRename = () => {
    const trimmed = name.trim();
    // A non-empty name renames; an empty one clears the custom override so the
    // session falls back to the name reported by the process.
    if (trimmed ? trimmed !== session.name : session.customName) {
      onRename(trimmed);
    }
    onClose();
  };

  const resetName = () => {
    onRename('');
    onClose();
  };

  const itemClass =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]';

  return (
    <div
      ref={menuRef}
      style={{ top: y, left: x }}
      className="fixed z-50 w-56 rounded-lg bg-[var(--surface)] p-1 shadow-2xl"
    >
      {confirmClose ? (
        <div className="px-2 py-2">
          <div className="mb-1 text-[11px] font-semibold text-[var(--text-primary)]">
            Close session?
          </div>
          <div className="mb-2 text-[10px] text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--orange)]">{session.process}</span> is still
            running — it will be terminated.
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmClose(false)}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[10px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onCloseSession();
                onClose();
              }}
              className="rounded bg-[var(--red)] px-2 py-1 text-[10px] text-[var(--text-inverted)] hover:opacity-90"
            >
              Close
            </button>
          </div>
        </div>
      ) : (
      <>
      <div className="flex items-center gap-1 pr-1">
        {renaming ? (
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setName(session.name);
                setRenaming(false);
              }
            }}
            className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--bg)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none"
          />
        ) : (
          <div
            className="min-w-0 flex-1 truncate px-2 py-1 text-[10px] text-[var(--text-secondary)]"
            data-tip={session.name}
          >
            {session.name}
          </div>
        )}
        {session.customName && (
          <button
            type="button"
            data-tip="Reset to process name"
            aria-label="Reset to process name"
            onClick={resetName}
            className="shrink-0 rounded p-1 text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <BrushCleaning className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="my-1 h-px bg-[var(--border)]" />
      {!renaming && (
        <button type="button" onClick={() => setRenaming(true)} className={itemClass}>
          <Pencil className="h-3.5 w-3.5 shrink-0" />
          Rename…
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          onDuplicate();
          onClose();
        }}
        className={itemClass}
      >
        <Copy className="h-3.5 w-3.5 shrink-0" />
        Duplicate session
      </button>
      <button
        type="button"
        onClick={() => {
          onSubShell();
          onClose();
        }}
        className={itemClass}
      >
        <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
        New sub-shell
      </button>
      {onTurnIntoWorkspace && (
        <button
          type="button"
          onClick={() => {
            onTurnIntoWorkspace();
            onClose();
          }}
          className={itemClass}
        >
          <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
          Turn into workspace
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          onBrowse();
          onClose();
        }}
        className={itemClass}
      >
        <FolderOpen className="h-3.5 w-3.5 shrink-0" />
        Browse folder
      </button>
      {(pluginItems?.length ?? 0) > 0 && (
        <>
          <div className="my-1 h-px bg-[var(--border)]" />
          {pluginItems!.map((item, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                item.onClick();
                onClose();
              }}
              className={itemClass}
            >
              {item.label}
            </button>
          ))}
        </>
      )}
      <div className="my-1 h-px bg-[var(--border)]" />
      <div className="px-2 py-1 text-[10px] text-[var(--text-secondary)]">Move to</div>
      <div className="max-h-40 overflow-y-auto">
        {workspaces.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => {
              if (w.id !== session.workspaceId) onMove(w.id);
              onClose();
            }}
            className={itemClass}
          >
            {w.id === session.workspaceId ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
            ) : (
              <span className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{w.name}</span>
          </button>
        ))}
      </div>
      <div className="my-1 h-px bg-[var(--border)]" />
      <button
        type="button"
        onClick={() => {
          // Live foreground process → confirm first (a close kills it);
          // idle sessions close immediately.
          if (session.process) {
            setConfirmClose(true);
          } else {
            onCloseSession();
            onClose();
          }
        }}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-[var(--red)] transition hover:bg-[var(--surface-hover)]"
      >
        <X className="h-3.5 w-3.5 shrink-0" />
        Close session
      </button>
      </>
      )}
    </div>
  );
}

function isSvgString(value: string): boolean {
  return value.trim().toLowerCase().startsWith('<svg');
}

function toKebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

function resolveSessionIcon(process?: string, sessionIcons?: Record<string, string>): string {
  if (!process) return 'SquareTerminal';
  const key = process.toLowerCase();
  return sessionIcons?.[key] ?? 'SquareTerminal';
}

/** Render a sessionIcons value: a Lucide icon name or an inline SVG tag. */
export function SessionIconGlyph({
  value,
  className = 'h-4 w-4 shrink-0',
}: {
  value: string;
  className?: string;
}) {
  const [DynamicIcon, setDynamicIcon] = useState<React.ComponentType<{ className?: string }> | null>(null);

  useEffect(() => {
    if (isSvgString(value)) {
      setDynamicIcon(null);
      return;
    }

    const lower = value.toLowerCase();
    if (lower === 'bot') {
      setDynamicIcon(() => Bot);
      return;
    }
    if (lower === 'square-terminal' || lower === 'terminal-squared' || lower === 'squareterminal') {
      setDynamicIcon(() => SquareTerminal);
      return;
    }

    const key = toKebabCase(value);
    const loader = (dynamicIconImports as unknown as Record<string, () => Promise<{ default: React.ComponentType<{ className?: string }> }>>)[key];
    if (!loader) {
      setDynamicIcon(() => SquareTerminal);
      return;
    }

    let cancelled = false;
    loader()
      .then((mod) => {
        if (!cancelled) setDynamicIcon(() => mod.default);
      })
      .catch(() => {
        if (!cancelled) setDynamicIcon(() => SquareTerminal);
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  const svg = useMemo(() => (isSvgString(value) ? sanitizeSvgIcon(value) : null), [value]);

  if (svg !== null) {
    return (
      <span
        className={`${className} text-[var(--text-primary)]`}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  const IconComponent = DynamicIcon ?? SquareTerminal;
  return <IconComponent className={className} />;
}

export function SessionIcon({
  process,
  className = 'h-4 w-4 shrink-0',
}: {
  process?: string;
  className?: string;
}) {
  const { settings } = useSettings();
  return (
    <SessionIconGlyph
      value={resolveSessionIcon(process, settings.sessionIcons)}
      className={className}
    />
  );
}

export function SessionItem({
  session,
  workspaces,
  isSelected,
  onOpenSubShell,
  onTurnIntoWorkspace,
  taskState,
  onSelect,
  onMove,
  onRename,
  onDuplicate,
  onCloseSession,
  updateSession,
  mergePluginState,
  plugins,
  onOpenBrowser,
  onOpenTab,
  onAddSession,
  pluginData,
  mergePluginData,
  isDragging,
  dropBefore,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  session: ShellSession;
  workspaces: Workspace[];
  isSelected: boolean;
  taskState: TaskStateSnapshot | null;
  onSelect: () => void;
  onMove: (workspaceId: string) => void;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onCloseSession: () => void;
  onOpenSubShell: (
    sessionId: string,
    command?: string,
    cwd?: string,
    label?: string,
    agent?: AgentCli,
  ) => string | undefined;
  onAddSession: (workspaceId?: string, cwd?: string, name?: string) => void;
  onTurnIntoWorkspace: (sessionId: string) => void;
  updateSession: (sessionId: string, patch: Partial<ShellSession>) => void;
  mergePluginState: (sessionId: string, stateKey: string, patch: Record<string, unknown>) => void;
  plugins: readonly SessionViewPlugin[];
  onOpenBrowser: (sessionId: string, path: string) => void;
  onOpenTab: (
    sessionId: string,
    tab: { path: string; kind: 'editor' | 'browser' | 'preview' | 'git' },
  ) => void;
  pluginData: Record<string, unknown>;
  mergePluginData: (key: string, patch: Record<string, unknown>) => void;
  isDragging: boolean;
  dropBefore: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const backend = useSessionBackend();
  const platform = useShellPlatform();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition>({ x: 0, y: 0 });
  const taskListRef = useRef<HTMLUListElement | null>(null);
  const [taskListMaxHeight, setTaskListMaxHeight] = useState<number | undefined>(undefined);
  const { pluginSettings } = usePluginSettings();
  const { settings } = useSettings();
  const attention = summarizeAttention(sessionAttention(session, plugins));
  const { onContextMenu, onMouseDown, onMouseUp, onMouseLeave, onTouchStart, onTouchEnd, wrapClick } =
    useContextMenuTrigger((pos) => {
      setMenuPos(pos);
      setMenuOpen(true);
    });

  useLayoutEffect(() => {
    if (taskListRef.current) {
      setTaskListMaxHeight(Math.min(taskListRef.current.scrollHeight, 384));
    }
  }, [taskState?.tasks]);

  // One pass over the plugins — each contributes a row badge (renderRow)
  // and optionally tooltip lines explaining it (rowTip).
  const rowTips: string[] = [];
  const rowBadges = plugins.map((plugin) => {
    if (!plugin.renderRow && !plugin.rowTip) return null;
    const api = createPluginApi(session, plugin, {
      backend,
      updateSession,
      mergePluginState,
      pluginSettings,
      plugins,
      openBrowser: onOpenBrowser,
      openTab: onOpenTab,
      openSubShell: onOpenSubShell,
      openSession: onAddSession,
      getWorkspaces: () => workspaces,
      pluginData,
      mergePluginData,
    });
    const tip = plugin.rowTip?.(api);
    if (tip) rowTips.push(...(Array.isArray(tip) ? tip : [tip]));
    return plugin.renderRow ? (
      <Fragment key={plugin.id}>{plugin.renderRow(api)}</Fragment>
    ) : null;
  });

  return (
    <>
      <div
        onClick={onSelect}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`mb-1 cursor-pointer rounded border transition ${
          isSelected
            ? 'border-[var(--border)] bg-[var(--surface)] shadow-[inset_2px_0_0_var(--accent)]'
            : 'border-transparent hover:bg-[var(--surface)]'
        }${isDragging ? ' opacity-40' : ''}${dropBefore ? ' shadow-[inset_0_2px_0_var(--accent)]' : ''}`}
        data-tip={[session.name, ...rowTips].join('\n')}
      >
        <div
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onContextMenu={onContextMenu}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseLeave}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onClick={wrapClick()}
          className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs text-[var(--text-primary)]"
        >
          <span className="relative flex shrink-0" data-tip={attention?.title}>
            {attention && (
              <AttentionDot
                level={attention.level}
                className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2"
              />
            )}
            <span className="relative flex">
              <SessionIcon process={session.process} />
            </span>
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold">{session.name}</span>
          {rowBadges}
          {session.status &&
            (session.status === 'running' && (session.progress ?? 0) > 0 ? (
              <span
                className="flex shrink-0 items-center gap-1.5"
                data-tip={`running — ${session.progress}%`}
              >
                <span className="h-1.5 w-10 overflow-hidden rounded bg-[var(--bg)]">
                  <span
                    className="block h-full transition-all"
                    style={{
                      width: `${session.progress}%`,
                      backgroundColor: statusColor.running,
                    }}
                  />
                </span>
                <span className="text-[10px]" style={{ color: statusColor.running }}>
                  {session.progress}%
                </span>
              </span>
            ) : (
              <span
                className="shrink-0 text-[10px] uppercase tracking-wide"
                style={{ color: statusColor[session.status] }}
              >
                {statusLabel[session.status]}
              </span>
            ))}
        </div>

        {session.summary && settings.sessionSummaries !== false && (
          <div
            className="truncate px-2 pb-1.5 text-[11px] text-[var(--text-secondary)]"
            data-tip={session.summary}
          >
            {session.summary}
          </div>
        )}

        {isSelected && (
          <div className="px-2 py-2 text-xs leading-relaxed text-[var(--text-primary)]">
            {session.process && (
              <p className="mb-2 text-[10px] text-[var(--text-secondary)]">
                process:{' '}
                <span className="text-[var(--text-primary)]">{session.process}</span>
              </p>
            )}

            <SessionView
              session={session}
              updateSession={updateSession}
              mergePluginState={mergePluginState}
              plugins={plugins}
              onOpenBrowser={onOpenBrowser}
              onOpenTab={onOpenTab}
              onOpenSubShell={onOpenSubShell}
              onOpenSession={onAddSession}
              getWorkspaces={() => workspaces}
              pluginData={pluginData}
              mergePluginData={mergePluginData}
            />

            {taskState && taskState.tasks.length > 0 && (
              <div className="mb-2">
                <span className="text-[var(--accent)]">tasks:</span>
                <ul
                  ref={taskListRef}
                  style={{ maxHeight: taskListMaxHeight ?? 384 }}
                  className="mt-1 space-y-0.5 overflow-y-auto pl-3"
                >
                  {taskState.tasks.map((task) => (
                    <li key={task.id} className="flex items-start gap-1.5">
                      <span className="inline-block w-4 shrink-0 select-none text-center text-[var(--text-secondary)]">
                        {task.status === 'completed' ? '✓' : '•'}
                      </span>
                      <span className={task.status === 'completed' ? 'line-through text-[var(--text-secondary)]' : ''}>
                        {task.title}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {((taskState?.tasks?.length ?? 0) > 0 ||
              (session.tasks ?? []).length > 0 ||
              (session.progress ?? 0) > 0) && (
              <div>
                <div className="mb-0.5 flex justify-between text-[10px] text-[var(--text-secondary)]">
                  <span>progress</span>
                  <span>{session.progress}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden bg-[var(--bg)]">
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${session.progress}%`,
                      backgroundColor: session.status
                        ? statusColor[session.status]
                        : 'var(--text-secondary)',
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {menuOpen && (
        <SessionContextMenu
          session={session}
          workspaces={workspaces}
          position={menuPos}
          onClose={() => setMenuOpen(false)}
          pluginItems={plugins.flatMap((plugin) => {
            if (!plugin.sessionMenuItems) return [];
            try {
              return plugin.sessionMenuItems(
                createPluginApi(session, plugin, {
                  backend,
                  updateSession,
                  mergePluginState,
                  pluginSettings,
                  plugins,
                  openBrowser: onOpenBrowser,
                  openTab: onOpenTab,
                  openSubShell: onOpenSubShell,
                  openSession: onAddSession,
                  getWorkspaces: () => workspaces,
                  pluginData,
                  mergePluginData,
                }),
              );
            } catch {
              return [] as RepoMenuItem[];
            }
          })}
          onDuplicate={onDuplicate}
          onRename={onRename}
          onMove={onMove}
          onCloseSession={onCloseSession}
          onSubShell={() => onOpenSubShell(session.id)}
          onTurnIntoWorkspace={
            // Only offered when the session actually has sub-shell tabs.
            (session.editors ?? []).some((e) => e.kind === 'shell')
              ? () => onTurnIntoWorkspace(session.id)
              : undefined
          }
          onBrowse={() => {
            void (async () => {
              // The PTY's live cwd beats session.cwd, which is only refreshed
              // while the session is visible and can be stale.
              const cwd =
                (await backend.getCwd?.(session.id).catch(() => null)) ??
                session.cwd ??
                (await platform.homeDir().catch(() => '/'));
              onOpenBrowser(session.id, cwd);
            })();
          }}
        />
      )}
    </>
  );
}

export function SessionPanel({
  workspaces,
  sessions,
  selectedSessionId,
  taskState,
  onSelectWorkspace,
  onSelectSession,
  onAddWorkspace,
  onSaveWorkspaceSet,
  onLoadWorkspaceSet,
  onRenameWorkspace,
  onDeleteWorkspace,
  onToggleWorkspace,
  updateWorkspace,
  onAddSession,
  onMoveSession,
  onReorderWorkspace,
  onMoveWorkspace,
  onRenameSession,
  onDuplicateSession,
  onCloseSession,
  updateSession,
  mergePluginState,
  plugins,
  onOpenBrowser,
  onOpenTab,
  onOpenSubShell,
  onTurnIntoWorkspace,
  pluginData,
  mergePluginData,
}: SessionPanelProps) {
  const [dragSessionId, setDragSessionId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    workspaceId: string;
    beforeSessionId: string | null;
  } | null>(null);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  // Index in the workspaces array the dragged workspace would land at.
  const [workspaceDropIndex, setWorkspaceDropIndex] = useState<number | null>(null);
  const backend = useSessionBackend();
  const { pluginSettings } = usePluginSettings();

  // The session a workspace-scoped action binds to: the selected session when
  // it lives in that workspace, otherwise the workspace's first session.
  const representativeSession = (workspace: Workspace): ShellSession | undefined =>
    sessions.find((s) => s.id === selectedSessionId && s.workspaceId === workspace.id) ??
    sessions.find((s) => s.workspaceId === workspace.id);

  const workspacePluginItems = (workspace: Workspace): RepoMenuItem[] => {
    const rep = representativeSession(workspace);
    if (!rep) return [];
    return plugins.flatMap((plugin) => {
      if (!plugin.workspaceMenuItems) return [];
      try {
        return plugin.workspaceMenuItems(
          createPluginApi(rep, plugin, {
            backend,
            updateSession,
            mergePluginState,
            pluginSettings,
            plugins,
            openBrowser: onOpenBrowser,
            openTab: onOpenTab,
            openSubShell: onOpenSubShell,
            openSession: onAddSession,
            getWorkspaces: () => workspaces,
            pluginData,
            mergePluginData,
          }),
          workspace,
        );
      } catch {
        return [] as RepoMenuItem[];
      }
    });
  };

  const handleSetDefaultFolder = (workspace: Workspace) => {
    const rep = representativeSession(workspace);
    if (!rep) return;
    void (async () => {
      const cwd =
        (await backend.getCwd?.(ptyIdOf(rep)).catch(() => null)) ?? rep.cwd;
      if (cwd) updateWorkspace(workspace.id, { defaultFolder: cwd });
    })();
  };

  const handleDragStart = (e: React.DragEvent, sessionId: string) => {
    e.dataTransfer.setData('application/x-axn-session', sessionId);
    e.dataTransfer.effectAllowed = 'move';
    setDragSessionId(sessionId);
  };

  const handleDragEnd = () => {
    setDragSessionId(null);
    setDropTarget(null);
  };

  const handleWorkspaceDragStart = (e: React.DragEvent, workspaceId: string) => {
    e.dataTransfer.setData('application/x-axn-workspace', workspaceId);
    e.dataTransfer.effectAllowed = 'move';
    setDragWorkspaceId(workspaceId);
  };

  const handleWorkspaceDragEnd = () => {
    setDragWorkspaceId(null);
    setWorkspaceDropIndex(null);
  };

  // During a workspace drag the pointer position within a workspace block
  // decides the insertion index: top half drops before it, bottom half after.
  const workspaceInsertIndex = (e: React.DragEvent, index: number) =>
    e.clientY < e.currentTarget.getBoundingClientRect().top +
      e.currentTarget.getBoundingClientRect().height / 2
      ? index
      : index + 1;

  const handleWorkspaceBlockDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setWorkspaceDropIndex(workspaceInsertIndex(e, index));
  };

  const handleWorkspaceBlockDrop = (e: React.DragEvent, index: number) => {
    if (!dragWorkspaceId) return;
    e.preventDefault();
    e.stopPropagation();
    onReorderWorkspace(dragWorkspaceId, workspaceInsertIndex(e, index));
    setDragWorkspaceId(null);
    setWorkspaceDropIndex(null);
  };

  const handleSessionDragOver = (
    e: React.DragEvent,
    workspaceId: string,
    beforeSessionId: string,
  ) => {
    if (!dragSessionId || dragSessionId === beforeSessionId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget({ workspaceId, beforeSessionId });
  };

  const handleWorkspaceDragOver = (e: React.DragEvent, workspaceId: string) => {
    if (!dragSessionId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget({ workspaceId, beforeSessionId: null });
  };

  const handleDrop = (
    e: React.DragEvent,
    workspaceId: string,
    beforeSessionId: string | null,
  ) => {
    if (!dragSessionId) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragSessionId !== beforeSessionId) {
      onMoveSession(dragSessionId, workspaceId, beforeSessionId);
    }
    setDragSessionId(null);
    setDropTarget(null);
  };

  return (
    <div className="flex h-full w-full flex-col border-r border-[var(--border)] bg-[var(--bg)]">
      <div className="flex h-8 shrink-0 items-center justify-between gap-1 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2">
        <div className="flex items-center gap-1">
          <AddWorkspaceButton onClick={onAddWorkspace} />
          <IconButton title="Save workspace set" onClick={onSaveWorkspaceSet}>
            <Save className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton title="Load workspace set" onClick={onLoadWorkspaceSet}>
            <FolderOpen className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {workspaces.map((workspace, index) => {
          const workspaceSessions = sessions.filter((s) => s.workspaceId === workspace.id);
          const isCollapsed = workspace.collapsed ?? false;

          return (
            <Fragment key={workspace.id}>
              {dragWorkspaceId && workspaceDropIndex === index && (
                <div className="mb-2 h-0.5 rounded-full bg-[var(--accent)]" />
              )}
              <div
                className={`mb-3 rounded transition ${
                  dropTarget?.workspaceId === workspace.id && dropTarget.beforeSessionId === null
                    ? 'ring-1 ring-[var(--accent)]'
                    : ''
                }`}
                onDragOver={(e) => {
                  if (dragWorkspaceId) {
                    handleWorkspaceBlockDragOver(e, index);
                    return;
                  }
                  handleWorkspaceDragOver(e, workspace.id);
                }}
                onDrop={(e) => {
                  if (dragWorkspaceId) {
                    handleWorkspaceBlockDrop(e, index);
                    return;
                  }
                  handleDrop(e, workspace.id, null);
                }}
              >
                <WorkspaceHeader
                  workspace={workspace}
                  isCollapsed={isCollapsed}
                  canDelete={workspaces.length > 1}
                  canMoveUp={index > 0}
                  canMoveDown={index < workspaces.length - 1}
                  isDragging={dragWorkspaceId === workspace.id}
                  onToggle={() => onToggleWorkspace(workspace.id)}
                  onAddSession={() => onAddSession(workspace.id, workspace.defaultFolder)}
                  onRename={(name) => onRenameWorkspace(workspace.id, name)}
                  onMove={(delta) => onMoveWorkspace(workspace.id, delta)}
                  onDelete={() => onDeleteWorkspace(workspace.id)}
                  onSetDefaultFolder={() => handleSetDefaultFolder(workspace)}
                  onClearDefaultFolder={() =>
                    updateWorkspace(workspace.id, { defaultFolder: undefined })
                  }
                  hasSession={representativeSession(workspace) !== undefined}
                  pluginItems={workspacePluginItems(workspace)}
                  onDragStart={(e) => handleWorkspaceDragStart(e, workspace.id)}
                  onDragEnd={handleWorkspaceDragEnd}
                />

              {!isCollapsed && (
                <div className="mt-1 space-y-1 pl-2">
                  {workspaceSessions.map((session) => {
                    const isSelected = session.id === selectedSessionId;
                    return (
                      <SessionItem
                        key={session.id}
                        session={session}
                        workspaces={workspaces}
                        isSelected={isSelected}
                        taskState={isSelected ? taskState : null}
                        onSelect={() => {
                          onSelectSession(session.id);
                          onSelectWorkspace(workspace.id);
                        }}
                        onMove={(workspaceId) => onMoveSession(session.id, workspaceId)}
                        onRename={(name) => onRenameSession(session.id, name)}
                        onDuplicate={() => onDuplicateSession(session.id)}
                        onCloseSession={() => onCloseSession(session.id)}
                        updateSession={updateSession}
                        mergePluginState={mergePluginState}
                        plugins={plugins}
                        onOpenBrowser={onOpenBrowser}
                        onOpenTab={onOpenTab}
                        onOpenSubShell={onOpenSubShell}
                        onAddSession={onAddSession}
                        onTurnIntoWorkspace={onTurnIntoWorkspace}
                        pluginData={pluginData}
                        mergePluginData={mergePluginData}
                        isDragging={dragSessionId === session.id}
                        dropBefore={
                          dropTarget?.beforeSessionId === session.id &&
                          dropTarget.workspaceId === workspace.id
                        }
                        onDragStart={(e) => handleDragStart(e, session.id)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(e) =>
                          handleSessionDragOver(e, workspace.id, session.id)
                        }
                        onDrop={(e) => handleDrop(e, workspace.id, session.id)}
                      />
                    );
                  })}
                  {workspaceSessions.length === 0 && (
                    <div className="px-2 py-1 text-xs italic text-[var(--text-secondary)]">
                      no sessions
                    </div>
                  )}
                </div>
              )}
              </div>
            </Fragment>
          );
        })}
        {dragWorkspaceId && workspaceDropIndex === workspaces.length && (
          <div className="h-0.5 rounded-full bg-[var(--accent)]" />
        )}
      </div>
    </div>
  );
}
