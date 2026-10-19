import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TooltipHost } from './Tooltip';
import { getSessionViewPlugins } from './session-plugins';
import {
  StoryRail,
  StoryShellProviders,
  bindStoryRuntime,
  storyPluginData,
  storyPluginSettings,
  storySessions,
  unbindStoryRuntime,
} from './storyMocks';

/**
 * App-frame replica: the rail on the left, the active plugin's renderView
 * filling the main area — like the real app when a rail icon is toggled.
 * Click rail icons to switch between views; click again (or the view's own
 * Close button) to return to the session placeholder.
 */
function PluginViewsExample() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pluginData, setPluginData] = useState<Record<string, unknown>>(storyPluginData);
  const viewPlugins = getSessionViewPlugins().filter((p) => p.renderView);
  const active = viewPlugins.find((p) => p.id === activeId);

  bindStoryRuntime();
  useEffect(() => () => unbindStoryRuntime(), []);

  const updateAppState = (pluginId: string, patch: Record<string, unknown>) =>
    setPluginData((prev) => {
      const key = viewPlugins.find((p) => p.id === pluginId)?.settingsKey ?? pluginId;
      const section = prev[key];
      return {
        ...prev,
        [key]: { ...(typeof section === 'object' && section ? section : {}), ...patch },
      };
    });

  return (
    <StoryShellProviders>
      <TooltipHost />
      <div className="flex h-[560px] w-[760px] gap-2">
        <StoryRail
          activeId={activeId}
          pluginData={pluginData}
          onToggle={(id) => setActiveId((v) => (v === id ? null : id))}
        />
        <div className="min-w-0 flex-1 overflow-hidden rounded border border-[var(--border)] bg-[var(--bg)]">
          {active ? (
            active.renderView!({
              pluginSettings: storyPluginSettings[active.settingsKey ?? active.id],
              close: () => setActiveId(null),
              appState: pluginData[active.settingsKey ?? active.id],
              updateAppState: (patch) => updateAppState(active.id, patch),
              openTab: () => {},
              sessions: storySessions,
              workspaces: [],
              selectSession: () => setActiveId(null),
              sessionApi: () => undefined,
            })
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-secondary)]">
              <p className="text-xs">No plugin view active — a session would render here.</p>
              <p className="text-[10px]">
                Click a rail icon to open its view ({viewPlugins.map((p) => p.id).join(', ')}).
              </p>
            </div>
          )}
        </div>
      </div>
    </StoryShellProviders>
  );
}

const meta = {
  title: 'app/Plugin views',
  component: PluginViewsExample,
} satisfies Meta<typeof PluginViewsExample>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Rail + main area; switch between every plugin's full-area view. */
export const SwitchableViews: Story = {};
