import { useState, type CSSProperties } from 'react';
import { dump } from 'js-yaml';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SessionPanel } from './SessionPanel';
import { PluginSettingsProvider } from './PluginSettingsProvider';
import { StoryShellProviders } from './storyMocks';
import { ShellServicesProvider } from '../services';
import { TAG_SLOTS } from '../themes';
import type { ShellSession, Workspace } from '../types';
import { taggingPlugin } from './session-plugins/tagging';
import { TINT_INTENSITY } from './session-plugins/tint';
import { DEFAULT_SESSION_CARD } from './sessionCardLayout';

/**
 * Tag tints in the real session panel, for tuning the shades: drag the
 * sliders (they set the `--tint-*` CSS variables `resolveTint` reads, the
 * `TINT_INTENSITY` values are their fallback), switch the theme in the
 * toolbar, and recolour the tags. Copy the values you like back into
 * `TINT_INTENSITY` in `session-plugins/tint.ts`.
 */

const COLOUR_OPTIONS = [...TAG_SLOTS, '#e5484d', '#0091ff', '#46a758', '#ffb224'];

const session = (id: string, workspaceId: string, name: string, tags: string[], summary = ''): ShellSession => ({
  id,
  workspaceId,
  name,
  topic: '',
  summary,
  tasks: [],
  progress: 0,
  output: '',
  process: 'claude',
  pluginState: tags.length ? { tagging: { tags } } : undefined,
});

const WORKSPACES: Workspace[] = [
  { id: 'w1', name: 'Backend', collapsed: false, pluginState: { tagging: { tags: ['backend'] } } },
  { id: 'w2', name: 'Untagged workspace', collapsed: false },
];

const SESSIONS: ShellSession[] = [
  session('s1', 'w1', 'api load test', ['load-test'], 'Load test against staging'),
  session('s2', 'w1', 'web load test', ['load-test'], 'Smoke test the web client'),
  session('s3', 'w1', 'scratch shell', []),
  session('s4', 'w1', 'two tags', ['load-test', 'urgent']),
  session('s5', 'w2', 'urgent fix', ['urgent'], 'Hotfix for the release'),
  session('s6', 'w2', 'plain', []),
];

interface Args {
  workspace: number;
  card: number;
  selectedCard: number;
  selectedTitle: number;
  selected: string;
  workspaceTag: string;
  loadTestTag: string;
  urgentTag: string;
  showTagNames: boolean;
}

const pluginsYaml = (a: Args) =>
  dump({ tagging: { enabled: true, colors: { backend: a.workspaceTag, 'load-test': a.loadTestTag, urgent: a.urgentTag } } });

const configYaml = (a: Args) =>
  dump(
    a.showTagNames
      ? { sessionCard: { ...DEFAULT_SESSION_CARD, title: ['core.name', 'tagging.tags', 'core.status'] } }
      : {},
    { sortKeys: false },
  );

function Panel(args: Args) {
  const [selected, setSelected] = useState(args.selected);
  const noop = () => {};
  const vars = {
    '--tint-workspace': `${args.workspace}%`,
    '--tint-card': `${args.card}%`,
    '--tint-selected-card': `${args.selectedCard}%`,
    '--tint-selected-title': `${args.selectedTitle}%`,
  } as CSSProperties;
  return (
    <PluginSettingsProvider
      key={pluginsYaml(args)}
      store={{ read: () => Promise.resolve(pluginsYaml(args)), write: () => Promise.resolve() }}
    >
      <ShellServicesProvider services={{ copyText: noop, openExternal: noop }} fileReader={() => undefined}>
        <div className="h-[760px] w-80 bg-[var(--chrome)]" style={vars}>
          <SessionPanel
            workspaces={WORKSPACES}
            sessions={SESSIONS}
            selectedSessionId={selected}
            taskState={null}
            onSelectWorkspace={noop}
            onSelectSession={(id) => setSelected(id)}
            onOpenIde={noop}
            onAddWorkspace={noop}
            onSaveWorkspaceSet={noop}
            onLoadWorkspaceSet={noop}
            onRenameWorkspace={noop}
            onDeleteWorkspace={noop}
            onToggleWorkspace={noop}
            updateWorkspace={noop}
            onAddSession={noop}
            onMoveSession={noop}
            onReorderWorkspace={noop}
            onMoveWorkspace={noop}
            onRenameSession={noop}
            onDuplicateSession={noop}
            onCloseSession={noop}
            updateSession={noop}
            mergePluginState={noop}
            plugins={[taggingPlugin]}
            onOpenBrowser={noop}
            onOpenTab={noop}
            onOpenSubShell={() => undefined}
            onTurnIntoWorkspace={noop}
            pluginData={{}}
            mergePluginData={noop}
          />
        </div>
      </ShellServicesProvider>
    </PluginSettingsProvider>
  );
}

const percent = { control: { type: 'range', min: 0, max: 100, step: 1 } } as const;
const colour = { control: 'select', options: COLOUR_OPTIONS } as const;

const meta = {
  title: 'app/Tag tints',
  component: Panel,
  decorators: [
    (Story, ctx) => (
      <StoryShellProviders configYaml={configYaml(ctx.args as Args)}>
        <Story />
      </StoryShellProviders>
    ),
  ],
  argTypes: {
    workspace: percent,
    card: percent,
    selectedCard: percent,
    selectedTitle: percent,
    selected: { control: 'select', options: SESSIONS.map((s) => s.id) },
    workspaceTag: colour,
    loadTestTag: colour,
    urgentTag: colour,
    showTagNames: { control: 'boolean' },
  },
  args: {
    ...TINT_INTENSITY,
    selected: 's1',
    workspaceTag: 'cyan',
    loadTestTag: 'red',
    urgentTag: 'yellow',
    showTagNames: false,
  },
} satisfies Meta<typeof Panel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A tagged workspace with tagged and untagged sessions, plus an untagged workspace. */
export const Default: Story = {};

/** Tag names shown as chips in the title row (placed via `sessionCard`). */
export const WithTagNames: Story = { args: { showTagNames: true } };

/** Light theme. */
export const Light: Story = { globals: { theme: 'axn-light' } };
