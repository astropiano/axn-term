import { Fragment, useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TooltipHost } from './Tooltip';
import { PanelStatusSection } from './PanelStatusSection';
import { PluginIcon, SessionIconGlyph } from './SessionPanel';
import type { PublishedStatus } from './panelStatus';
import { getSessionViewPlugins } from './session-plugins';
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

/**
 * The docker rail item next to the session panel's status stack, which
 * shows what docker and the RAM plugin used to put into the rail and its
 * tooltips — a Docker accordion and, below it, System: both expanded (left)
 * and as one line each (right).
 */
function DockerRamExample() {
  bindStoryRuntime();
  useEffect(() => () => unbindStoryRuntime(), []);
  const plugins = getSessionViewPlugins().filter((p) => p.id === 'docker' || p.id === 'ram');
  const [open, setOpen] = useState<string[]>(['docker']);
  const [systemOpen, setSystemOpen] = useState(true);
  const renderIcon = ({ source, group }: PublishedStatus) => {
    const plugin = plugins.find((p) => p.id === source);
    return plugin?.logo !== undefined ? (
      <PluginIcon plugin={plugin} className="h-3.5 w-3.5 shrink-0" />
    ) : (
      <SessionIconGlyph value={group.icon ?? 'Puzzle'} className="h-3.5 w-3.5 shrink-0" />
    );
  };
  const toggle = (source: string) =>
    setOpen((ids) => (ids.includes(source) ? ids.filter((id) => id !== source) : [...ids, source]));
  return (
    <StoryShellProviders>
      <TooltipHost />
      <MemoryStatsProvider active>
        <div className="flex items-start gap-4">
          <div className="flex h-[300px] w-[var(--rail-w)] flex-col items-center gap-1 rounded-[var(--radius-lg)] bg-[var(--chrome)] py-2 shadow-[0_0_0_1px_var(--hairline)]">
            {plugins.map((plugin) =>
              plugin.renderRail ? (
                <div key={plugin.id} className="flex flex-col items-center empty:hidden">
                  {plugin.renderRail({
                    backend: storyBackend,
                    pluginSettings: storyPluginSettings[plugin.settingsKey ?? plugin.id],
                    setAppAttention: (attention) => setAppAttention(plugin.id, attention),
                    viewActive: false,
                    toggleView: () => {},
                    appState: undefined,
                    updateAppState: () => {},
                    sessions: storySessions,
                    sessionApi: () => undefined,
                  })}
                </div>
              ) : null,
            )}
          </div>
          {/* Headless status sources, as ShellApp mounts them. */}
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
          <div className="w-72 overflow-hidden rounded-[var(--radius-lg)] bg-[var(--chrome)] shadow-[0_0_0_1px_var(--hairline)]">
            <PanelStatusSection
              systemExpanded={systemOpen}
              onToggleSystem={() => setSystemOpen((v) => !v)}
              expandedGroups={open}
              onToggleGroup={toggle}
              sourceOrder={['docker']}
              renderIcon={renderIcon}
            />
          </div>
          <div className="w-72 overflow-hidden rounded-[var(--radius-lg)] bg-[var(--chrome)] shadow-[0_0_0_1px_var(--hairline)]">
            <PanelStatusSection
              systemExpanded={false}
              onToggleSystem={() => {}}
              sourceOrder={['docker']}
              renderIcon={renderIcon}
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

/** Docker's rail item, and the status stack: a Docker accordion (containers, VM) above System (RAM, swap). */
export const DockerAndRam: Story = {
  render: () => <DockerRamExample />,
};
