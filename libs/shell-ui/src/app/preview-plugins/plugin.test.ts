import { beforeEach, describe, expect, it } from 'vitest';
import {
  extensionMatcher,
  isFilePreviewEnabled,
  registerFilePreviewPlugin,
  resetFilePreviewPlugins,
  resolveFilePreviewPlugin,
} from './plugin';
import type { FilePreviewPlugin } from './plugin';
import type { PluginSettings } from '../pluginSettings';

function makePlugin(
  id: string,
  extensions: string[],
  extra: Partial<FilePreviewPlugin> = {},
): FilePreviewPlugin {
  return {
    id,
    title: id,
    matches: extensionMatcher(extensions),
    render: () => null,
    ...extra,
  };
}

const image = makePlugin('image', ['png', 'jpg']);
const markdown = makePlugin('markdown', ['md']);
const fallback = makePlugin('text', [], { matches: () => true });

beforeEach(() => {
  resetFilePreviewPlugins([image, markdown, fallback]);
});

describe('extensionMatcher', () => {
  it('matches the extension case-insensitively', () => {
    const matches = extensionMatcher(['png', 'jpg']);
    expect(matches('/tmp/a.png')).toBe(true);
    expect(matches('b.JPG')).toBe(true);
    expect(matches('c.png.txt')).toBe(false);
    expect(matches('png')).toBe(false);
  });
});

describe('isFilePreviewEnabled', () => {
  it('defaults to enabled for built-ins', () => {
    expect(isFilePreviewEnabled(image, {})).toBe(true);
  });

  it('honours explicit plugins.yaml overrides', () => {
    const settings: PluginSettings = { image: { enabled: false } };
    expect(isFilePreviewEnabled(image, settings)).toBe(false);
    expect(isFilePreviewEnabled(image, { image: { enabled: true } })).toBe(true);
  });

  it('external plugins are opt-in via defaultEnabled: false', () => {
    const ext = makePlugin('ext', ['foo'], { defaultEnabled: false });
    expect(isFilePreviewEnabled(ext, {})).toBe(false);
    expect(isFilePreviewEnabled(ext, { ext: { enabled: true } })).toBe(true);
  });
});

describe('resolveFilePreviewPlugin', () => {
  it('picks the first enabled matching plugin', () => {
    expect(resolveFilePreviewPlugin('/a/b.png', {})?.id).toBe('image');
    expect(resolveFilePreviewPlugin('readme.md', {})?.id).toBe('markdown');
  });

  it('falls back to the catch-all plugin', () => {
    expect(resolveFilePreviewPlugin('anything.xyz', {})?.id).toBe('text');
  });

  it('skips disabled plugins and falls through', () => {
    const settings: PluginSettings = { markdown: { enabled: false } };
    expect(resolveFilePreviewPlugin('readme.md', settings)?.id).toBe('text');
  });

  it('returns null when nothing matches', () => {
    resetFilePreviewPlugins([image, markdown]);
    expect(resolveFilePreviewPlugin('anything.xyz', {})).toBeNull();
  });

  it('newer registration replaces a plugin with the same id', () => {
    const other = makePlugin('image', ['tiff']);
    registerFilePreviewPlugin(other);
    expect(resolveFilePreviewPlugin('a.png', {})?.id).toBe('text');
    expect(resolveFilePreviewPlugin('a.tiff', {})?.id).toBe('image');
  });
});
