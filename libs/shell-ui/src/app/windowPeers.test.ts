import { describe, it, expect, vi } from 'vitest';
import type { PeerChannel } from '../platform';
import type { ShellSession } from '../types';
import {
  requestAdopt,
  TOPIC_ADOPT,
  TOPIC_ADOPT_ACK,
  windowLabels,
  workspaceTargets,
  type AdoptRequest,
} from './windowPeers';

/** In-memory stand-in for Tauri's app-wide events (delivered to everyone). */
function fakeChannel(): PeerChannel {
  const subs = new Map<string, Set<(p: unknown) => void>>();
  return {
    publish: (topic, payload) => {
      for (const cb of [...(subs.get(topic) ?? [])]) cb(payload);
    },
    subscribe: (topic, cb) => {
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic)!.add(cb);
      return () => subs.get(topic)!.delete(cb);
    },
  };
}

describe('windowLabels', () => {
  it('names this window, the main window, and numbers the rest', () => {
    const labels = windowLabels(['w-b', 'main', 'w-a', 'w-c'], 'w-c');
    expect(labels.get('w-c')).toBe('This window');
    expect(labels.get('main')).toBe('Main window');
    expect(labels.get('w-a')).toBe('Window 2');
    expect(labels.get('w-b')).toBe('Window 3');
  });
});

describe('workspaceTargets', () => {
  const others = new Map([
    ['w-x', [{ id: 'ws-3', name: 'reviews' }]],
    ['main', [{ id: 'ws-4', name: 'vectordb' }]],
  ]);
  const targets = workspaceTargets('w-self', [{ id: 'ws-1', name: 'axn-term' }, { id: 'ws-2', name: 'docs' }], others);

  it('lists this window first, then other windows grouped', () => {
    expect(targets.map((t) => `${t.windowLabel}/${t.workspace.name}`)).toEqual([
      'This window/axn-term',
      'This window/docs',
      'Main window/vectordb',
      // Numbering is global (every window agrees): this window is Window 2.
      'Window 3/reviews',
    ]);
    expect(targets.filter((t) => t.isCurrentWindow)).toHaveLength(2);
  });
});

describe('requestAdopt', () => {
  const session = { id: 's1', name: 'build', workspaceId: 'ws-1' } as ShellSession;

  it('resolves ok once the target window acknowledges', async () => {
    const peers = fakeChannel();
    peers.subscribe(TOPIC_ADOPT, (p) => {
      const req = p as AdoptRequest;
      if (req.to === 'w-target') peers.publish(TOPIC_ADOPT_ACK, { to: req.from, requestId: req.requestId, ok: true });
    });
    await expect(
      requestAdopt(peers, { to: 'w-target', from: 'w-self', workspaceId: 'ws-9', session }),
    ).resolves.toEqual({ ok: true });
  });

  it('passes on a refusal', async () => {
    const peers = fakeChannel();
    peers.subscribe(TOPIC_ADOPT, (p) => {
      const req = p as AdoptRequest;
      peers.publish(TOPIC_ADOPT_ACK, { to: req.from, requestId: req.requestId, ok: false, error: 'gone' });
    });
    await expect(
      requestAdopt(peers, { to: 'w-target', from: 'w-self', workspaceId: 'ws-9', session }),
    ).resolves.toEqual({ ok: false, error: 'gone' });
  });

  it('ignores acks meant for other requests and times out without an answer', async () => {
    vi.useFakeTimers();
    try {
      const peers = fakeChannel();
      peers.subscribe(TOPIC_ADOPT, () =>
        peers.publish(TOPIC_ADOPT_ACK, { to: 'w-self', requestId: 'someone-else', ok: true }),
      );
      const pending = requestAdopt(peers, { to: 'w-target', from: 'w-self', workspaceId: 'ws-9', session }, 3000);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(pending).resolves.toEqual({ ok: false, error: 'the other window did not answer' });
    } finally {
      vi.useRealTimers();
    }
  });
});
