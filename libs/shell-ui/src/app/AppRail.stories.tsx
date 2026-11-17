import { Fragment, useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TooltipHost } from './Tooltip';
import { SessionPanel } from './SessionPanel';
import { getSessionViewPlugins } from './session-plugins';
import type { SessionViewPlugin } from './session-plugins/plugin';
import { MemoryStatsProvider } from './useMemoryStats';
import { setAppAttention } from './attention';
import {
  StoryRail,
  StoryShellProviders,
  bindStoryRuntime,
  storyBackend,
  storyPluginSettings,
  storySessions,
  unbindStoryRuntime,
} from './storyMocks';

function RailExample() {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Bind before render — child effects (the glab rail's first refresh) run
  // before this component's own effects, so a useEffect would bind too late.
  bindStoryRuntime();
  useEffect(() => () => unbindStoryRuntime(), []);

  return (
    <StoryShellProviders>
      <TooltipHost />
      <div className="h-[460px]">
        <StoryRail
          activeId={activeId}
          onToggle={(id) => setActiveId((v) => (v === id ? null : id))}
        />
      </div>
    </StoryShellProviders>
  );
}

/** Headless status sources, as ShellApp mounts them (ram). */
function PluginPanelStatus({ plugins }: { plugins: SessionViewPlugin[] }) {
  return (
    <>
      {plugins.map((plugin) =>
        plugin.panelStatus ? (
          <Fragment key={plugin.id}>
            {plugin.panelStatus({
              backend: storyBackend,
              pluginSettings: storyPluginSettings[plugin.settingsKey ?? plugin.id],
              setAppAttention: (attention) => setAppAttention(plugin.id, attention),
              sessions: storySessions,
            })}
          </Fragment>
        ) : null,
      )}
    </>
  );
}

/**
 * The rail beside the workspaces panel — the real layout. Every rail plugin
 * renders; the ones publishing status fill the stack above the panel's
 * footer (Remote, Merge requests, Docker, axn-dev, then System with the RAM
 * meters), and the selected session shows plugin fields (RAM under sess-1).
 *
 * `detailed` switches rail items that declare it to their heavier form
 * (`renderRailDetail`) — what `statusDisplay: rail` or a touch device
 * shows — and hides the accordions they replace, so status never renders
 * twice.
 */
function RailAndWorkspacesExample({ detailed }: { detailed: boolean }) {
  bindStoryRuntime();
  useEffect(() => () => unbindStoryRuntime(), []);
  const all = getSessionViewPlugins();
  const [pluginData, setPluginData] = useState<Record<string, unknown>>({});
  const mergePluginData = (key: string, patch: Record<string, unknown>) =>
    setPluginData((d) => ({ ...d, [key]: { ...(d[key] as object), ...patch } }));
  return (
    <StoryShellProviders configYaml="remoteEnabled: true">
      <TooltipHost />
      <MemoryStatsProvider active>
      <PluginPanelStatus plugins={all} />
      <div className="flex h-[460px] w-[336px] items-stretch overflow-hidden rounded-[var(--radius-lg)] bg-[var(--chrome)] shadow-[0_0_0_1px_var(--hairline)]">
        <StoryRail
          activeId={null}
          onToggle={() => {}}
          pluginData={pluginData}
          detailed={detailed}
          bare
        />
        <div className="min-w-0 flex-1 overflow-hidden">
          <SessionPanel
            workspaces={[
              { id: 'w1', name: 'main' },
              { id: 'w2', name: 'scratch', collapsed: true },
            ]}
            sessions={storySessions}
            selectedSessionId="sess-1"
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
            plugins={all}
            onOpenBrowser={() => {}}
            onOpenTab={() => {}}
            pluginData={pluginData}
            mergePluginData={mergePluginData}
            onOpenSubShell={() => {}}
            onTurnIntoWorkspace={() => {}}
            onOpenPluginView={() => {}}
            hiddenStatusSources={
              detailed
                ? all.filter((p) => p.renderRailDetail).map((p) => p.id)
                : undefined
            }
          />
        </div>
      </div>
      </MemoryStatsProvider>
    </StoryShellProviders>
  );
}

const meta = {
  title: 'app/Rail',
  component: RailExample,
} satisfies Meta<typeof RailExample>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The whole slim rail with every plugin's rail view fed canned data. */
export const AllPlugins: Story = {};

/**
 * Default desktop: plain rail icons; status meters live in the accordions
 * at the bottom of the workspaces panel. The selected session (sess-1)
 * shows the RAM plugin's session field.
 */
export const RailAndPanel: Story = {
  render: () => <RailAndWorkspacesExample detailed={false} />,
};

/**
 * `statusDisplay: rail` (the touch default): rail items switch to their
 * heavier form — RAM's free/used strip, docker's counts and CPU/mem/disk
 * strips — and the accordions they replace are hidden.
 */
export const RailAndPanelDetail: Story = {
  render: () => <RailAndWorkspacesExample detailed={true} />,
};
