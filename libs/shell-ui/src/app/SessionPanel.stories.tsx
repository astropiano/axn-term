import { useEffect, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { publishPanelStatus } from './panelStatus';
import { SessionPanel } from './SessionPanel';
import { StoryShellProviders } from './storyMocks';
import type { SessionAttention, ShellSession } from '../types';
import type { SessionViewPlugin } from './session-plugins/plugin';

// Stub plugin objects — the panel only needs id/stateKey to read attention
// flags and banners from session.pluginState. (Real plugin fields live in
// the `app/Session card` stories.)
const devinStub: SessionViewPlugin = { id: 'devin', title: 'devin', stateKey: 'devin' };
const gitStub: SessionViewPlugin = { id: 'git-status', title: 'git', stateKey: 'gitStatus' };

function attentionPluginState(
  key: string,
  attention: SessionAttention,
): ShellSession['pluginState'] {
  return { [key]: { attention } };
}

const meta = {
  title: 'app/Session panel',
  decorators: [
    (Story) => (
      <StoryShellProviders>
        <Story />
      </StoryShellProviders>
    ),
  ],
} satisfies Meta;

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

/**
 * The whole panel including the header row (new workspace / save / load
 * workspace set buttons) — same h-8 height as the shell tab strip.
 */
export const Panel: Story = {
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
        onOpenSubShell={() => undefined}
        onTurnIntoWorkspace={() => {}}
        updateWorkspace={() => {}}
        onOpenIde={() => {}}
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
        onOpenSubShell={() => undefined}
        onTurnIntoWorkspace={() => {}}
        updateWorkspace={() => {}}
        onOpenIde={() => {}}
      />
    </div>
  ),
};

/** Publishes sample meters to the panel's status slot while mounted. */
function WithSystemMeters({ children }: { children: ReactNode }) {
  useEffect(() => {
    publishPanelStatus('story-ram', {
      title: 'Memory',
      system: true,
      meters: [
        { label: 'RAM', value: '55%', pct: 55, level: 0, color: 'var(--green)', detail: '17.6 GB of 32.0 GB · axn-term 1.5 GB' },
        { label: 'Swap', value: '1.2 GB', pct: 30, level: 1, color: 'var(--yellow)', detail: '1.2 GB of 4.0 GB' },
      ],
    });
    publishPanelStatus('story-docker', {
      title: 'Docker',
      icon: 'Container',
      meters: [
        { label: 'Containers', summaryLabel: 'Running', value: '5', detail: '5 running · 2 stopped' },
        { label: 'CPU', value: '12%', pct: 12, level: 0, color: 'var(--green)', detail: 'containers 1.2 of 8 cores' },
        { label: 'Memory', summaryLabel: 'Mem', value: '85%', pct: 85, level: 2, color: 'var(--orange)', detail: '10.2 GB of 12.0 GB' },
        { label: 'Disk', value: '40%', pct: 40, level: 0, color: 'var(--green)', detail: '40.0 GB docker objects · 60.0 GB free' },
      ],
    });
    publishPanelStatus('story-mr', {
      title: 'Merge requests',
      icon: 'GitMerge',
      meters: [
        { label: 'Mine', value: '2/7', detail: 'assigned or authored, need action', level: 2, color: 'var(--orange)' },
        { label: 'Reviews', value: '1/3', detail: 'review requests waiting for you' },
      ],
    });
    return () => {
      publishPanelStatus('story-ram', null);
      publishPanelStatus('story-docker', null);
      publishPanelStatus('story-mr', null);
    };
  }, []);
  return <>{children}</>;
}

/**
 * The panel with its status stack above the footer — one accordion per
 * tool (collapsed: one line) and System last — and the "N waiting" filter
 * in the toolbar.
 */
export const PanelWithSystem: Story = {
  render: (args, context) => (
    <WithSystemMeters>{PanelWithSelection.render!(args, context)}</WithSystemMeters>
  ),
};
