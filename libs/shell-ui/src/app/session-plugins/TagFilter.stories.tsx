import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { ShellSession, Workspace } from '../../types';
import { StoryShellProviders } from '../storyMocks';
import { TagFilter } from './TagFilter';

const TAGS = [
  'ai-accelerator',
  'exploration',
  'mls',
  'vectordb',
  'documentation',
  'a-rather-long-tag-name-that-exceeds-the-pane-width-on-its-own',
];

const sessions = TAGS.map(
  (tag, i) =>
    ({
      id: `s${i}`,
      workspaceId: 'w',
      name: `session ${i}`,
      pluginState: { tagging: { tags: [tag] } },
    }) as unknown as ShellSession,
);
const workspaces: Workspace[] = [];

function Filter({ width }: { width: number }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <StoryShellProviders>
      <div
        className="min-w-40 resize-x overflow-hidden bg-[var(--chrome)] px-2.5 py-2 outline outline-1 -outline-offset-1 outline-[var(--border)]"
        style={{ width }}
      >
        <TagFilter
          value={value}
          onChange={setValue}
          sessions={sessions}
          workspaces={workspaces}
          pluginSettings={{}}
        />
      </div>
    </StoryShellProviders>
  );
}

const meta = {
  title: 'app/Tag filter',
  component: Filter,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Filter>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Chips wrap onto further rows instead of scrolling off the pane edge. */
export const Wide: Story = { args: { width: 360 } };
/** Narrow pane (drag the corner to resize): every chip stays visible. */
export const Narrow: Story = { args: { width: 200 } };
