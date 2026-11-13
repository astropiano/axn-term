import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { FolderOpen, Plus, Save } from 'lucide-react';
import { IconButton } from './IconButton';
import { Banner } from './Banner';
import { PanelSearch } from './SessionPanel';
import { SessionTabStrip } from './SessionTabStrip';
import { StoryShellProviders } from './storyMocks';
import type { EditorTab } from '../types';

const tabs: EditorTab[] = [
  { id: 't1', path: '/repo/axn-term', kind: 'browser' },
  { id: 't2', path: 'sh', kind: 'shell', command: 'sh' },
];

/**
 * The chrome strips side by side — session-panel toolbar (buttons, then the
 * filter row), plugin banner and session tab strip — all borderless, on the
 * shared design tokens (styles.css).
 */
function Strips() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('shell');
  return (
    <div className="flex flex-col gap-4">
      <div className="w-96 min-w-40 resize-x overflow-hidden outline outline-1 -outline-offset-1 outline-[var(--border)]">
        <div className="bg-[var(--chrome)]">
          <div className="flex h-10 shrink-0 items-center gap-0.5 px-2">
            <IconButton title="New workspace" onClick={() => {}}>
              <Plus className="h-4 w-4" />
            </IconButton>
            <IconButton title="Save workspace set" onClick={() => {}}>
              <Save className="h-4 w-4" />
            </IconButton>
            <IconButton title="Open…" onClick={() => {}}>
              <FolderOpen className="h-4 w-4" />
            </IconButton>
          </div>
          <div className="flex px-2.5 pb-2">
            <PanelSearch value={query} onChange={setQuery} />
          </div>
        </div>
      </div>
      <div className="w-[560px] min-w-40 resize-x overflow-hidden outline outline-1 -outline-offset-1 outline-[var(--border)]">
        <Banner
          level="warning"
          message="devin is running in the main checkout — isolate it in a worktree?"
          actions={[{ id: 'isolate', label: 'New worktree session' }]}
          trailingActions={[{ id: 'never', label: "Don't ask again" }]}
          onAction={() => {}}
          onDismiss={() => {}}
        />
        <SessionTabStrip
          editors={tabs}
          activeTab={active}
          onSelect={setActive}
          onTabMenu={() => {}}
          onReorder={() => {}}
          onCloseTab={() => {}}
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'app/PanelHeader',
  component: Strips,
  decorators: [
    (Story) => (
      <StoryShellProviders>
        <Story />
      </StoryShellProviders>
    ),
  ],
} satisfies Meta<typeof Strips>;

export default meta;
export const Aligned: StoryObj<typeof meta> = {};
