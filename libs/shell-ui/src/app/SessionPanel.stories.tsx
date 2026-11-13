import type { Meta, StoryObj } from '@storybook/react-vite';
import { SessionItem, SessionPanel } from './SessionPanel';
import { StoryShellProviders } from './storyMocks';
import type { SessionAttention, ShellSession } from '../types';
import type { SessionViewPlugin } from './session-plugins/plugin';

// Stub plugin objects — SessionItem only needs id/stateKey to read attention
// flags (and session fields if provided) from session.pluginState.
const devinStub: SessionViewPlugin = { id: 'devin', title: 'devin', stateKey: 'devin' };
const gitStub: SessionViewPlugin = { id: 'git-status', title: 'git', stateKey: 'gitStatus' };

function attentionPluginState(
  key: string,
  attention: SessionAttention,
): ShellSession['pluginState'] {
  return { [key]: { attention } };
}

function Row({ session, plugins = [] }: { session: ShellSession; plugins?: SessionViewPlugin[] }) {
  return (
    <div className="w-64">
      <SessionItem
        session={session}
        workspaces={[{ id: 'w1', name: 'main' }]}
        isSelected={false}
        taskState={null}
        onSelect={() => {}}
        onMove={() => {}}
        onRename={() => {}}
        onDuplicate={() => {}}
        onCloseSession={() => {}}
        onOpenSubShell={() => {}}
        onTurnIntoWorkspace={() => {}}
        updateSession={() => {}}
        mergePluginState={() => {}}
        plugins={plugins}
        onOpenBrowser={() => {}}
        onOpenTab={() => {}}
        pluginData={{}}
        mergePluginData={() => {}}
        isDragging={false}
        dropBefore={false}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onDragOver={() => {}}
        onDrop={() => {}}
      />
    </div>
  );
}

const meta = {
  title: 'app/SessionItem',
  component: Row,
  decorators: [
    (Story) => (
      <StoryShellProviders>
        <Story />
      </StoryShellProviders>
    ),
  ],
} satisfies Meta<typeof Row>;

export default meta;
type Story = StoryObj<typeof meta>;

const baseSession: ShellSession = {
  id: 's1',
  workspaceId: 'w1',
  name: 'axn-term · devin',
  topic: '',
  summary: '',
  tasks: [],
  progress: 0,
  output: '',
  process: 'devin',
  status: 'running',
};

export const Plain: Story = {
  args: { session: baseSession },
};

export const WarningAttention: Story = {
  args: {
    session: {
      ...baseSession,
      pluginState: attentionPluginState('devin', {
        level: 'warning',
        message: 'quiet for 45s — possibly finished',
      }),
    },
    plugins: [devinStub],
  },
};

export const CriticalAttention: Story = {
  args: {
    session: {
      ...baseSession,
      pluginState: attentionPluginState('devin', {
        level: 'critical',
        message: 'quiet for 45s — likely waiting for input',
      }),
    },
    plugins: [devinStub],
  },
};

/** Two plugins flagging the same session — worst level wins in the tooltip. */
export const MultipleSources: Story = {
  args: {
    session: {
      ...baseSession,
      pluginState: {
        devin: { attention: { level: 'warning', message: 'quiet for 45s' } },
        gitStatus: { attention: { level: 'critical', message: 'rebase conflict' } },
      },
    },
    plugins: [devinStub, gitStub],
  },
};

export const IdleSession: Story = {
  args: {
    session: { ...baseSession, process: undefined, status: 'idle', name: 'scratch shell' },
  },
};

/**
 * The whole panel including the header row (new workspace / save / load
 * workspace set buttons) — same h-8 height as the shell tab strip.
 */
