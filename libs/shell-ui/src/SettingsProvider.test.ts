// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_ATTENTION_SOURCE,
  mergeSettings,
  parseConfigYaml,
  SettingsProvider,
  settingsFromYaml,
  settingsToYaml,
  useSettings,
} from './SettingsProvider';
import {
  parsePluginsYaml,
  PLUGINS_ATTENTION_SOURCE,
  PluginSettingsProvider,
  usePluginSettings,
} from './app/PluginSettingsProvider';
import { setAppAttention, useAppAttention } from './app/attention';
import type { AppConfigStore, PluginSettingsStore } from './platform';
import { defaultSettings } from './themes';
import type { AppSettings } from './themes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('mergeSettings', () => {
  it('fills missing keys from defaults', () => {
    const merged = mergeSettings({ theme: 'dark' });
    expect(merged.theme).toBe('dark');
    expect(merged.sessionIcons?.devin).toBe(defaultSettings.sessionIcons?.devin);
  });

  it('migrates a stored theme id into mode + slot', () => {
    const merged = mergeSettings({ theme: 'dracula' as AppSettings['theme'] });
    expect(['light', 'dark']).toContain(merged.theme);
    expect(merged.darkTheme).toBe('dracula');
  });
});

describe('settingsToYaml / settingsFromYaml', () => {
  it('round-trips a full settings object', () => {
    const yaml = settingsToYaml(defaultSettings);
    const parsed = settingsFromYaml(yaml);
    expect(parsed).toEqual(JSON.parse(JSON.stringify(defaultSettings)));
  });

  it('drops undefined-valued keys', () => {
    const yaml = settingsToYaml({ ...defaultSettings, lightTheme: undefined });
    expect(yaml).not.toContain('lightTheme');
  });

  it('rejects non-mapping yaml', () => {
    expect(settingsFromYaml('- just\n- a\n- list\n')).toBeNull();
    expect(settingsFromYaml('42')).toBeNull();
  });
});

describe('parseConfigYaml', () => {
  it('returns ok with the parsed settings', () => {
    const res = parseConfigYaml('theme: dark\n');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.settings.theme).toBe('dark');
  });

  it('reports a syntax error instead of throwing', () => {
    const res = parseConfigYaml('theme: [unclosed\n');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
  });

  it('rejects non-mapping documents', () => {
    expect(parseConfigYaml('- a\n- b\n').ok).toBe(false);
    expect(parseConfigYaml('42').ok).toBe(false);
  });
});

const INVALID_YAML = 'theme: [unclosed\n';

let root: Root | undefined;
let attention: Record<string, unknown> = {};

function AttentionProbe() {
  attention = useAppAttention();
  return null;
}

async function render(element: ReturnType<typeof createElement>) {
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(element));
  // Let the async initial load settle.
  await act(async () => {});
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  setAppAttention(CONFIG_ATTENTION_SOURCE, null);
  setAppAttention(PLUGINS_ATTENTION_SOURCE, null);
});

