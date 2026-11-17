import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SquareTerminal, Terminal } from 'lucide-react';
import { SessionTabStrip } from './SessionTabStrip';
import { StoryShellProviders } from './storyMocks';
import { tabStripTabClasses, type TabStripTabVariant } from './tabStyles';
import type { EditorTab } from '../types';

const editors: EditorTab[] = [
  {
    id: 'sub1',
    path: '',
    kind: 'shell',
    label: 'devin review',
    tasks: [
      { id: 't1', title: 'inspect diff', done: true },
      { id: 't2', title: 'comment on MR', done: false },
    ],
    hookStatus: 'running',
  },
  { id: 'ed1', path: '/repo/axn-term/libs/shell-ui/src/app/ShellApp.tsx', dirty: true },
  { id: 'git1', path: '/repo/axn-term', kind: 'git' },
  { id: 'prev1', path: '/repo/axn-term/README.md', kind: 'preview' },
];

function Strip({ activeTab }: { activeTab: string }) {
  const [active, setActive] = useState(activeTab);
  return (
    <div className="flex w-full max-w-2xl flex-col border border-[var(--border)]">
      <SessionTabStrip
        editors={editors}
        activeTab={active}
        onSelect={setActive}
        onTabMenu={() => {}}
        onReorder={() => {}}
        onCloseTab={() => {}}
      />
      {/* stand-in for the view below the strip — same --bg the tab merges into */}
      <div className="h-24 bg-[var(--bg)] p-3 text-[11px] text-[var(--text-secondary)]">
        view content — the active tab shares this background
      </div>
    </div>
  );
}

const meta = {
  title: 'app/SessionTabStrip',
  component: Strip,
  decorators: [
    (Story) => (
      <StoryShellProviders>
        <Story />
      </StoryShellProviders>
    ),
  ],
  args: { activeTab: 'ed1' },
  argTypes: {
    activeTab: {
      control: 'select',
      options: ['shell', ...editors.map((e) => e.id)],
    },
  },
} satisfies Meta<typeof Strip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ShellActive: Story = {
  args: { activeTab: 'shell' },
};

export const BlockedAgent: Story = {
  render: () => (
    <div className="flex w-full max-w-2xl flex-col border border-[var(--border)]">
      <SessionTabStrip
        editors={[
          { ...editors[0], hookStatus: 'blocked', hookAttention: { message: 'waiting for input' } },
          ...editors.slice(1),
        ]}
        activeTab="sub1"
        onSelect={() => {}}
        onTabMenu={() => {}}
        onReorder={() => {}}
        onCloseTab={() => {}}
      />
      <div className="h-24 bg-[var(--bg)]" />
    </div>
  ),
};

const manyEditors: EditorTab[] = Array.from({ length: 14 }, (_, i) => ({
  id: `f${i}`,
  path: `/repo/axn-term/libs/shell-ui/src/app/SomeLongFileName${i}.tsx`,
}));

/** More tabs than fit: chevrons appear, the native scrollbar stays hidden. */
export const Overflow: Story = {
  render: () => {
    const [active, setActive] = useState('f7');
    return (
      <div className="flex w-full max-w-2xl flex-col border border-[var(--border)]">
        <SessionTabStrip
          editors={[...editors, ...manyEditors]}
          activeTab={active}
          onSelect={setActive}
          onTabMenu={() => {}}
          onReorder={() => {}}
          onCloseTab={() => {}}
        />
        <div className="h-24 bg-[var(--bg)]" />
      </div>
    );
  },
};

// ---------------------------------------------------------------------------
// Variant / color explorations — static markup sharing tabStripTabClasses so
// the shapes below stay in sync with the real component.
// ---------------------------------------------------------------------------

function DemoTab({
  label,
  active,
  variant,
}: {
  label: string;
  active?: boolean;
  variant: TabStripTabVariant;
}) {
  return (
    <div
      className={`relative flex shrink-0 items-center gap-1.5 px-2 text-[11px] ${tabStripTabClasses(
        !!active,
        variant,
      )}`}
    >
      <Terminal className="h-3.5 w-3.5" />
      {label}
    </div>
  );
}

function VariantStrip({ variant }: { variant: TabStripTabVariant }) {
  return (
    <div className="w-80">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">
        {variant}
      </div>
      <div className="flex flex-col border border-[var(--border)]">
        <div className="flex h-8 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-secondary)] px-1">
          <DemoTab label="shell" variant={variant} />
          <DemoTab label="devin review" active variant={variant} />
          <DemoTab label="ShellApp.tsx" variant={variant} />
        </div>
        <div className="h-16 bg-[var(--bg)]" />
      </div>
    </div>
  );
}

/** The shipped shape next to the previous underline pill and a sloped trapezoid. */
export const ShapeVariants: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-6">
      <VariantStrip variant="tab" />
      <VariantStrip variant="underline" />
      <VariantStrip variant="trapezoid" />
    </div>
  ),
};

const INDICATOR_VARS = [
  'accent',
  'blue',
  'cyan',
  'green',
  'yellow',
  'orange',
  'violet',
  'magenta',
  'red',
];

/**
 * Every status color the theme exposes as a CSS variable, tried as the active
 * tab's top line. --accent tracks each theme's own accent; the rest are the
 * fixed palette slots.
 */
export const IndicatorColors: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-4">
      {INDICATOR_VARS.map((name) => (
        <div key={name} className="w-36">
          <div className="mb-1 font-mono text-[10px] text-[var(--text-secondary)]">
            --{name}
          </div>
          <div className="flex h-8 items-end border-b border-[var(--border)] bg-[var(--bg-secondary)] px-1">
            <div
              className="relative flex h-7 flex-1 items-center justify-center gap-1.5 self-end -mb-px rounded-t-md border border-b-0 border-t-0 border-[var(--border)] bg-[var(--bg)] px-2 pt-px text-[11px] text-[var(--text-primary)]"
              style={{ boxShadow: `inset 0 3px 0 var(--${name})` }}
            >
              <SquareTerminal className="h-3.5 w-3.5" />
              tab
            </div>
          </div>
          <div className="h-8 border-x border-b border-[var(--border)] bg-[var(--bg)]" />
        </div>
      ))}
    </div>
  ),
};

/**
 * The same strip repeated with the active tab on the leftmost, middle and
 * rightmost position — the connected-tab shape must read in every slot.
 */
export const ActivePositions: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      {(['shell', 'sub1', 'prev1'] as const).map((id) => (
        <div key={id} className="w-full max-w-2xl">
          <div className="mb-1 font-mono text-[10px] text-[var(--text-secondary)]">
            active: {id}
          </div>
          <div className="flex flex-col border border-[var(--border)]">
            <SessionTabStrip
              editors={editors}
              activeTab={id}
              onSelect={() => {}}
              onTabMenu={() => {}}
              onReorder={() => {}}
              onCloseTab={() => {}}
            />
            <div className="h-10 bg-[var(--bg)]" />
          </div>
        </div>
      ))}
    </div>
  ),
};

