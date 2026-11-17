import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeView,
  isWebUrl,
  onViewChanged,
  openView,
  publishActiveView,
  registerViewHost,
  removeView,
  resetViewHostForTests,
  runtimeViews,
  selectView,
} from './viewHost';

let selected: string | null = null;
let unregister: () => void;

beforeEach(() => {
  resetViewHostForTests();
  selected = null;
  unregister = registerViewHost({
    select: (key) => {
      selected = key;
      publishActiveView(key);
      return true;
    },
    describe: (key) => ({ pluginId: key.split('/')[0], entryId: key.split('/')[1], title: 'T', runtime: true }),
  });
});
afterEach(() => unregister());

describe('isWebUrl', () => {
  it('accepts absolute http(s) only', () => {
    expect(isWebUrl('http://127.0.0.1:37778/d/mr/')).toBe(true);
    expect(isWebUrl('https://example.com')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/rel', '', 'file:///etc/passwd']) {
      expect(isWebUrl(bad)).toBe(false);
    }
  });
});

describe('openView', () => {
  it('reuses the entry for the same URL and selects it', () => {
    const a = openView({ url: 'http://127.0.0.1:1/x', title: 'X' });
    const b = openView({ url: 'http://127.0.0.1:1/x' });
    expect(a).toBe(b);
    expect(a.startsWith('external-views/')).toBe(true);
    expect(runtimeViews()).toHaveLength(1);
    expect(selected).toBe(a);
  });
  it('refuses a non-web URL', () => {
    expect(() => openView({ url: 'javascript:alert(1)' })).toThrow();
    expect(runtimeViews()).toHaveLength(0);
  });
  it('titles an untitled view by its host', () => {
    openView({ url: 'http://127.0.0.1:37778/d/mr/' });
    expect(runtimeViews()[0].title).toBe('127.0.0.1:37778');
  });
});

describe('removeView', () => {
  it('removes a runtime entry and leaves the view when it was active', () => {
    const key = openView({ url: 'http://127.0.0.1:1/x' });
    expect(removeView(key)).toBe(true);
    expect(runtimeViews()).toHaveLength(0);
    expect(selected).toBeNull();
  });
  it('refuses keys that are not runtime entries', () => {
    expect(removeView('docker')).toBe(false);
  });
});

describe('selection', () => {
  it('fires viewChanged once per change and reports no URL', () => {
    const cb = vi.fn();
    const off = onViewChanged(cb);
    publishActiveView('external-views/a');
    publishActiveView('external-views/a');
    publishActiveView(null);
    off();
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1][0]).toBeNull();
    publishActiveView('external-views/a');
    expect(activeView()).toEqual({
      key: 'external-views/a',
      pluginId: 'external-views',
      entryId: 'a',
      title: 'T',
      runtime: true,
    });
    expect(activeView()).not.toHaveProperty('url');
  });
  it('selectView is refused without a registered host', () => {
    unregister();
    expect(selectView('docker')).toBe(false);
  });
});