describe('SettingsProvider with an invalid config.yaml', () => {
  function setup(initial: string) {
    let watchCb: (yaml: string | null) => void = () => {};
    const store: AppConfigStore = {
      load: () => Promise.resolve(initial),
      save: vi.fn(() => Promise.resolve()),
      watch: (cb) => {
        watchCb = cb;
        return () => {};
      },
    };
    let ctx!: ReturnType<typeof useSettings>;
    function Probe() {
      ctx = useSettings();
      return null;
    }
    const element = createElement(
      SettingsProvider,
      { configStore: store },
      createElement(Probe),
      createElement(AttentionProbe),
    );
    return { store, element, ctx: () => ctx, fire: (raw: string | null) => watchCb(raw) };
  }

  it('flags the file and never writes over it', async () => {
    const t = setup(INVALID_YAML);
    await render(t.element);
    expect(attention[CONFIG_ATTENTION_SOURCE]).toBeTruthy();
    // The watcher's first read echoes the same broken file: still flagged.
    await act(async () => t.fire(INVALID_YAML));
    expect(attention[CONFIG_ATTENTION_SOURCE]).toBeTruthy();

    await act(async () => t.ctx().updateSettings({ shellFontSize: 20 }));
    expect(t.ctx().settings.shellFontSize).toBe(20); // kept in memory
    expect(t.store.save).not.toHaveBeenCalled();
  });

  it('blocks writes after the watcher sees an invalid edit, resumes once valid', async () => {
    const t = setup('theme: dark\n');
    await render(t.element);
    await act(async () => t.fire(INVALID_YAML));
    expect(attention[CONFIG_ATTENTION_SOURCE]).toBeTruthy();
    await act(async () => t.ctx().updateSettings({ shellFontSize: 20 }));
    expect(t.store.save).not.toHaveBeenCalled();

    // A valid file is applied as-is (no write-back) and clears the flag…
    await act(async () => t.fire('theme: light\n'));
    expect(attention[CONFIG_ATTENTION_SOURCE]).toBeUndefined();
    expect(t.ctx().settings.theme).toBe('light');
    expect(t.store.save).not.toHaveBeenCalled();
    // …after which UI changes are written again.
    await act(async () => t.ctx().updateSettings({ shellFontSize: 18 }));
    expect(t.store.save).toHaveBeenCalledTimes(1);
  });

  it('clears the flag when the file is reverted to the last written content', async () => {
    const t = setup('theme: dark\n');
    await render(t.element);
    await act(async () => t.fire(INVALID_YAML));
    await act(async () => t.fire('theme: dark\n'));
    expect(attention[CONFIG_ATTENTION_SOURCE]).toBeUndefined();
    await act(async () => t.ctx().updateSettings({ shellFontSize: 18 }));
    expect(t.store.save).toHaveBeenCalledTimes(1);
  });
});

describe('parsePluginsYaml', () => {
  it('accepts mappings and empty documents', () => {
    const res = parsePluginsYaml('devin:\n  restore-session: true\n');
    expect(res.ok).toBe(true);
    expect(parsePluginsYaml('').ok).toBe(true);
    expect(parsePluginsYaml('# devin:\n#   restore-session: true\n').ok).toBe(true);
  });

  it('rejects syntax errors and non-mapping documents', () => {
    expect(parsePluginsYaml('devin: [unclosed\n').ok).toBe(false);
    expect(parsePluginsYaml('- a\n- b\n').ok).toBe(false);
  });
});

describe('PluginSettingsProvider with an invalid plugins.yaml', () => {
  function setup(initial: string) {
    let watchCb: (yaml: string | null) => void = () => {};
    const store: PluginSettingsStore = {
      read: () => Promise.resolve(initial),
      write: vi.fn(() => Promise.resolve()),
      watch: (cb) => {
        watchCb = cb;
        return () => {};
      },
    };
    let ctx!: ReturnType<typeof usePluginSettings>;
    function Probe() {
      ctx = usePluginSettings();
      return null;
    }
    const element = createElement(
      PluginSettingsProvider,
      { store },
      createElement(Probe),
      createElement(AttentionProbe),
    );
    return { store, element, ctx: () => ctx, fire: (raw: string | null) => watchCb(raw) };
  }

  it('flags the file and never writes over it', async () => {
    const t = setup('devin: [unclosed\n');
    await render(t.element);
    expect(attention[PLUGINS_ATTENTION_SOURCE]).toBeTruthy();
    await act(async () => t.fire('devin: [unclosed\n'));
    expect(attention[PLUGINS_ATTENTION_SOURCE]).toBeTruthy();

    await act(async () => t.ctx().updatePluginSection('claude', { enabled: true }));
    expect(t.ctx().pluginSettings.claude?.enabled).toBe(true);
    expect(t.store.write).not.toHaveBeenCalled();
  });

  it('resumes writes once a valid file is read again', async () => {
    const t = setup('devin:\n  restore-session: false\n');
    await render(t.element);
    await act(async () => t.fire('- not\n- a mapping\n'));
    expect(attention[PLUGINS_ATTENTION_SOURCE]).toBeTruthy();
    await act(async () => t.ctx().updatePluginSection('claude', { enabled: true }));
    expect(t.store.write).not.toHaveBeenCalled();

    await act(async () => t.fire('devin:\n  restore-session: true\n'));
    expect(attention[PLUGINS_ATTENTION_SOURCE]).toBeUndefined();
    expect(t.ctx().pluginSettings.devin?.restoreSession).toBe(true);
    await act(async () => t.ctx().updatePluginSection('claude', { enabled: true }));
    expect(t.store.write).toHaveBeenCalledTimes(1);
  });
});
