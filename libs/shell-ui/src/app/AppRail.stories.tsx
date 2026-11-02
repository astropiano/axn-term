import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TooltipHost } from './Tooltip';
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

/** Just the docker + ram rail plugins — the pressure-gauge look. */
function DockerRamExample() {
  bindStoryRuntime();
  useEffect(() => () => unbindStoryRuntime(), []);
  const plugins = getSessionViewPlugins().filter(
    (p) => (p.id === 'docker' || p.id === 'ram') && p.renderRail,
  );
  return (
    <StoryShellProviders>
      <TooltipHost />
      <MemoryStatsProvider active>
        <div className="flex h-[300px] w-10 flex-col items-center rounded border border-[var(--border)] bg-[var(--bg-secondary)] py-2">
          {plugins.map((plugin) => (
            <div key={plugin.id} className="mt-3">
              {plugin.renderRail!({
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
          ))}
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

/** Docker (whale + CPU/MEM/disk gauges) above the RAM gauge. */
export const DockerAndRam: Story = {
  render: () => <DockerRamExample />,
};
