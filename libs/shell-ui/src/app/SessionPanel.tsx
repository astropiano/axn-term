import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, Fragment, type CSSProperties, type ReactNode } from 'react';
import { useIconBag, resolveIcon, resolveProcessIcon, type IconBag } from './iconModel';
import { ContextMenu, menuItemClass } from '../ContextMenu';
import { broadcastSet, useBroadcastMarked, useBroadcastSet } from './broadcastSet';
import { Plus, Save, FolderOpen, FolderCog, FolderPlus, Search, ChevronRight, ChevronDown, ChevronUp, Trash2, Bot, SquareTerminal, Copy, Pencil, BrushCleaning, LayoutGrid, X, MoveRight, AppWindow, FileText, PanelLeft, Radio, Check, AlertTriangle, MoreHorizontal } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import dynamicIconImports from 'lucide-react/dynamicIconImports';
import { useSessionBackend, useShellPlatform, useShellServices } from '../services';
import { pluginSessionFields } from './session-plugins/plugin';
import { CORE_FIELDS, parseCardLayout, resolveCardLayout, type FieldMeta } from './sessionCardLayout';
import { matchesTerms, placedFieldIds, searchLayout, sessionSearchTerms } from './sessionSearch';
import { useSettings } from '../SettingsProvider';
import { fontStackAvailable } from '../themes';
import { usePluginSettings } from './PluginSettingsProvider';
import { createPluginApi } from './session-plugins/plugin';
import { AttentionDot } from './AttentionDot';
import { sessionAttention, summarizeAttention } from './attention';
import { IconButton } from './IconButton';
import { PanelStatusSection } from './PanelStatusSection';
import {
  PANEL_UI_KEY,
  storedExpandedGroups,
  storedSystemExpanded,
  toggleExpandedGroup,
} from './panelStatus';
import { orderRailPlugins } from './railOrder';
import { sanitizeSvgIcon } from './sanitizeSvg';
import { useContextMenuTrigger } from '../useContextMenuTrigger';
import type { MenuPosition } from '../useContextMenuTrigger';
import type { AgentCli, AttentionLevel, ShellSession, Workspace } from '../types';
import { sessionDisplayName, ptyIdOf } from '../types';
import type { RepoMenuItem, SessionViewPlugin } from './session-plugins/plugin';
import type { TaskStateSnapshot } from './useAgentTasks';
import { SetDefaultFolderModal } from './SetDefaultFolderModal';
import { EditSessionSummaryModal } from './EditSessionSummaryModal';
import { InvalidDefaultFolderModal } from './InvalidDefaultFolderModal';
import { DeleteWorkspaceModal } from './DeleteWorkspaceModal';
import { isRenameShortcut, isTextEntryTarget } from './shortcuts';
import { FilePickerModal } from './FilePickerModal';
import {
  createDragExitTracker,
  dragEndedOutside,
  tearOffPlacement,
  type TearOffPlacement,
} from './sessionTearOff';

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
  /** Opens the "Move to workspace" picker for a session (menu row). */
  onRequestMoveSession?: (sessionId: string) => void;
  onReorderWorkspace: (workspaceId: string, targetIndex: number) => void;
  onMoveWorkspace: (workspaceId: string, delta: -1 | 1) => void;
  onRenameSession: (id: string, name: string) => void;
  onDuplicateSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  updateSession: (sessionId: string, patch: Partial<ShellSession>) => void;
  mergePluginState: (sessionId: string, stateKey: string, patch: Record<string, unknown>) => void;
  plugins: readonly SessionViewPlugin[];
  onOpenBrowser: (sessionId: string, path: string) => void;
  onOpenIde: (sessionId: string, path: string) => void;
  onOpenBroadcastDeck?: (sessionId: string) => void;
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
  /** Moves a session into a new window of its own; absent where windows can't be opened. */
  onMoveToNewWindow?: (sessionId: string) => void;
  /** A session row started dragging (announced to the other windows). */
  onSessionDragStart?: (sessionId: string) => void;
  /** A session row drag ended — `outside` when it ended beyond this window. */
  onSessionDragEnd?: (sessionId: string, end: SessionDragEndInfo) => void;
  /** A session another window is dragging; the panel accepts its drop. */
  foreignDrag?: { sessionId: string; name: string } | null;
  /** Take the foreign session at this spot; true when claimed. */
  onForeignDrop?: (workspaceId: string, beforeSessionId: string | null) => boolean;
  /**
   * Raised attention flags that belong to no session (memory pressure, an
   * invalid config file, …) — shown as a warning button in the toolbar row.
   */
  appAttention?: { count: number; level: AttentionLevel; title: string } | null;
  /** Open the list of all raised flags (the warning button's click). */
  onShowAttention?: () => void;
  /**
   * Status sources whose accordion is hidden because the user shows the
   * plugin's detailed rail item instead (`statusDisplay` = rail). They keep
   * publishing; the panel just skips their row.
   */
  hiddenStatusSources?: readonly string[];
  /**
   * Opens the plugin's own view (its `renderView`) — the status
   * accordions of view-capable plugins get an "open" button.
   */
  onOpenPluginView?: (source: string) => void;
}

/**
 * Whether a session row passes the panel's filters: the text filter
 * (`query`, lower-cased) and — when `attentionIds` is given — "only
 * sessions that need you".
 */
export function panelSessionVisible(
  session: Pick<ShellSession, 'id' | 'name'>,
  filter: { query: string; attentionIds: ReadonlySet<string> | null },
): boolean {
  if (filter.attentionIds && !filter.attentionIds.has(session.id)) return false;
  return !filter.query || session.name.toLowerCase().includes(filter.query);
}