export const Panel: Story = {
  args: { session: baseSession }, // required by the Row meta; render ignores it
  render: () => (
    <div className="h-96 w-64 overflow-hidden border border-[var(--border)]">
      <SessionPanel
        workspaces={[
          { id: 'w1', name: 'main' },
          { id: 'w2', name: 'scratch', collapsed: true },
        ]}
        sessions={[
          baseSession,
          {
            ...baseSession,
            id: 's2',
            name: 'scratch shell',
            process: undefined,
            status: 'idle',
            pluginState: {
              devin: {
                banner: { level: 'error', message: 'Could not restore devin session' },
              },
            },
          },
          { ...baseSession, id: 's3', workspaceId: 'w2', name: 'other workspace' },
        ]}
        selectedSessionId="s1"
        taskState={null}
        onSelectWorkspace={() => {}}
        onSelectSession={() => {}}
        onAddWorkspace={() => {}}
        onSaveWorkspaceSet={() => {}}
        onLoadWorkspaceSet={() => {}}
        onRenameWorkspace={() => {}}
        onDeleteWorkspace={() => {}}
        onToggleWorkspace={() => {}}
        onAddSession={() => {}}
        onMoveSession={() => {}}
        onReorderWorkspace={() => {}}
        onMoveWorkspace={() => {}}
        onRenameSession={() => {}}
        onDuplicateSession={() => {}}
        onCloseSession={() => {}}
        updateSession={() => {}}
        mergePluginState={() => {}}
        plugins={[devinStub, gitStub]}
        onOpenBrowser={() => {}}
        onOpenTab={() => {}}
        pluginData={{}}
        mergePluginData={() => {}}
        onOpenSubShell={() => {}}
        onTurnIntoWorkspace={() => {}}
      />
    </div>
  ),
};

/**
 * Full panel with several workspaces and sessions in mixed states — running,
 * idle, attention flags, a collapsed workspace — with one session selected
 * mid-list so the selection styling is visible next to plain rows.
 */
export const PanelWithSelection: Story = {
  args: { session: baseSession },
  render: () => (
    <div className="h-[480px] w-64 overflow-hidden border border-[var(--border)]">
      <SessionPanel
        workspaces={[
          { id: 'w1', name: 'main' },
          { id: 'w2', name: 'axn-dev' },
          { id: 'w3', name: 'scratch', collapsed: true },
        ]}
        sessions={[
          baseSession,
          {
            ...baseSession,
            id: 's2',
            name: 'axn-term · build',
            process: 'vite',
            status: 'running',
            output: 'vite dev serving on 5173',
          },
          {
            ...baseSession,
            id: 's3',
            name: 'axn-term · tests',
            process: 'vitest',
            status: 'running',
            pluginState: attentionPluginState('devin', {
              level: 'warning',
              message: 'quiet for 45s — possibly finished',
            }),
          },
          {
            ...baseSession,
            id: 's4',
            workspaceId: 'w2',
            name: 'storybook',
            process: 'node',
            status: 'running',
          },
          {
            ...baseSession,
            id: 's5',
            workspaceId: 'w2',
            name: 'scratch shell',
            process: undefined,
            status: 'idle',
          },
          {
            ...baseSession,
            id: 's6',
            workspaceId: 'w2',
            name: 'axn-term · devin review',
            pluginState: attentionPluginState('devin', {
              level: 'critical',
              message: 'rebase conflict',
            }),
          },
          {
            ...baseSession,
            id: 's7',
            workspaceId: 'w3',
            name: 'collapsed ws session',
          },
        ]}
        selectedSessionId="s2"
        taskState={null}
        onSelectWorkspace={() => {}}
        onSelectSession={() => {}}
        onAddWorkspace={() => {}}
        onSaveWorkspaceSet={() => {}}
        onLoadWorkspaceSet={() => {}}
        onRenameWorkspace={() => {}}
        onDeleteWorkspace={() => {}}
        onToggleWorkspace={() => {}}
        onAddSession={() => {}}
        onMoveSession={() => {}}
        onReorderWorkspace={() => {}}
        onMoveWorkspace={() => {}}
        onRenameSession={() => {}}
        onDuplicateSession={() => {}}
        onCloseSession={() => {}}
        updateSession={() => {}}
        mergePluginState={() => {}}
        plugins={[devinStub, gitStub]}
        onOpenBrowser={() => {}}
        onOpenTab={() => {}}
        pluginData={{}}
        mergePluginData={() => {}}
        onOpenSubShell={() => {}}
        onTurnIntoWorkspace={() => {}}
      />
    </div>
  ),
};
