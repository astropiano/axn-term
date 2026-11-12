import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import type { SessionBackend } from '@axn-term/session-backend';
import { BroadcastDeck } from './BroadcastDeck';
import { StoryShellProviders } from './storyMocks';
import { broadcastSet } from './broadcastSet';
import type { ShellSession } from '../types';

const E = '\x1b[';
const fakeOutput = (name: string, color: string) =>
  `${color}$ whoami${E}[0m\r\n${name}\r\n${color}$ uptime${E}[0m\r\n up 3 days, 4:12\r\n${color}$ ${E}[0m`;

function makeSession(
  id: string,
  name: string,
  color: string,
  activeTab = 'shell',
): ShellSession {
  return {
    id,
    name,
    ptyId: `pty-${id}`,
    workspaceId: 'w1',
    activeTab,
    output: fakeOutput(name, color),
    editors:
      activeTab === 'shell'
        ? []
        : [{ id: activeTab, path: '/repo', kind: 'git' }],
  } as unknown as ShellSession;
}

const SESSIONS: ShellSession[] = [
  makeSession('s1', 'devin — api fix', E + '[32m'),
  makeSession('s2', 'claude — tests', E + '[34m'),
  makeSession('s3', 'shell — deploy', E + '[35m'),
  makeSession('s4', 'agent — review', E + '[36m', 't-git'),
];

/** Echo backend: written lines get printed into the target tile live. */
function makeDeckBackend(sessions: ShellSession[]): SessionBackend {
  const subs = new Map<string, Set<(d: Uint8Array) => void>>();
  const emit = (id: string, s: string) =>
    subs.get(id)?.forEach((cb) => cb(new TextEncoder().encode(s)));
  return {
    createSession: () => Promise.resolve(false),
    write: (ptyId: string, data: string) => {
      const s = sessions.find((x) => x.ptyId === ptyId);
      if (s) emit(s.id, `${E}[2K\r$ ${data.replace(/\r$/, '')}\r\n$ `);
    },
    resize: () => {},
    close: () => {},
    onOutput: (id: string, cb: (d: Uint8Array) => void) => {
      if (!subs.has(id)) subs.set(id, new Set());
      subs.get(id)!.add(cb);
      return () => subs.get(id)?.delete(cb);
    },
  } as unknown as SessionBackend;
}

function Deck({ sessions, height = 420 }: { sessions: ShellSession[]; height?: number }) {
  const backend = makeDeckBackend(sessions);
  useEffect(() => {
    broadcastSet.replaceAll(sessions.map((s) => s.id));
    return () => broadcastSet.clear();
  }, [sessions]);
  return (
    <StoryShellProviders>
      <div style={{ height, width: '100%', border: '1px solid var(--border)' }}>
        <BroadcastDeck backend={backend} sessions={sessions} onFocusSession={() => {}} />
      </div>
    </StoryShellProviders>
  );
}

const meta = {
  title: 'app/BroadcastDeck',
  component: BroadcastDeck,
} satisfies Meta<typeof BroadcastDeck>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeShells: Story = {
  render: () => <Deck sessions={SESSIONS.slice(0, 3)} />,
};

/** One session sits on its git tab — warning shown, input disabled. */
export const BlockedByNonTerminalTab: Story = {
  render: () => <Deck sessions={SESSIONS} />,
};

export const NarrowFallback: Story = {
  render: () => (
    <div style={{ width: 380 }}>
      <Deck sessions={SESSIONS.slice(0, 3)} height={300} />
    </div>
  ),
};

export const Empty: Story = {
  render: () => {
    useEffect(() => broadcastSet.clear(), []);
    return (
      <StoryShellProviders>
        <div style={{ height: 200, border: '1px solid var(--border)' }}>
          <BroadcastDeck
            backend={makeDeckBackend([])}
            sessions={[]}
            onFocusSession={() => {}}
          />
        </div>
      </StoryShellProviders>
    );
  },
};
