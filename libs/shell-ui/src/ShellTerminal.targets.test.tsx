// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm';
import { ShellTerminal } from './ShellTerminal';
import { SettingsProvider } from './SettingsProvider';
import { ShellServicesProvider } from './services';
import { storyBackend, storySessions } from './app/storyMocks';
import { registerTargetHost, type TicketTarget } from './app/textTargets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const openExternal = vi.fn();
const services = { copyText: () => Promise.resolve(), openExternal };
const fileReader = () => undefined;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let off: (() => void) | undefined;
const providers: Array<{ term: Terminal; provider: ILinkProvider }> = [];
const run = vi.fn();

const ticket = (key: string): TicketTarget => ({
  kind: 'ticket',
  key,
  source: 'jira',
  url: `https://jira.example/browse/${key}`,
  summary: 'Fix the thing',
});

beforeEach(() => {
  vi.spyOn(Terminal.prototype, 'registerLinkProvider').mockImplementation(function (
    this: Terminal,
    provider: ILinkProvider,
  ) {
    providers.push({ term: this, provider });
    return { dispose: () => {} };
  });
  off = registerTargetHost({
    scan: (text) =>
      [...text.matchAll(/AIACC-\d+/g)].map((m) => ({
        start: m.index!,
        end: m.index! + m[0].length,
        target: ticket(m[0]),
      })),
    fromUrl: (url) => {
      const key = /\/browse\/(AIACC-\d+)$/.exec(url)?.[1];
      return key ? ticket(key) : undefined;
    },
    actions: () => [{ id: 'start', label: 'Start worktree', run }],
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  off?.();
  providers.length = 0;
  vi.restoreAllMocks();
  run.mockReset();
  openExternal.mockReset();
});

async function setup(line: string): Promise<ILink[]> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <SettingsProvider>
        <ShellServicesProvider services={services} fileReader={fileReader}>
          <ShellTerminal session={storySessions[0]} backend={storyBackend} isVisible />
        </ShellServicesProvider>
      </SettingsProvider>,
    ),
  );
  // The terminal's own provider — the last one registered.
  const { term, provider } = providers[providers.length - 1];
  await new Promise<void>((resolve) => term.write(`${line}\r\n`, resolve));
  const row = term.buffer.active.cursorY; // line written above the cursor
  return new Promise<ILink[]>((resolve) => provider.provideLinks(row, (links) => resolve(links ?? [])));
}

const mouse = () => new MouseEvent('mousemove', { clientX: 10, clientY: 10, button: 0 });

async function hover(link: ILink) {
  vi.useFakeTimers();
  await act(async () => {
    link.hover?.(mouse(), link.text);
    vi.advanceTimersByTime(600);
  });
  vi.useRealTimers();
}

it('underlines a bare key and opens its card with Open link first', async () => {
  const links = await setup('see AIACC-7 now');
  const link = links.find((l) => l.text === 'AIACC-7');
  expect(link?.range).toMatchObject({ start: { x: 5 }, end: { x: 11 } });
  await hover(link!);
  const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
  expect(buttons.slice(0, 3)).toEqual(['Open link', 'Start worktree', 'Copy key']);
  expect(document.body.textContent).toContain('Fix the thing');

  const start = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Start worktree'))!;
  await act(async () => start.click());
  expect(run).toHaveBeenCalledOnce();
});

it('gives a claimed URL the target card, not the key inside it', async () => {
  const links = await setup('open https://jira.example/browse/AIACC-9 please');
  expect(links.map((l) => l.text)).toEqual(['https://jira.example/browse/AIACC-9']);
  await hover(links[0]);
  const buttons = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
  expect(buttons.slice(0, 3)).toEqual(['Open link', 'Start worktree', 'Copy URL']);
  const open = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Open link'))!;
  await act(async () => open.click());
  expect(openExternal).toHaveBeenCalledWith('https://jira.example/browse/AIACC-9');
});
