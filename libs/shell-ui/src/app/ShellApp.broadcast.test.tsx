// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SessionBackend } from '@axn-term/session-backend';
import type { ShellPlatform } from '../platform';
import type { WindowState } from '../types';
import { ShellApp } from './ShellApp';
import { broadcastSet } from './broadcastSet';
import { dispatchSessionCommand } from './session-plugins/plugin';
import { getScreenLines, serializeTerminal } from '../terminalRegistry';
import { storyBackend, storyPlatform, storySessions } from './storyMocks';
import { SettingsProvider } from '../SettingsProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// storySessions: sess-1 + sess-2 in w1, sess-3 in w2 — the bug report's
// shape (a session selected in one workspace, a range in another).
//
// Plugin-style mounting: only the selected session (or a broadcast tile)
// mounts a ShellTerminal view. Session state owns every PTY — a session-
// level output subscription per session drives retention regardless of
// mounts, and backend.close is only ever called by an explicit close.
//
// onOutput subscriptions therefore count 1 (session-level) + 1 per mounted
// view — a count of 2 = view mounted, 1 = session alive but unmounted.

let root: Root | undefined;
let container: HTMLDivElement;
let mounts: Map<string, number>;
let closes: string[];
let emitters: Map<string, (bytes: Uint8Array) => void>;
let backend: SessionBackend;

function seed(selectedWorkspaceId: string, selectedSessionId: string): WindowState {
  return {
    id: 'main',
    workspaces: [
      { id: 'w1', name: 'one' },
      { id: 'w2', name: 'two' },
    ] as WindowState['workspaces'],
    sessions: storySessions,
    selectedWorkspaceId,
    selectedSessionId,
  } as WindowState;
}

async function mountApp(state: WindowState) {
  const platform: ShellPlatform = {
    ...storyPlatform,
    stateStore: { ...storyPlatform.stateStore, load: () => Promise.resolve(state) },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <SettingsProvider>
        <ShellApp
          backend={backend}
          services={{ copyText: () => Promise.resolve(), openExternal: () => {} }}
          platform={platform}
          fileReader={() => undefined}
        />
      </SettingsProvider>,
    ),
  );
}

beforeEach(() => {
  broadcastSet.clear();
  mounts = new Map();
  closes = [];
  emitters = new Map();
  backend = {
    ...storyBackend,
    onOutput: (id: string, cb: (bytes: Uint8Array) => void) => {
      emitters.set(id, cb);
      mounts.set(id, (mounts.get(id) ?? 0) + 1);
      return () => mounts.set(id, (mounts.get(id) ?? 1) - 1);
    },
    close: (id: string) => {
      closes.push(id);
    },
  } as SessionBackend;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  broadcastSet.clear();
});

it('mounts each broadcast session exactly once — no hidden duplicate under the band', async () => {
  // sess-3 focused (not a target): deck rides as a band above its view.
  broadcastSet.replaceAll(['sess-1', 'sess-2']);
  await mountApp(seed('w1', 'sess-3'));

  // session-level sub + one view each — a hidden below-copy would add a third.
  expect(mounts.get('sess-1')).toBe(2);
  expect(mounts.get('sess-2')).toBe(2);
  expect(mounts.get('sess-3')).toBe(2);
  expect(closes).toEqual([]);
});

it('an unselected session keeps running while the deck fills the area — nothing closes it', async () => {
  // The focused session IS a broadcast target → the deck takes the whole
  // area. sess-3 (selected in another workspace earlier) has no mounted
  // view — plugin style — but its PTY must stay alive: unmount-killing it
  // was the "session really closes" bug.
  broadcastSet.replaceAll(['sess-1', 'sess-2']);
  await mountApp(seed('w1', 'sess-1'));

  expect(mounts.get('sess-1')).toBe(2);
  expect(mounts.get('sess-2')).toBe(2);
  expect(mounts.get('sess-3')).toBe(1); // retention only — no view
  expect(closes).toEqual([]);

  // Going back to it must not have killed it — it remounts its view.
  await act(async () => {
    await dispatchSessionCommand('sess-1', 'axn-session select sess-3');
  });

  expect(mounts.get('sess-3')).toBe(2);
  expect(closes).toEqual([]);
});

it('selecting another session drops the previous view but never closes it', async () => {
  // No broadcast at all — the plain-selection case from the bug report:
  // A selected, then B + Shift-C elsewhere, then A "closed".
  await mountApp(seed('w1', 'sess-1'));
  expect(mounts.get('sess-1')).toBe(2);

  await act(async () => {
    await dispatchSessionCommand('sess-1', 'axn-session select sess-3');
  });

  // sess-1's view is gone (plugin-style) but its PTY lives — its session-
  // level retention subscription remains.
  expect(mounts.get('sess-1')).toBe(1);
  expect(mounts.get('sess-3')).toBe(2);
  expect(closes).toEqual([]);

  // Selecting back remounts it — still no close, ever.
  await act(async () => {
    await dispatchSessionCommand('sess-3', 'axn-session select sess-1');
  });
  expect(mounts.get('sess-1')).toBe(2);
  expect(closes).toEqual([]);
});

it('keeps a live screen for an unmounted session — plugins and remounts still see it', async () => {
  broadcastSet.replaceAll(['sess-1', 'sess-2']);
  await mountApp(seed('w1', 'sess-1'));

  // sess-3 has no view — its headless session buffer still tracks output.
  await act(async () => {
    emitters.get('sess-3')?.(new TextEncoder().encode('offscreen-marker-42\r\n'));
  });
  for (let i = 0; i < 50 && !getScreenLines('sess-3').join('\n').includes('offscreen-marker-42'); i++) {
    await act(async () => new Promise((r) => setTimeout(r, 20)));
  }
  expect(getScreenLines('sess-3').join('\n')).toContain('offscreen-marker-42');
  expect(serializeTerminal('sess-3')).toContain('offscreen-marker-42');
});

it('opening a session leaves it the only selection — no broadcast view around it', async () => {
  broadcastSet.replaceAll(['sess-1', 'sess-2']);
  await mountApp(seed('w1', 'sess-1'));

  await act(async () => {
    await dispatchSessionCommand('sess-1', 'axn-session');
  });

  // Bug: the new session was selected while {sess-1, sess-2} stayed the
  // broadcast set, so it rendered below the band inside the broadcast view.
  expect(broadcastSet.list()).toHaveLength(1);
  expect(broadcastSet.list()).not.toContain('sess-1');
  expect(broadcastSet.list()).not.toContain('sess-2');
  expect(closes).toEqual([]);
});
