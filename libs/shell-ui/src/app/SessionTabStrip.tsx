import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Eye, FileText, Folder, GitBranch, SquareTerminal, Terminal, X } from 'lucide-react';
import type { EditorTab } from '../types';
import { defaultTabLabel } from './subshellPromote';
import { useSettings } from '../SettingsProvider';
import { tabStripTabClasses } from './tabStyles';

/**
 * A session's tab strip: `shell` pinned leftmost, then its sub-view tabs —
 * drag-and-drop reorderable, right-click for the tab menu. A sub-shell tab
 * whose agent reports hook status shows it as a dot (red pulsing: blocked),
 * and its on-screen task list as done/total (the list in the tooltip).
 */
export function SessionTabStrip({
  editors,
  activeTab,
  onSelect,
  onTabMenu,
  onReorder,
  onCloseTab,
}: {
  editors: EditorTab[];
  activeTab: string;
  onSelect: (tabId: string) => void;
  onTabMenu: (tab: EditorTab, x: number, y: number) => void;
  onReorder: (dragId: string, targetId: string) => void;
  onCloseTab: (tabId: string) => void;
}) {
  const { t } = useLingui();
  const [tabDragId, setTabDragId] = useState<string | null>(null);
  const [tabDropId, setTabDropId] = useState<string | null>(null);
  const { settings } = useSettings();
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-secondary)] px-1"
      style={{ zoom: settings.uiZoom ? settings.uiZoom / 100 : undefined }}
    >
      <button
        type="button"
        onClick={() => onSelect('shell')}
        data-tip={t`Shell`}
        className={`relative flex shrink-0 items-center gap-1.5 px-2 text-[11px] transition ${tabStripTabClasses(
          activeTab === 'shell',
        )}`}
      >
        <SquareTerminal className="h-3.5 w-3.5" />
        {t`shell`}
      </button>
      {editors.map((ed) => (
        <div
          key={ed.id}
          onContextMenu={(e) => {
            e.preventDefault();
            onTabMenu(ed, e.clientX, e.clientY);
          }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-axn-tab', ed.id);
            e.dataTransfer.effectAllowed = 'move';
            setTabDragId(ed.id);
          }}
          onDragEnd={() => {
            setTabDragId(null);
            setTabDropId(null);
          }}
          onDragOver={(e) => {
            if (!tabDragId || tabDragId === ed.id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setTabDropId(ed.id);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (tabDragId && tabDragId !== ed.id) {
              onReorder(tabDragId, ed.id);
            }
            setTabDragId(null);
            setTabDropId(null);
          }}
          className={`relative flex shrink-0 items-center pl-2 pr-1 text-[11px] transition ${tabStripTabClasses(
            activeTab === ed.id,
          )}${tabDragId === ed.id ? ' opacity-40' : ''}${
            tabDropId === ed.id && tabDragId !== ed.id
              ? ' shadow-[inset_2px_0_0_var(--accent)]'
              : ''
          }`}
        >
          <button
            type="button"
            onClick={() => onSelect(ed.id)}
            data-tip={
              ed.kind === 'shell'
                ? (ed.label ?? defaultTabLabel(ed))
                : ed.path
            }
            className="flex items-center gap-1.5"
          >
            {ed.kind === 'browser' ? (
              <Folder className="h-3.5 w-3.5" />
            ) : ed.kind === 'shell' ? (
              <Terminal className="h-3.5 w-3.5" />
            ) : ed.kind === 'preview' ? (
              <Eye className="h-3.5 w-3.5" />
            ) : ed.kind === 'git' ? (
              <GitBranch className="h-3.5 w-3.5" />
            ) : (
              <FileText className="h-3.5 w-3.5" />
            )}
            <span className="max-w-40 truncate">
              {ed.kind === 'shell'
                ? (ed.label ?? defaultTabLabel(ed))
                : ed.path.split('/').pop() || ed.path}
            </span>
            {ed.dirty && (
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--orange)]" />
            )}
            {ed.kind === 'shell' && (ed.tasks?.length ?? 0) > 0 && (
            <span
              data-tip={ed.tasks!.map((t) => `${t.done ? '✓' : '•'} ${t.title}`).join('\n')}
              className="font-mono text-[10px] text-[var(--text-secondary)]"
            >
              {ed.tasks!.filter((t) => t.done).length}/{ed.tasks!.length}
            </span>
          )}
          {ed.kind === 'shell' && ed.hookStatus && ed.hookStatus !== 'idle' && (
              <span
                data-tip={ed.hookAttention?.message ?? ed.hookStatus}
                className={`h-1.5 w-1.5 rounded-full ${
                  ed.hookStatus === 'blocked'
                    ? 'animate-pulse bg-[var(--red)]'
                    : ed.hookStatus === 'running'
                      ? 'bg-[var(--blue)]'
                      : 'bg-[var(--green)]'
                }`}
              />
            )}
          </button>
          <button
            type="button"
            onClick={() => onCloseTab(ed.id)}
            data-tip="Close tab"
            aria-label="Close tab"
            className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--red)]"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
