import type { Meta, StoryObj } from '@storybook/react-vite';
import { SquareTerminal } from 'lucide-react';
import { AttentionDot } from './AttentionDot';

const meta = {
  title: 'app/AttentionDot',
  component: AttentionDot,
  args: { className: 'h-4 w-4' },
  argTypes: {
    level: { control: 'radio', options: ['warning', 'critical'] },
  },
} satisfies Meta<typeof AttentionDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Critical: Story = {
  args: { level: 'critical' },
};

export const Warning: Story = {
  args: { level: 'warning' },
};

/** The dot as it appears in the session row: a halo underlaying the icon. */
export const UnderlyingProcessIcon: Story = {
  render: (args) => (
    <div className="flex w-56 items-center gap-2 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs">
      <span className="relative flex shrink-0" data-tip="devin: quiet for 45s — possibly finished">
        <AttentionDot
          {...args}
          className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2"
        />
        <span className="relative flex">
          <SquareTerminal className="h-4 w-4 shrink-0" />
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate font-semibold">axn-term · devin</span>
    </div>
  ),
  args: { level: 'critical' },
};

export const UnderlyingProcessIconWarning: Story = {
  ...UnderlyingProcessIcon,
  args: { level: 'warning' },
};
