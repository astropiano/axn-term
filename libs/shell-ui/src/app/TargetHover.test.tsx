// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChipView } from './session-plugins/cardEnrichers';
import { ShellServicesProvider } from '../services';
import { SettingsProvider } from '../SettingsProvider';
import { registerTargetHost, type TargetAction } from './textTargets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const services = { copyText: () => Promise.resolve(), openExternal: () => {} };
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let off: (() => void) | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  off?.();
  vi.useRealTimers();
});

async function hoverChip(actions: TargetAction[], origins: Array<string | undefined>) {
  off = registerTargetHost({
    scan: () => [],
    fromUrl: () => undefined,
    actions: (_t, origin) => {
      origins.push(origin);
      return actions;
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <SettingsProvider>
        <ShellServicesProvider services={services} fileReader={() => undefined}>
          <ChipView
            chip={{
              label: 'AIACC-7',
              href: 'https://j/browse/AIACC-7',
              target: { kind: 'ticket', key: 'AIACC-7', source: 'jira', url: 'https://j/browse/AIACC-7' },
            }}
            originSessionId="s1"
          />
        </ShellServicesProvider>
      </SettingsProvider>,
    ),
  );
  vi.useFakeTimers();
  const chip = container.querySelector('a')!;
  await act(async () => {
    chip.parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(500);
  });
}

it('opens the target card for a chip when a plugin offers an action', async () => {
  const origins: Array<string | undefined> = [];
  await hoverChip([{ id: 'start', label: 'Start worktree', run: () => {} }], origins);
  const labels = [...document.body.querySelectorAll('button')].map((b) => b.textContent?.trim());
  expect(labels).toEqual(['Open link', 'Start worktree', 'Copy key']);
  expect(origins).toEqual(['s1']);
});

it('keeps a chip nobody acts on as it was', async () => {
  await hoverChip([], []);
  expect(document.body.querySelectorAll('button')).toHaveLength(0);
});
