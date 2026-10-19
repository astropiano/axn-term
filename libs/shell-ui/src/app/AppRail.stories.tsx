import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TooltipHost } from './Tooltip';
import { StoryRail, StoryShellProviders, bindStoryRuntime, unbindStoryRuntime } from './storyMocks';

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

const meta = {
  title: 'app/Rail',
  component: RailExample,
} satisfies Meta<typeof RailExample>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The whole slim rail with every plugin's rail view fed canned data. */
export const AllPlugins: Story = {};