export interface SessionDragEndInfo {
  dropEffect: string;
  outside: boolean;
  placement: TearOffPlacement;
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

/**
 * Short, human path for a session row's second line: the home directory
 * collapses to `~` and only the last two segments are kept
 * (`/Users/me/dev/axn-term` → `~/dev/axn-term`, deeper paths → `…/a/b`).
 */
export function cwdLabel(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.length > 1 ? cwd.replace(/[\\/]+$/, '') : cwd;
  const home = trimmed.replace(/^\/(?:Users|home)\/[^/]+/, '~');
  const parts = home.split('/').filter(Boolean);
  if (parts.length <= 3) return home || '/';
  return `…/${parts.slice(-2).join('/')}`;
}

/**
 * The row's second line: why the session needs attention, else where it
 * runs — unless its name already says so (a name that contains the folder
 * needs no second line).
 */
export function sessionMetaLine(
  session: Pick<ShellSession, 'name' | 'cwd'>,
  attentionTitle?: string,
): string | null {
  if (attentionTitle) return attentionTitle.split('\n')[0];
  const label = cwdLabel(session.cwd);
  if (!label) return null;
  const folder = label.split('/').filter(Boolean).pop();
  if (!folder || folder === '~' || session.name.toLowerCase().includes(folder.toLowerCase())) return null;
  return label;
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

/** Wraps the first case-insensitive occurrence of `query` in an accent span. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="rounded bg-[var(--accent)]/25">{text.slice(i, i + query.length)}</span>
      {text.slice(i + query.length)}
    </>
  );
}

/** Panel-header filter input — sits right of the workspace buttons. */
export function PanelSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const { t } = useLingui();
  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-[var(--text-tertiary)]" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('');
        }}
        placeholder={placeholder ?? t`Filter sessions…`}
        className="h-7 w-full min-w-0 rounded-[var(--radius-md)] bg-[var(--fill-1)] pl-7 pr-6 text-xs text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--hairline)] outline-none transition-shadow duration-[var(--dur-1)] placeholder:text-[var(--text-tertiary)] focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--ring)]"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear filter"
          className="absolute right-1.5 flex h-4 w-4 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--fill-2)] hover:text-[var(--text-primary)]"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function AddWorkspaceButton({ onClick }: { onClick: () => void }) {
  const { t } = useLingui();
  return (
    <IconButton onClick={onClick} title={t`New workspace`}>
      <Plus className="h-4 w-4" />
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
  onEditDefaultFolder,
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
  /** Opens the default-folder path modal (any path, unverified). */
  onEditDefaultFolder: () => void;
  /** Set workspace.defaultFolder from the representative session's live cwd. */
  onSetDefaultFolder: () => void;
  onClearDefaultFolder: () => void;
  /** False when the workspace has no sessions — folder-from-session hidden. */
  hasSession: boolean;
  /** Rows contributed by enabled plugins via `workspaceMenuItems`. */
  pluginItems?: RepoMenuItem[];
}) {


  const itemClass =
    'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs text-[var(--text-primary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-2)]';
  const disabled = ' pointer-events-none opacity-40';

  return (
    <ContextMenu
      x={position.x}
      y={position.y}
      onClose={onClose}
      className="rounded-[var(--radius-lg)] bg-[var(--elevated)] p-1 shadow-[var(--shadow-pop)]"
    >
      <div
        className="truncate px-2 py-1 text-[11px] text-[var(--text-secondary)]"
        data-tip={workspace.name}
      >
        {workspace.name}
      </div>
      {workspace.defaultFolder && (
        <div
          className="flex items-center gap-2 truncate px-2 py-1 text-[11px] text-[var(--text-secondary)]"
          data-tip={`default folder: ${workspace.defaultFolder}`}
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{workspace.defaultFolder.split('/').filter(Boolean).pop()}</span>
        </div>
      )}
      <div className="my-1 h-px bg-[var(--hairline)]" />
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
      <button
        type="button"
        onClick={() => {
          onEditDefaultFolder();
          onClose();
        }}
        className={itemClass}
      >
        <FolderCog className="h-3.5 w-3.5 shrink-0" />
        Set default folder…
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
          <div className="my-1 h-px bg-[var(--hairline)]" />
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
          <div className="my-1 h-px bg-[var(--hairline)]" />
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
    </ContextMenu>
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
  onEditDefaultFolder,
  onSetDefaultFolder,
  onClearDefaultFolder,
  hasSession,
  pluginItems,
  searchQuery,
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
  onEditDefaultFolder: () => void;
  onSetDefaultFolder: () => void;
  onClearDefaultFolder: () => void;
  hasSession: boolean;
  pluginItems?: RepoMenuItem[];
  /** Active panel filter — matched name substring is highlighted. */
  searchQuery?: string;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}) {
  const { t } = useLingui();
  const { settings } = useSettings();
  const { editing, input, startEdit } = useEditableName(workspace.name, onRename);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition>({ x: 0, y: 0 });
  const {
    onContextMenu,
    onMouseDown,
    onMouseUp: cancelLongPress,
    onMouseLeave,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
    wrapClick,
  } = useContextMenuTrigger((pos) => {
    setMenuPos(pos);
    setMenuOpen(true);
  });

  return (
    <>
      <div
        className={`group flex h-7 items-center gap-0.5 text-xs text-[var(--text-secondary)]${
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
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        data-tip={`${workspace.name} (drag to reorder, right-click for options)`}
      >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        data-tip={isCollapsed ? t`Expand` : t`Collapse`}
        aria-label={isCollapsed ? 'Expand' : 'Collapse'}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-tertiary)] transition-colors duration-[var(--dur-1)] hover:text-[var(--text-primary)]"
      >
        {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {editing ? (
        <div className="flex-1 px-1" onClick={(e) => e.stopPropagation()}>
          {input && (
            <input
              {...(input.props as React.InputHTMLAttributes<HTMLInputElement>)}
              className="w-full rounded-[var(--radius-sm)] bg-[var(--bg)] px-1.5 py-0.5 text-xs text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--ring)] outline-none"
            />
          )}
        </div>
      ) : (
        <span className="flex-1 cursor-pointer truncate font-semibold tracking-[0.01em] transition-colors duration-[var(--dur-1)] group-hover:text-[var(--text-primary)]">
          <Highlight text={workspace.name} query={searchQuery ?? ''} />
        </span>
      )}

      {(settings.newSessionButton ?? 'both') !== 'list' && (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAddSession();
        }}
        data-tip={t`New session in workspace`}
        aria-label="New session in workspace"
        className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-secondary)] opacity-50 transition hover:bg-[var(--fill-2)] hover:text-[var(--text-primary)] group-hover:opacity-100 pointer-coarse:opacity-100"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      )}
      {canDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          data-tip={t`Delete workspace`}
          aria-label="Delete workspace"
          className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-secondary)] opacity-50 transition hover:bg-[var(--fill-2)] hover:text-[var(--red)] group-hover:opacity-100 pointer-coarse:opacity-100"
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
          onEditDefaultFolder={onEditDefaultFolder}
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
  /** Multi-selected session ids when this session is in a multi-selection. */
  bulkIds?: string[];
  onBulkClose?: (ids: string[]) => void;
  position: MenuPosition;
  onClose: () => void;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  /** Opens the summary editor modal. */
  onEditSummary: () => void;
  /** Opens the "Move to workspace" picker; absent hides the row. */
  onRequestMove?: () => void;
  /** Moves the session into a new window; absent hides the row. */
  onMoveToNewWindow?: () => void;
  onSubShell: () => void;
  onBrowse: () => void;
  onIde: () => void;
  /** Opens the broadcast-deck tab for this session. */
  onOpenBroadcastDeck?: () => void;
  /** Copies the shell's live working directory; absent where it can't be read. */
  onCopyPath?: () => void;
  onCloseSession: () => void;
  onTurnIntoWorkspace?: () => void;
  /** Rows contributed by enabled plugins via `sessionMenuItems`. */
  pluginItems?: RepoMenuItem[];
}

function SessionContextMenu({
  session,
  bulkIds,
  onBulkClose,
  position,
  onClose,
  onDuplicate,
  onRename,
  onEditSummary,
  onRequestMove,
  onMoveToNewWindow,
  onSubShell,
  onBrowse,
  onIde,
  onOpenBroadcastDeck,
  onCopyPath,
  onCloseSession,
  onTurnIntoWorkspace,
  pluginItems,
}: SessionContextMenuProps) {
  const { t } = useLingui();
  const [renaming, setRenaming] = useState(false);
  // A foreground process makes "Close session" a kill — confirm inline
  // inside the menu instead of closing without a word.
  const [confirmClose, setConfirmClose] = useState(false);
  const [name, setName] = useState(session.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);


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
    'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs text-[var(--text-primary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-2)]';

  return (
    <ContextMenu
      x={position.x}
      y={position.y}
      onClose={onClose}
      className="rounded-[var(--radius-lg)] bg-[var(--elevated)] p-1 shadow-[var(--shadow-pop)]"
    >
      {confirmClose ? (
        <div className="px-2 py-2">
          <div className="mb-1 text-xs font-semibold text-[var(--text-primary)]">
            Close session?
          </div>
          <div className="mb-2 text-[11px] text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--orange)]">{session.process}</span> is still
            running — it will be terminated.
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmClose(false)}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onCloseSession();
                onClose();
              }}
              className="rounded bg-[var(--red)] px-2 py-1 text-[11px] text-[var(--text-inverted)] hover:opacity-90"
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
            className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
          />
        ) : (
          <div
            className="min-w-0 flex-1 truncate px-2 py-1 text-[11px] text-[var(--text-secondary)]"
            data-tip={sessionDisplayName(session)}
          >
            {(bulkIds?.length ?? 0) > 1 ? `${bulkIds!.length} sessions selected` : sessionDisplayName(session)}
          </div>
        )}
        {session.customName && (
          <button
            type="button"
            data-tip={t`Reset to process name`}
            aria-label="Reset to process name"
            onClick={resetName}
            className="shrink-0 rounded p-1 text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <BrushCleaning className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="my-1 h-px bg-[var(--hairline)]" />
      {!renaming && (bulkIds?.length ?? 0) > 1 && (
        <>
          {onBulkClose && (
            <button
              type="button"
              onClick={() => {
                onBulkClose(bulkIds!);
                onClose();
              }}
              className={itemClass}
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0" />
              {`Close ${bulkIds!.length} sessions`}
            </button>
          )}
          <div className="my-1 h-px bg-[var(--hairline)]" />
        </>
      )}
      {!renaming && (bulkIds?.length ?? 0) <= 1 && (
        <>
          <button type="button" onClick={() => setRenaming(true)} className={itemClass}>
            <Pencil className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">Rename…</span>
            <span
              className="shrink-0 pl-4 text-[11px] text-[var(--text-secondary)]"
              data-tip={t`Faster: F2 on the selected session, or double-click its name`}
            >
              <Trans>F2 · double-click</Trans>
            </span>
          </button>
        </>
      )}
      {(bulkIds?.length ?? 0) > 1 ? null : (
        <>
      <button
        type="button"
        onClick={() => {
          onClose();
          onEditSummary();
        }}
        className={itemClass}
      >
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <Trans>Edit summary…</Trans>
      </button>
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
      <button
        type="button"
        onClick={() => {
          onIde();
          onClose();
        }}
        className={itemClass}
      >
        <PanelLeft className="h-3.5 w-3.5 shrink-0" />
        IDE view
      </button>

      {onOpenBroadcastDeck && (
        <button
          type="button"
          onClick={() => {
            onOpenBroadcastDeck();
            onClose();
          }}
          className={itemClass}
        >
          <Radio className="h-3.5 w-3.5 shrink-0" />
          Broadcast deck
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
      {(pluginItems?.length ?? 0) > 0 && (
        <>
          <div className="my-1 h-px bg-[var(--hairline)]" />
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
      {onRequestMove && (
        <>
          <div className="my-1 h-px bg-[var(--hairline)]" />
          <button
            type="button"
            onClick={() => {
              onClose();
              onRequestMove();
            }}
            className={itemClass}
          >
            <MoveRight className="h-3.5 w-3.5 shrink-0" />
            <Trans>Move to workspace…</Trans>
          </button>
        </>
      )}
      {onMoveToNewWindow && (
        <>
          {!onRequestMove && <div className="my-1 h-px bg-[var(--hairline)]" />}
          <button
            type="button"
            onClick={() => {
              onClose();
              onMoveToNewWindow();
            }}
            className={itemClass}
          >
            <AppWindow className="h-3.5 w-3.5 shrink-0" />
            <Trans>Move to new window</Trans>
          </button>
        </>
      )}
      <div className="my-1 h-px bg-[var(--hairline)]" />
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
        className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-xs text-[var(--red)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-2)]"
      >
        <X className="h-3.5 w-3.5 shrink-0" />
        Close session
      </button>
        </>
      )}
      </>
      )}
    </ContextMenu>
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

export function resolvePluginIcon(plugin: { id: string; logo?: string }, bag: IconBag): string {
  // Declaring `logo` is the has-an-icon capability: without it a plugin
  // shows the generic Puzzle and the bag is not consulted.
  if (plugin.logo === undefined) return 'Puzzle';
  return resolveIcon(bag, plugin.id, plugin.logo);
}

/** A plugin's logo: `pluginIcons` override, else the declared `logo`, else a generic Puzzle. */
export function PluginIcon({
  plugin,
  className = 'h-4 w-4 shrink-0',
}: {
  plugin: { id: string; logo?: string };
  className?: string;
}) {
  const bag = useIconBag();
  return (
    <SessionIconGlyph
      value={resolvePluginIcon(plugin, bag)}
      className={className}
    />
  );
}

export function SessionIcon({
  process,
  className = 'h-4 w-4 shrink-0',
}: {
  process?: string;
  className?: string;
}) {
  const bag = useIconBag();
  return (
    <SessionIconGlyph
      value={resolveProcessIcon(process, bag)}
      className={className}
    />
  );
}

export function SessionItem({
  session,
  workspaces,
  isSelected,
  isMultiSel,
  suppressDetails,
  bulkIds,
  onBulkClose,
  onOpenSubShell,
  onTurnIntoWorkspace,
  taskState,
  onSelect,
  onRequestMove,
  onMoveToNewWindow,
  onRename,
  onDuplicate,
  onCloseSession,
  updateSession,
  mergePluginState,
  plugins,
  onOpenBrowser,
  onOpenIde,
  onOpenBroadcastDeck,
  onOpenTab,
  onAddSession,
  pluginData,
  mergePluginData,
  isDragging,
  dropBefore,
  searchQuery,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  session: ShellSession;
  workspaces: Workspace[];
  isSelected: boolean;
  /** Active panel filter — matched name substring is highlighted. */
  searchQuery?: string;
  taskState: TaskStateSnapshot | null;
  onSelect: (e: React.MouseEvent) => void;
  isMultiSel?: boolean;
  /** Collapse task/progress/summary details while a multi-selection is active. */
  suppressDetails?: boolean;
  /** Other multi-selected sessions when this row is in a multi-selection. */
  bulkIds?: string[];
  onBulkClose?: (ids: string[]) => void;
  /** Opens the "Move to workspace" picker for this session. */
  onRequestMove?: () => void;
  /** Moves this session into a new window; absent hides the menu row. */
  onMoveToNewWindow?: () => void;
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
  onOpenIde: (sessionId: string, path: string) => void;
  onOpenBroadcastDeck?: () => void;
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
  const { services } = useShellServices();
  const broadcastMarked = useBroadcastMarked(session.id);
  // A lone selection isn't "broadcasting" — badge shows only with ≥2 targets.
  const broadcastActive = useBroadcastSet().length > 1;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition>({ x: 0, y: 0 });
  // Summary editor modal — `summaryWidth` snapshots the row's width so the
  // modal's editing column wraps exactly like the panel's clamped render.
  const [summaryEdit, setSummaryEdit] = useState(false);
  const [summaryWidth, setSummaryWidth] = useState<number | undefined>(undefined);
  // Inline rename: double-click on the name, the hover pencil, or F2 on the
  // selected session (only while focus is outside terminals and text fields,
  // so TUI programs keep their F2). Same semantics as the context menu: an
  // empty name clears the override back to the process-reported name.
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCancelled = useRef(false);
  const startRename = useCallback(() => {
    renameCancelled.current = false;
    setRenameValue(session.customName ?? session.name);
    setRenaming(true);
  }, [session.customName, session.name]);
  const commitRename = () => {
    if (renameCancelled.current) return;
    renameCancelled.current = true;
    const trimmed = renameValue.trim();
    if (trimmed ? trimmed !== session.name : session.customName) onRename(trimmed);
    setRenaming(false);
  };
  const cancelRename = () => {
    renameCancelled.current = true;
    setRenaming(false);
  };
  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);
  useEffect(() => {
    if (!isSelected) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isRenameShortcut(e) || isTextEntryTarget(e.target)) return;
      e.preventDefault();
      startRename();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSelected, startRename]);
  const itemRef = useRef<HTMLDivElement>(null);
  const taskListRef = useRef<HTMLUListElement | null>(null);
  const [taskListMaxHeight, setTaskListMaxHeight] = useState<number | undefined>(undefined);
  const { pluginSettings } = usePluginSettings();
  const { settings } = useSettings();
  const attention = summarizeAttention(sessionAttention(session, plugins));
  const attentionColor = attention?.level === 'warning' ? 'var(--orange)' : 'var(--attention)';
  const metaLine = sessionMetaLine(session, attention?.title);
  const { t } = useLingui();
  const { onContextMenu, onMouseDown, onMouseUp, onMouseLeave, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, wrapClick } =
    useContextMenuTrigger((pos) => {
      setMenuPos(pos);
      setMenuOpen(true);
    });

  useLayoutEffect(() => {
    if (taskListRef.current) {
      setTaskListMaxHeight(Math.min(taskListRef.current.scrollHeight, 384));
    }
  }, [taskState?.tasks]);

  // Assemble the card from session fields: plugins only provide them
  // (`sessionFields`); where each shows — title row, always-visible rows,
  // the selected card — comes from the `sessionCard` layout setting.
  const fieldMetas: FieldMeta[] = [...CORE_FIELDS];
  const pluginFieldValues = new Map<string, { value: () => ReactNode; tip?: () => string | string[] | null }>();
  for (const plugin of plugins) {
    const fields = pluginSessionFields(plugin);
    if (fields.length === 0) continue;
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
    for (const field of fields) {
      const id = `${plugin.id}.${field.id}`;
      fieldMetas.push({ id, label: field.label, kind: field.kind, zone: field.zone });
      pluginFieldValues.set(id, {
        value: () => field.value(api),
        tip: field.tip ? () => field.tip!(api) : undefined,
      });
    }
  }
  const layout = resolveCardLayout(parseCardLayout(settings.sessionCard), fieldMetas);

  const coreValue = (id: string): ReactNode => {
    switch (id) {
      case 'core.name':
        return (
          <>
            <span className="min-w-0 flex-1 truncate font-semibold">
              <Highlight text={sessionDisplayName(session)} query={searchQuery ?? ''} />
            </span>
            {broadcastMarked && broadcastActive && (
              <span className="flex shrink-0" data-tip="broadcast target — receives axn-broadcast">
                <Radio className="h-3 w-3 text-[var(--accent)]" />
              </span>
            )}
          </>
        );
      case 'core.status':
        return (
          session.status &&
            (session.status === 'running' && (session.progress ?? 0) > 0 ? (
              <span
                className="flex shrink-0 items-center gap-1.5"
                data-tip={`running — ${session.progress}%`}
              >
                <span className="h-1 w-10 overflow-hidden rounded-full bg-[var(--fill-2)]">
                  <span
                    className="block h-full rounded-full transition-all"
                    style={{
                      width: `${session.progress}%`,
                      backgroundColor: statusColor.running,
                    }}
                  />
                </span>
                <span className="text-[11px] tabular-nums" style={{ color: statusColor.running }}>
                  {session.progress}%
                </span>
              </span>
            ) : (
              <span
                className="shrink-0 text-[11px] uppercase tracking-wide"
                style={{ color: statusColor[session.status] }}
              >
                {statusLabel[session.status]}
              </span>
            ))
        );
      case 'core.summary':
        return session.summary && settings.sessionSummaries !== false ? (
          <div
            className="line-clamp-3 whitespace-pre-line break-words pl-[30px] text-[11px] leading-[15px] text-[var(--text-secondary)]"
            data-tip={session.summary}
          >
            {session.summary}
          </div>
        ) : null;
      case 'core.process':
        return session.process ? (
          <p className="mb-2 text-[11px] text-[var(--text-secondary)]">
            process: <span className="text-[var(--text-primary)]">{session.process}</span>
          </p>
        ) : null;
      case 'core.tasks':
        return (
          taskState && taskState.tasks.length > 0 && (
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
                    <span
                      className={`min-w-0 break-words${task.status === 'completed' ? ' line-through text-[var(--text-secondary)]' : ''}`}
                    >
                      {task.title}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )
        );
      case 'core.progress':
        return (
          ((taskState?.tasks?.length ?? 0) > 0 ||
            (session.tasks ?? []).length > 0 ||
            (session.progress ?? 0) > 0) && (
            <div>
              <div className="mb-0.5 flex justify-between text-[11px] text-[var(--text-secondary)]">
                <span>progress</span>
                <span>{session.progress}%</span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--fill-2)]">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${session.progress}%`,
                    backgroundColor: session.status
                      ? statusColor[session.status]
                      : 'var(--text-secondary)',
                  }}
                />
              </div>
            </div>
          )
        );
      default:
        return null;
    }
  };
  // Tips of plugin fields actually shown, for the card tooltip.
  const rowTips: string[] = [];
  const valueOf = (id: string): ReactNode => {
    if (id.startsWith('core.')) return coreValue(id);
    const field = pluginFieldValues.get(id);
    if (!field) return null;
    const node = field.value();
    if (node === null || node === undefined || node === false) return null;
    const tip = field.tip?.();
    if (tip) rowTips.push(...(Array.isArray(tip) ? tip : [tip]));
    return node;
  };
  /** One layout row: a lone field as-is, several `·`-joined. */
  const renderRow = (row: string[], key: string) => {
    const parts = row
      .map((id) => ({ id, node: valueOf(id) }))
      .filter((p) => p.node !== null && p.node !== undefined && p.node !== false);
    if (parts.length === 0) return null;
    if (parts.length === 1) return <div key={key}>{parts[0].node}</div>;
    return (
      <div key={key} className="flex flex-wrap items-center gap-1 text-[11px] text-[var(--text-secondary)]">
        {parts.map((p, i) => (
          <Fragment key={p.id}>
            {i > 0 && <span aria-hidden>·</span>}
            {p.node}
          </Fragment>
        ))}
      </div>
    );
  };
  // Title-zone plugin fields (worktree badge, persona, MR ref…) sit in the
  // title row where the legacy renderRow badges did; core.name/core.status
  // are the row's own chrome (rename field + name, status indicators) and
  // render natively below.
  const badgeNodes = layout.title
    .filter((id) => id !== 'core.name' && id !== 'core.status')
    .map((id) => <Fragment key={id}>{valueOf(id)}</Fragment>);
  const alwaysRows = layout.always.map((row, i) => renderRow(row, `a${i}`)).filter(Boolean);
  const selectedRows =
    isSelected && !suppressDetails
      ? layout.selected.map((row, i) => renderRow(row, `s${i}`)).filter(Boolean)
      : [];

  return (
    <>
      <div
        ref={itemRef}
        onClick={(e) => onSelect(e)}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`relative cursor-pointer rounded-[var(--radius-md)] transition-colors duration-[var(--dur-1)] ${
          isSelected
            ? 'bg-[var(--fill-1)] shadow-[inset_0_0_0_1px_var(--hairline)]'
            : isMultiSel
              ? 'bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_40%,transparent)]'
              : 'hover:bg-[var(--fill-1)]'
        }${isDragging ? ' opacity-40' : ''}${dropBefore ? ` before:absolute before:-top-px before:left-0 before:right-0 before:h-[3px] before:rounded-full before:bg-[var(--accent)] before:content-['']` : ''}`}
        data-tip={[sessionDisplayName(session), ...rowTips].join('\n')}
      >
        <div
          draggable={!renaming}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onContextMenu={onContextMenu}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseLeave}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchCancel}
          onClick={wrapClick()}
          className={`group/row flex min-h-8 items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-[13px] text-[var(--text-primary)]${
            isSelected ? ' bg-[var(--fill-accent)]' : ''
          }`}
        >
          {/* Icon tile — tinted while selected, coloured (with a soft halo)
              while the session needs attention. */}
          <span
            className={`relative flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] ${
              attention
                ? ''
                : isSelected
                  ? 'bg-[color-mix(in_srgb,var(--accent)_22%,transparent)] text-[var(--accent)]'
                  : 'bg-[var(--fill-1)] text-[var(--text-secondary)]'
            }`}
            style={
              attention
                ? {
                    color: attentionColor,
                    backgroundColor: `color-mix(in srgb, ${attentionColor} 16%, transparent)`,
                  }
                : undefined
            }
            data-tip={attention?.title}
          >
            {attention && (
              <AttentionDot
                level={attention.level}
                className="absolute -inset-[3px] rounded-[9px]"
              />
            )}
            <span className="relative flex">
              <SessionIcon process={session.process} className="h-3.5 w-3.5 shrink-0" />
            </span>
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            {renaming ? (
              <input
                ref={renameInputRef}
                type="text"
                aria-label={t`Rename session`}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') cancelRename();
                }}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                className="min-w-0 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--bg)] px-1 text-[13px] font-medium leading-[18px] text-[var(--text-primary)] outline-none"
              />
            ) : (
              <span
                className="truncate font-medium leading-[18px]"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRename();
                }}
              >
                <Highlight text={sessionDisplayName(session)} query={searchQuery ?? ''} />
              </span>
            )}
            {metaLine && (
              <span
                className="truncate text-[11px] leading-[15px] text-[var(--text-secondary)]"
                style={attention ? { color: `color-mix(in srgb, ${attentionColor} 78%, var(--text-primary))` } : undefined}
              >
                {metaLine}
              </span>
            )}
          </span>
          {!renaming && (
            <button
              type="button"
              aria-label={t`Session actions`}
              aria-haspopup="menu"
              data-tip={t`Session actions`}
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                setMenuPos({ x: r.left, y: r.bottom + 2 });
                setMenuOpen(true);
              }}
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-secondary)] transition-opacity duration-[var(--dur-1)] hover:bg-[var(--fill-2)] hover:text-[var(--text-primary)] focus-visible:opacity-100 ${
                menuOpen ? 'opacity-100' : isSelected ? 'opacity-60' : 'opacity-0 group-hover/row:opacity-60'
              }`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          )}
          {broadcastMarked && broadcastActive && (
            <span className="flex shrink-0" data-tip="broadcast target — receives axn-broadcast">
              <Radio className="h-3 w-3 text-[var(--accent)]" />
            </span>
          )}
          {badgeNodes}
          {attention?.level === 'critical' && (
            <span className="shrink-0 rounded-full bg-[var(--fill-attention)] px-1.5 text-[10px] font-semibold leading-[17px] text-[color-mix(in_srgb,var(--attention)_82%,var(--text-primary))]">
              {t`Needs you`}
            </span>
          )}
          {/* Status: idle shows nothing — the default state stays quiet. */}
          {session.status === 'running' && (session.progress ?? 0) > 0 ? (
            <span
              className="flex shrink-0 items-center gap-1.5"
              data-tip={`running — ${session.progress}%`}
            >
              <span className="h-1 w-10 overflow-hidden rounded-full bg-[var(--fill-2)]">
                <span
                  className="block h-full rounded-full transition-all"
                  style={{
                    width: `${session.progress}%`,
                    backgroundColor: statusColor.running,
                  }}
                />
              </span>
              <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">
                {session.progress}%
              </span>
            </span>
          ) : session.status === 'running' && !attention ? (
            // A session that needs attention already says so — no second marker.
            <span
              className="mr-1 h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--green)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--green)_20%,transparent)]"
              data-tip={statusLabel.running}
            />
          ) : session.status === 'blocked' ? (
            <span
              className="shrink-0 rounded-full px-2 text-[11px] font-semibold capitalize leading-[18px]"
              style={{
                color: statusColor.blocked,
                backgroundColor: `color-mix(in srgb, ${statusColor.blocked} 16%, transparent)`,
              }}
            >
              {statusLabel.blocked}
            </span>
          ) : session.status === 'completed' ? (
            <Check
              className="h-3.5 w-3.5 shrink-0"
              style={{ color: statusColor.completed, strokeWidth: 2.2 }}
              data-tip={statusLabel.completed}
            />
          ) : null}
        </div>

        {alwaysRows.length > 0 && (
          <div className="flex flex-col gap-1 px-2 pb-1.5 [&>div:empty]:hidden">{alwaysRows}</div>
        )}

        {selectedRows.length > 0 && (
          <div className="flex flex-col gap-2 px-2.5 pb-2 pt-1.5 text-xs leading-relaxed text-[var(--text-primary)] [&>div:empty]:hidden">
            {selectedRows}
          </div>
        )}
      </div>

      {menuOpen && (
        <SessionContextMenu
          session={session}
          bulkIds={bulkIds}
          onBulkClose={onBulkClose}
          onOpenBroadcastDeck={onOpenBroadcastDeck}
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
          onEditSummary={() => {
            // clientWidth excludes the row's border — exactly the width the
            // summary element renders at.
            setSummaryWidth(itemRef.current?.clientWidth);
            setSummaryEdit(true);
          }}
          onRequestMove={onRequestMove}
          onMoveToNewWindow={onMoveToNewWindow}
          onCloseSession={onCloseSession}
          onSubShell={() => onOpenSubShell(session.id)}
          onTurnIntoWorkspace={
            // Only offered when the session actually has sub-shell tabs.
            (session.editors ?? []).some((e) => e.kind === 'shell')
              ? () => onTurnIntoWorkspace(session.id)
              : undefined
          }
          onCopyPath={
            backend.getCwd
              ? () =>
                  void (async () => {
                    // The live shell's cwd — readable even while a program
                    // runs in the foreground (it is the shell's, not the
                    // program's). session.cwd is only a fallback snapshot.
                    const cwd =
                      (await backend.getCwd?.(ptyIdOf(session)).catch(() => null)) ?? session.cwd;
                    if (cwd) await services.copyText(cwd);
                  })()
              : undefined
          }
          onBrowse={() => {
            void (async () => {
              // The PTY's live cwd beats session.cwd, which is only refreshed
              // while the session is visible and can be stale.
              const cwd =
                (await backend.getCwd?.(ptyIdOf(session)).catch(() => null)) ??
                session.cwd ??
                (await platform.homeDir().catch(() => '/'));
              onOpenBrowser(session.id, cwd);
            })();
          }}
          onIde={() => {
            void (async () => {
              const cwd =
                (await backend.getCwd?.(ptyIdOf(session)).catch(() => null)) ??
                session.cwd ??
                (await platform.homeDir().catch(() => '/'));
              onOpenIde(session.id, cwd);
            })();
          }}
        />
      )}
      {summaryEdit && (
        <EditSessionSummaryModal
          session={session}
          width={summaryWidth}
          onSave={(summary) => {
            updateSession(session.id, { summary });
            setSummaryEdit(false);
          }}
          onCancel={() => setSummaryEdit(false)}
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
  onRequestMoveSession,
  onReorderWorkspace,
  onMoveWorkspace,
  onRenameSession,
  onDuplicateSession,
  onCloseSession,
  updateSession,
  mergePluginState,
  plugins,
  onOpenBrowser,
  onOpenIde,
  onOpenBroadcastDeck,
  onOpenTab,
  onOpenSubShell,
  onTurnIntoWorkspace,
  pluginData,
  mergePluginData,
  onMoveToNewWindow,
  onSessionDragStart,
  onSessionDragEnd,
  foreignDrag,
  onForeignDrop,
  appAttention,
  onShowAttention,
  hiddenStatusSources,
  onOpenPluginView,
}: SessionPanelProps) {
  const { t } = useLingui();
  const { settings } = useSettings();
  const [dragSessionId, setDragSessionId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    workspaceId: string;
    beforeSessionId: string | null;
  } | null>(null);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  // Session multiselect (Shift=range, Cmd/Ctrl=toggle) — a marking set for
  // bulk ops (close, broadcast) shown as an accent-tinted row.
  const multiSelIds = useBroadcastSet();
  const setMultiSelIds = (ids: Iterable<string>) => broadcastSet.replaceAll([...ids]);
  const selectAnchorRef = useRef<string | null>(null);
  const handleSessionSelect = useCallback(
    (e: React.MouseEvent, sessionId: string, workspaceId: string) => {
      const wsIds = sessions
        .filter((s) => s.workspaceId === workspaceId)
        .map((s) => s.id);
      if (e.shiftKey && selectAnchorRef.current) {
        if (wsIds.includes(selectAnchorRef.current)) {
          // Same-workspace range: anchor row through clicked row.
          const a = wsIds.indexOf(selectAnchorRef.current);
          const b = wsIds.indexOf(sessionId);
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setMultiSelIds(new Set(wsIds.slice(lo, hi + 1)));
        } else {
          // Cross-workspace Shift+click: no shared range — extend the
          // selection with the clicked session instead of resetting it.
          const next = new Set(multiSelIds);
          next.add(sessionId);
          setMultiSelIds(next);
        }
      } else if (e.metaKey || e.ctrlKey) {
        const next = new Set(multiSelIds);
        if (!next.delete(sessionId)) next.add(sessionId);
        setMultiSelIds(next);
        selectAnchorRef.current = sessionId;
      } else {
        if (!(multiSelIds.length === 1 && multiSelIds.includes(sessionId))) {
          setMultiSelIds(new Set([sessionId]));
        }
        selectAnchorRef.current = sessionId;
        onSelectSession(sessionId);
        onSelectWorkspace(workspaceId);
      }
    },
    [sessions, multiSelIds, onSelectSession, onSelectWorkspace],
  );
  // Index in the workspaces array the dragged workspace would land at.
  const [workspaceDropIndex, setWorkspaceDropIndex] = useState<number | null>(null);
  // Header filter — matched name substrings are highlighted in the rows.
  const [query, setQuery] = useState('');
  // Workspace whose default-folder modal is open.
  const [folderEdit, setFolderEdit] = useState<Workspace | null>(null);
  // Workspace whose defaultFolder failed the spawn-time check.
  const [folderError, setFolderError] = useState<Workspace | null>(null);
  const backend = useSessionBackend();
  const platform = useShellPlatform();
  const { pluginSettings } = usePluginSettings();
  const q = query.trim().toLowerCase();
  // uiZoom scales the whole panel; insets that must match unscaled window
  // chrome (the macOS traffic lights) are divided by it again.
  const uiScale = settings.uiZoom && settings.uiZoom > 0 ? settings.uiZoom / 100 : 1;
  // Footer summary — the counts that used to sit in the rail as "3/8".
  const runningCount = sessions.filter((s) => s.status === 'running' || !!s.process).length;
  // Sessions with a raised attention flag — counted in the toolbar's
  // "N waiting" indicator, which also filters the list down to them.
  const attentionIds = useMemo(
    () =>
      new Set(
        sessions
          .filter((s) => summarizeAttention(sessionAttention(s, plugins)) !== null)
          .map((s) => s.id),
      ),
    [sessions, plugins],
  );
  const attentionCount = attentionIds.size;
  const [attentionOnly, setAttentionOnly] = useState(false);
  // Nothing waits any more: drop the filter instead of showing an empty list.
  useEffect(() => {
    if (attentionCount === 0) setAttentionOnly(false);
  }, [attentionCount]);
  const filtering = q !== '' || attentionOnly;
  // Field-aware text match (name, branch, MR/Jira fields…) plus the
  // "only sessions that need you" gate when the waiting filter is on.
  const sessionVisible = (session: ShellSession) =>
    sessionMatches(session) && (!attentionOnly || attentionIds.has(session.id));

  // The open button's dropdown — the bare FolderOpen icon reads as "open a
  // folder", so the click opens labeled rows instead of a file dialog.
  const [openMenu, setOpenMenu] = useState<{ x: number; y: number } | null>(null);
  // Web folder pick for "New session in folder…" (desktop uses the native
  // platform.pickDirectory dialog).
  const [folderPickOpen, setFolderPickOpen] = useState(false);
  // Workspace awaiting delete confirmation — deleting kills its sessions.
  const [deleteConfirm, setDeleteConfirm] = useState<Workspace | null>(null);

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

  // New session in a workspace: the defaultFolder is only checked now, never
  // when it is set — a path that doesn't resolve to a directory raises the
  // invalid-folder modal (fix it, or open in the home folder) instead of a
  // dead terminal.
  const handleAddSession = (workspace: Workspace) => {
    const folder = workspace.defaultFolder?.trim();
    if (!folder) {
      onAddSession(workspace.id);
      return;
    }
    const rep = representativeSession(workspace) ?? sessions[0];
    const pty = rep ? ptyIdOf(rep) : undefined;
    if (!pty || !backend.statPath) {
      // No way to verify (no live session / backend can't stat) — attempt the
      // spawn; the terminal surfaces the failure as before.
      onAddSession(workspace.id, folder);
      return;
    }
    void backend
      .statPath(pty, '/', folder)
      .then((stat) => {
        if (stat?.isDir) onAddSession(workspace.id, stat.path);
        else setFolderError(workspace);
      })
      .catch(() => onAddSession(workspace.id, folder));
  };

  // Whether a session drag left the window — a drag that ends outside every
  // window tears the session off into a new one.
  const exitTrackerRef = useRef<ReturnType<typeof createDragExitTracker> | null>(null);

  const handleDragStart = (e: React.DragEvent, sessionId: string) => {
    e.dataTransfer.setData('application/x-axn-session', sessionId);
    e.dataTransfer.effectAllowed = 'move';
    setDragSessionId(sessionId);
    exitTrackerRef.current?.stop();
    exitTrackerRef.current = createDragExitTracker(document);
    exitTrackerRef.current.start();
    onSessionDragStart?.(sessionId);
  };

  const handleDragEnd = (e: React.DragEvent, sessionId: string) => {
    setDragSessionId(null);
    setDropTarget(null);
    const left = exitTrackerRef.current?.stop() ?? false;
    exitTrackerRef.current = null;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    onSessionDragEnd?.(sessionId, {
      dropEffect: e.dataTransfer?.dropEffect ?? 'none',
      outside: dragEndedOutside(e, viewport, left),
      placement: tearOffPlacement(e, viewport),
    });
  };

  // The session being dragged — one of ours, or one another window drags
  // over this panel.
  const activeDragId = dragSessionId ?? foreignDrag?.sessionId ?? null;
  useEffect(() => {
    if (!foreignDrag && !dragSessionId) setDropTarget(null);
  }, [foreignDrag, dragSessionId]);

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
    if (!activeDragId || activeDragId === beforeSessionId) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget({ workspaceId, beforeSessionId });
  };

  const handleWorkspaceDragOver = (e: React.DragEvent, workspaceId: string) => {
    if (!activeDragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget({ workspaceId, beforeSessionId: null });
  };

  const handleDrop = (
    e: React.DragEvent,
    workspaceId: string,
    beforeSessionId: string | null,
  ) => {
    if (!dragSessionId) {
      // A session dragged in from another window: ask it over.
      if (!foreignDrag || !onForeignDrop) return;
      e.preventDefault();
      e.stopPropagation();
      onForeignDrop(workspaceId, beforeSessionId);
      setDropTarget(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (dragSessionId !== beforeSessionId) {
      onMoveSession(dragSessionId, workspaceId, beforeSessionId);
    }
    setDragSessionId(null);
    setDropTarget(null);
  };

  const matchesFilter = (name: string) => name.toLowerCase().includes(q);
  // A session matches on what its card shows: its name (custom or
  // terminal-reported) and every placed session field whose plugin declares
  // a search string (branch, MR ref, Jira key, …) — see app/sessionSearch.ts.
  const sessionMatches = (() => {
    if (!q) return () => true;
    const placed = placedFieldIds(searchLayout(plugins, settings.sessionCard));
    const cache = new Map<string, boolean>();
    return (s: ShellSession) => {
      let hit = cache.get(s.id);
      if (hit === undefined) {
        hit = matchesTerms(
          sessionSearchTerms(
            s,
            plugins,
            placed,
            { sessionSummaries: settings.sessionSummaries !== false },
            (plugin) =>
              createPluginApi(s, plugin, {
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
          ),
          q,
        );
        cache.set(s.id, hit);
      }
      return hit;
    };
  })();
  // A workspace stays listed when its own name matches or it hosts a matching
  // session.
  const visibleWorkspaces = filtering
    ? workspaces.filter(
        (ws) =>
          // A matching workspace name only counts for the text filter.
          (q !== '' && !attentionOnly && matchesFilter(ws.name)) ||
          sessions.some((s) => s.workspaceId === ws.id && sessionVisible(s)),
      )
    : workspaces;

  // The session backend fs calls (listDir/statPath) are routed through:
  // the selected session, else the first — needed by the web folder picker.
  const pickSession =
    sessions.find((s) => s.id === selectedSessionId) ?? sessions[0];
  const canPickFolder = Boolean(platform.pickDirectory ?? (backend.listDir && pickSession));

  const handleNewSessionInFolder = () => {
    setOpenMenu(null);
    if (platform.pickDirectory) {
      void platform
        .pickDirectory()
        .then((dir) => {
          if (dir) onAddSession(undefined, dir);
        })
        .catch(() => {});
    } else {
      setFolderPickOpen(true);
    }
  };

  return (
    <div
      className="relative flex h-full w-full select-none flex-col bg-[var(--chrome)] [&_input]:select-text [&_textarea]:select-text"
      style={{ zoom: uiScale === 1 ? undefined : uiScale }}
    >
      {/* Hairline against the rail — starts below the title-bar row so it
          does not run through the macOS traffic lights. */}
      <div
        className="pointer-events-none absolute bottom-0 left-0 w-px bg-[var(--hairline)]"
        style={{ top: `calc(var(--titlebar-h) / ${uiScale})` }}
      />
      {/* Toolbar row. With the macOS overlay title bar the traffic lights
          reach past the rail into this row, so the actions start after
          them (--titlebar-overhang, counter-scaled like the rail's inset:
          the panel is zoomed, the lights are not). The empty part of the
          row is a window drag region. */}
      <div
        className="flex h-10 shrink-0 items-center justify-between gap-1 pr-2"
        style={{
          paddingLeft: `calc(var(--titlebar-overhang) / ${uiScale} + 0.5rem + var(--panel-toggle-w, 0px))`,
        }}
        data-tauri-drag-region
      >
        <div className="flex items-center gap-0.5">
          <AddWorkspaceButton onClick={onAddWorkspace} />
          <IconButton title={t`Save workspace set`} onClick={onSaveWorkspaceSet}>
            <Save className="h-4 w-4" />
          </IconButton>
          <IconButton
            title={t`Open…`}
            onClick={(e) => setOpenMenu({ x: e.clientX, y: e.clientY })}
          >
            <FolderOpen className="h-4 w-4" />
          </IconButton>
        </div>
        {/* Attention. "N waiting" counts the sessions that need the user
            and filters the list down to them (click again to clear). Flags
            that belong to no session get their own warning button, which
            opens the list of everything raised. */}
        <div className="flex min-w-0 items-center gap-1">
          {appAttention && appAttention.count > 0 && (
            <button
              type="button"
              onClick={onShowAttention}
              data-tip={appAttention.title}
              aria-label={appAttention.title.split('\n')[0]}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-1)]"
              style={{ color: appAttention.level === 'critical' ? 'var(--attention)' : 'var(--orange)' }}
            >
              <AlertTriangle className="h-4 w-4" />
            </button>
          )}
          {attentionCount > 0 && (
            <button
              type="button"
              onClick={() => setAttentionOnly((v) => !v)}
              aria-pressed={attentionOnly}
              data-tip={attentionOnly ? t`Show all sessions` : t`Show only sessions that need you`}
              className={`h-6 shrink-0 truncate rounded-full px-2 text-[11px] font-semibold tabular-nums transition-colors duration-[var(--dur-1)] ${
                attentionOnly
                  ? 'bg-[var(--attention)] text-white'
                  : 'bg-[var(--fill-attention)] text-[color-mix(in_srgb,var(--attention)_82%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--attention)_26%,transparent)]'
              }`}
            >
              {t`${attentionCount} waiting`}
            </button>
          )}
        </div>
      </div>
      <div className="flex shrink-0 px-2.5 pb-2">
        <PanelSearch value={query} onChange={setQuery} />
      </div>

      {/* panelFontSize scales the list only — the toolbar row must keep its
          native metrics to stay aligned with the window controls. */}
      <div
        className="flex-1 overflow-y-auto px-2 pb-2"
        style={{
          // Setting the VAR (not just fontFamily) makes the configured panel
          // font reach font-mono utility classes inside too — otherwise
          // font-family: var(--font-mono) on rows beats inherited styles and
          // the setting appears to do nothing. Unset -> theme --font-mono.
          // Only apply a font that exists — a config.yaml string that
          // resolves to nothing would render the whole panel in serif.
          ...((settings.panelFontFamily?.trim() &&
          fontStackAvailable(settings.panelFontFamily.trim())
            ? {
                '--font-mono': settings.panelFontFamily.trim(),
                fontFamily: settings.panelFontFamily.trim(),
              }
            : {}) as CSSProperties),
          zoom: settings.panelFontSize ? settings.panelFontSize / 12 : undefined,
        }}
      >
        {visibleWorkspaces.map((workspace, index) => {
          const workspaceSessions = sessions.filter(
            (s) => s.workspaceId === workspace.id && sessionVisible(s),
          );
          // A filter hides collapsed groups' content — force-expand while it
          // is active so matches stay visible.
          const isCollapsed = filtering ? false : (workspace.collapsed ?? false);

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
                  canMoveDown={index < visibleWorkspaces.length - 1}
                  isDragging={dragWorkspaceId === workspace.id}
                  onToggle={() => onToggleWorkspace(workspace.id)}
                  onAddSession={() => handleAddSession(workspace)}
                  onRename={(name) => onRenameWorkspace(workspace.id, name)}
                  onMove={(delta) => onMoveWorkspace(workspace.id, delta)}
                  onDelete={() => setDeleteConfirm(workspace)}
                  onEditDefaultFolder={() => setFolderEdit(workspace)}
                  onSetDefaultFolder={() => handleSetDefaultFolder(workspace)}
                  onClearDefaultFolder={() =>
                    updateWorkspace(workspace.id, { defaultFolder: undefined })
                  }
                  hasSession={representativeSession(workspace) !== undefined}
                  pluginItems={workspacePluginItems(workspace)}
                  searchQuery={q}
                  onDragStart={(e) => handleWorkspaceDragStart(e, workspace.id)}
                  onDragEnd={handleWorkspaceDragEnd}
                />

              {!isCollapsed && (
                <div className="mt-0.5 space-y-px">
                  {workspaceSessions.map((session) => {
                    const isSelected = session.id === selectedSessionId;
                    return (
                      <SessionItem
                        key={session.id}
                        session={session}
                        workspaces={workspaces}
                        isSelected={isSelected}
                        taskState={isSelected ? taskState : null}
                        isMultiSel={multiSelIds.includes(session.id)}
                        suppressDetails={multiSelIds.length > 1}
                        bulkIds={
                          multiSelIds.length > 1 && multiSelIds.includes(session.id)
                            ? [...multiSelIds]
                            : undefined
                        }
                        onBulkClose={(ids) => ids.forEach((id) => onCloseSession(id))}
                        onSelect={(e) => handleSessionSelect(e, session.id, workspace.id)}
                        onRequestMove={
                          onRequestMoveSession ? () => onRequestMoveSession(session.id) : undefined
                        }
                        onMoveToNewWindow={
                          onMoveToNewWindow && sessions.length > 1
                            ? () => onMoveToNewWindow(session.id)
                            : undefined
                        }
                        onRename={(name) => onRenameSession(session.id, name)}
                        onDuplicate={() => onDuplicateSession(session.id)}
                        onCloseSession={() => onCloseSession(session.id)}
                        updateSession={updateSession}
                        mergePluginState={mergePluginState}
                        plugins={plugins}
                        onOpenBrowser={onOpenBrowser}
                        onOpenIde={onOpenIde}
                        onOpenBroadcastDeck={
                          onOpenBroadcastDeck
                            ? () => onOpenBroadcastDeck(session.id)
                            : undefined
                        }
                        onOpenTab={onOpenTab}
                        onOpenSubShell={onOpenSubShell}
                        onAddSession={onAddSession}
                        onTurnIntoWorkspace={onTurnIntoWorkspace}
                        pluginData={pluginData}
                        mergePluginData={mergePluginData}
                        isDragging={dragSessionId === session.id}
                        searchQuery={q}
                        dropBefore={
                          dropTarget?.beforeSessionId === session.id &&
                          dropTarget.workspaceId === workspace.id
                        }
                        onDragStart={(e) => handleDragStart(e, session.id)}
                        onDragEnd={(e) => handleDragEnd(e, session.id)}
                        onDragOver={(e) =>
                          handleSessionDragOver(e, workspace.id, session.id)
                        }
                        onDrop={(e) => handleDrop(e, workspace.id, session.id)}
                      />
                    );
                  })}
                  {workspaceSessions.length === 0 && q && (
                    <div className="px-2 py-1 text-xs text-[var(--text-tertiary)]">
                      No matching sessions
                    </div>
                  )}
                  {/* Ghost append row — the "add at the end" affordance
                      lives where the new session lands. Always faintly
                      visible: a hover-revealed button stays undiscovered.
                      Hidden while filtering, inside collapsed blocks, and
                      when newSessionButton moves the affordance to the
                      workspace header. */}
                  {!filtering && (settings.newSessionButton ?? 'both') !== 'header' && (
                    <button
                      type="button"
                      onClick={() => handleAddSession(workspace)}
                      className="flex h-7 w-full items-center gap-2 rounded-[var(--radius-md)] px-2 text-left text-xs text-[var(--text-tertiary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-1)] hover:text-[var(--text-primary)]"
                    >
                      <span className="flex w-[22px] shrink-0 justify-center">
                        <Plus className="h-3.5 w-3.5" />
                      </span>
                      <Trans>New session</Trans>
                    </button>
                  )}
                </div>
              )}
              </div>
            </Fragment>
          );
        })}
        {dragWorkspaceId && workspaceDropIndex === visibleWorkspaces.length && (
          <div className="h-0.5 rounded-full bg-[var(--accent)]" />
        )}
        {filtering && visibleWorkspaces.length === 0 && (
          <div className="px-2 py-1 text-xs text-[var(--text-tertiary)]">No matches</div>
        )}
      </div>

      {/* The status stack: one accordion per rail tool with statistics
          (rail order) and, last, "System" with the machine's own metrics.
          Which ones are open is kept with the window, like the rail order.
          It scrolls on its own beyond ~40% of the panel, so the session
          list keeps its room. Hidden while nothing is published. */}
      <PanelStatusSection
        hiddenSources={hiddenStatusSources}
        viewSources={
          onOpenPluginView ? plugins.filter((p) => p.renderView).map((p) => p.id) : undefined
        }
        onOpenView={onOpenPluginView}
        systemExpanded={storedSystemExpanded(pluginData)}
        onToggleSystem={() =>
          mergePluginData(PANEL_UI_KEY, { systemExpanded: !storedSystemExpanded(pluginData) })
        }
        expandedGroups={storedExpandedGroups(pluginData)}
        onToggleGroup={(source) =>
          mergePluginData(PANEL_UI_KEY, {
            expandedGroups: toggleExpandedGroup(storedExpandedGroups(pluginData), source),
          })
        }
        sourceOrder={[
          ...plugins.filter((p) => p.renderRail && p.pinned),
          ...orderRailPlugins(plugins.filter((p) => p.renderRail && !p.pinned), pluginData),
        ].map((p) => p.id)}
        renderIcon={({ source, group }) => {
          // The plugin's own icon (it follows the user's icon overrides)
          // when it declares one, else the icon the group names.
          const plugin = plugins.find((p) => p.id === source);
          return plugin?.logo !== undefined ? (
            <PluginIcon plugin={plugin} className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <SessionIconGlyph value={group.icon ?? 'Puzzle'} className="h-3.5 w-3.5 shrink-0" />
          );
        }}
      />

      {/* Summary: how many sessions and how many are busy (the count that
          used to sit in the rail). Label-then-number avoids plural forms. */}
      <div className="flex h-8 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap px-3.5 text-[11px] tabular-nums text-[var(--text-tertiary)] shadow-[inset_0_1px_0_var(--hairline)]">
        <span>
          <Trans>Sessions</Trans> {sessions.length}
        </span>
        {runningCount > 0 && (
          <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--green)]" />
            <Trans>Running</Trans> {runningCount}
          </span>
        )}
      </div>

      {folderEdit && (
        <SetDefaultFolderModal
          workspace={folderEdit}
          onCancel={() => setFolderEdit(null)}
          onSave={(path) => {
            updateWorkspace(folderEdit.id, { defaultFolder: path || undefined });
            setFolderEdit(null);
          }}
        />
      )}
      {folderError && (
        <InvalidDefaultFolderModal
          workspace={folderError}
          onCancel={() => setFolderError(null)}
          onFix={() => {
            setFolderEdit(folderError);
            setFolderError(null);
          }}
          onOpenHome={() => {
            onAddSession(folderError.id);
            setFolderError(null);
          }}
        />
      )}
      {openMenu && (
        <ContextMenu
          x={openMenu.x}
          y={openMenu.y}
          onClose={() => setOpenMenu(null)}
          // Fit-to-content width (still floored/capped) — the default w-56
          // truncates "Open workspace set from file…".
          widthClass="w-fit min-w-56 max-w-80"
        >
          <button
            type="button"
            className={menuItemClass}
            data-tip={t`Open a saved workspace set file`}
            onClick={() => {
              setOpenMenu(null);
              void onLoadWorkspaceSet();
            }}
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              <Trans>Open workspace set from file…</Trans>
            </span>
          </button>
          {canPickFolder && (
            <button
              type="button"
              className={menuItemClass}
              data-tip={t`Pick a folder — the new session starts in it`}
              onClick={handleNewSessionInFolder}
            >
              <FolderPlus className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                <Trans>New session in folder…</Trans>
              </span>
            </button>
          )}
        </ContextMenu>
      )}
      {deleteConfirm && (
        <DeleteWorkspaceModal
          workspace={deleteConfirm}
          sessions={sessions.filter((s) => s.workspaceId === deleteConfirm.id)}
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={() => {
            onDeleteWorkspace(deleteConfirm.id);
            setDeleteConfirm(null);
          }}
        />
      )}
      {folderPickOpen && pickSession && (
        <FilePickerModal
          mode="dir"
          sessionId={ptyIdOf(pickSession)}
          onPick={(dir) => {
            onAddSession(undefined, dir);
            setFolderPickOpen(false);
          }}
          onCancel={() => setFolderPickOpen(false)}
        />
      )}
    </div>
  );
}
