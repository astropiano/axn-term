import type { Meta, StoryObj } from '@storybook/react-vite';
import { RemoteIcon, type RemoteIconState } from './remoteIcon';

const meta = {
  title: 'app/RemoteIcon',
  component: RemoteIcon,
} satisfies Meta<typeof RemoteIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

const STATES: { state: RemoteIconState; label: string }[] = [
  { state: 'idle', label: 'idle — chevrons take currentColor' },
  { state: 'connecting', label: 'connecting — green ping-pongs' },
  { state: 'connected', label: 'connected — both green' },
  { state: 'error', label: 'error — both red' },
];

/**
 * All four connection states inside the actual rail button, so the
 * chevron coloring reads exactly like the rail. 'connecting' animates —
 * the green jumps between the left and right chevron every 350ms.
 */
export const States: Story = {
  render: () => (
    <div className="flex items-start gap-3">
      {STATES.map(({ state, label }) => (
        <div key={state} className="w-28">
          <div className="mb-1 font-mono text-[10px] text-[var(--text-secondary)]">
            {state}
          </div>
          <div
            data-tip={label}
            className="relative flex h-8 w-7 flex-col items-center justify-center gap-px rounded border border-transparent text-[var(--text-secondary)]"
          >
            <RemoteIcon state={state} className="h-4 w-4" />
            <span className="select-none text-[8px] font-bold leading-none text-[var(--text-secondary)]">
              2
            </span>
          </div>
        </div>
      ))}
    </div>
  ),
};

/** Larger render to check the paths read cleanly at every size. */
export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-4 text-[var(--text-secondary)]">
      {['h-4 w-4', 'h-5 w-5', 'h-8 w-8', 'h-12 w-12'].map((cls) => (
        <RemoteIcon key={cls} state="connected" className={cls} />
      ))}
    </div>
  ),
};
