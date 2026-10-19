import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PluginSettingsStore } from '../platform';
import { load as loadYaml, dump } from 'js-yaml';
import type { PluginSettings, PluginSettingsSection } from './pluginSettings';
import {
  defaultPluginSettings,
  normalizePluginSettings,
  pluginSettingsToYaml,
} from './pluginSettings';
import { axnLog } from './log';
import { setAppAttention } from './attention';

/** App-level attention source key raised while plugins.yaml fails to parse. */
export const PLUGINS_ATTENTION_SOURCE = 'Invalid plugin settings';

export type PluginsParseResult =
  | { ok: true; settings: PluginSettings }
  | { ok: false; error: string };

/**
 * Parse plugins.yaml. A syntax error or a non-mapping document (list,
 * scalar) is invalid; an empty or comment-only file is valid and yields the
 * defaults (js-yaml throws on those).
 */
export function parsePluginsYaml(raw: string): PluginsParseResult {
  if (raw.split('\n').every((line) => !line.trim() || line.trim().startsWith('#'))) {
    return { ok: true, settings: normalizePluginSettings(null) };
  }
  try {
    const parsed = loadYaml(raw) as unknown;
    if (parsed != null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
      return { ok: false, error: 'not a YAML mapping' };
    }
    return { ok: true, settings: normalizePluginSettings(parsed) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function invalidPluginsAttention(error: string) {
  return {
    level: 'warning' as const,
    message: `plugins.yaml is invalid — keeping current plugin settings, changes are not saved until it is fixed (${error})`,
  };
}

const defaultYaml = `# axn-term plugin configuration
# Place this file at ~/.axn-term/plugins.yaml
#
# Every plugin can be toggled with '<id>.enabled'. Built-in plugins default to
# enabled; external plugins (~/.axn-term/plugins/*.mjs) are always opt-in.
#
# File-preview plugins (preview tabs via 'axn-preview <path>', the Preview
# action on file hover cards, and clickable image thumbnails):
#   image, svg, markdown, asciidoc, mermaid, text (catch-all fallback)
#   e.g. 'markdown.enabled: false' disables markdown rendering.

devin:
  # Automatically run 'devin -r <session>' when a session that previously ran
  # devin is reopened. The devin session name is always remembered; when this
  # is disabled, 'axn-devin-resume' can be typed in the shell to resume it.
  restore-session: false
  # Flag the session as "needs attention" when devin's screen stays quiet for
  # this many seconds (finished or waiting for input). 0 disables.
  # idle-timeout-seconds: 45

# claude:
#   enabled: true           # enable the Claude Code plugin
#   restore-session: true   # run 'claude -c' when a session that ran claude is reopened

# git-status:
#   show-in-header: true    # branch + status indicators in the session header

# glab-mr:
#   show-in-header: true    # MR info in the session header
#   # refresh-interval-seconds: 120
#   # hostname: gitlab.example.com
`;

interface PluginSettingsContextValue {
  pluginSettings: PluginSettings;
  loaded: boolean;
  setPluginSettings: (settings: PluginSettings) => void;
  /**
   * Shallow-merge `patch` into one plugin's section and persist the whole
   * config back to plugins.yaml (comments in the file are not preserved).
   * Used by Settings → Plugins; also fine for toggling `enabled`.
   */
  updatePluginSection: (settingsKey: string, patch: PluginSettingsSection) => void;
}

const PluginSettingsContext = createContext<PluginSettingsContextValue | null>(null);

export function PluginSettingsProvider({
  store,
  children,
}: {
  store: PluginSettingsStore;
  children: React.ReactNode;
}) {
  const [pluginSettings, setPluginSettings] = useState<PluginSettings>(defaultPluginSettings);
  const [loaded, setLoaded] = useState(false);
  // Raw YAML of our own last write — the file watcher ignores it so a
  // settings-modal save never echoes back as an "external" reload.
  const lastWrittenRef = useRef<string | null>(null);
  // Latest settings for the watch callback's no-op comparison.
  const settingsRef = useRef(pluginSettings);
  settingsRef.current = pluginSettings;
  // Set while the on-disk plugins.yaml is known to be invalid: UI changes
  // stay in memory and never overwrite the user's broken file. Cleared once
  // a valid file is read again.
  const fileInvalidRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await store.read();
        if (cancelled) return;
        lastWrittenRef.current = raw;
        if (raw === null) {
          axnLog('info', 'plugin-settings', 'plugins.yaml missing; creating default');
          try {
            lastWrittenRef.current = defaultYaml;
            await store.write(defaultYaml);
          } catch (err) {
            axnLog('error', 'plugin-settings', `failed to create default plugins.yaml: ${String(err)}`);
          }
          setPluginSettings(defaultPluginSettings);
        } else {
          const res = parsePluginsYaml(raw);
          if (res.ok) {
            setPluginSettings(res.settings);
            axnLog('debug', 'plugin-settings', `loaded plugins.yaml (raw=${raw.trim().slice(0, 200)})`);
          } else {
            fileInvalidRef.current = true;
            setAppAttention(PLUGINS_ATTENTION_SOURCE, invalidPluginsAttention(res.error));
            axnLog('warn', 'plugin-settings', `invalid plugins.yaml, using defaults: ${res.error}`);
            setPluginSettings(defaultPluginSettings);
          }
        }
        setLoaded(true);
      } catch (err) {
        axnLog('error', 'plugin-settings', `failed to load plugins.yaml: ${String(err)}`);
        if (!cancelled) {
          setPluginSettings(defaultPluginSettings);
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  // Live-reload: the desktop store polls read_plugins; on a changed file we
  // re-apply it. Own writes echo back and are skipped via lastWrittenRef;
  // external edits are applied as-is — nothing writes the file back, so the
  // user's formatting/comments survive. Invalid YAML keeps the last valid
  // settings, raises an app attention flag and blocks UI writes until the
  // file parses again.
  useEffect(() => {
    if (!store.watch) return;
    return store.watch((raw) => {
      if (raw === null) return;
      // While the file is known-invalid every read is re-parsed — reverting
      // it to the last written content must clear the flag.
      if (raw === lastWrittenRef.current && !fileInvalidRef.current) return;
      const res = parsePluginsYaml(raw);
      if (!res.ok) {
        fileInvalidRef.current = true;
        setAppAttention(PLUGINS_ATTENTION_SOURCE, invalidPluginsAttention(res.error));
        axnLog('warn', 'plugin-settings', `ignoring invalid plugins.yaml: ${res.error}`);
        return;
      }
      fileInvalidRef.current = false;
      setAppAttention(PLUGINS_ATTENTION_SOURCE, null);
      lastWrittenRef.current = raw;
      if (JSON.stringify(res.settings) === JSON.stringify(settingsRef.current)) return;
      setPluginSettings(res.settings);
      axnLog('info', 'plugin-settings', 'plugins.yaml changed on disk — reloaded');
    });
  }, [store]);

  function updatePluginSection(settingsKey: string, patch: PluginSettingsSection) {
    const next: PluginSettings = {
      ...settingsRef.current,
      [settingsKey]: { ...(settingsRef.current[settingsKey] ?? {}), ...patch },
    };
    settingsRef.current = next;
    setPluginSettings(next);
    if (fileInvalidRef.current) {
      axnLog('warn', 'plugin-settings', 'plugins.yaml is invalid — not overwriting it');
      return;
    }
    const yaml = dump(pluginSettingsToYaml(next), { sortKeys: true });
    lastWrittenRef.current = yaml;
    store.write(yaml).catch((err) =>
      axnLog('error', 'plugin-settings', `failed to write plugins.yaml: ${String(err)}`),
    );
  }

  const value = useMemo(
    () => ({ pluginSettings, loaded, setPluginSettings, updatePluginSection }),
    [pluginSettings, loaded],
  );

  return (
    <PluginSettingsContext.Provider value={value}>{children}</PluginSettingsContext.Provider>
  );
}

export function usePluginSettings(): PluginSettingsContextValue {
  const ctx = useContext(PluginSettingsContext);
  if (!ctx) throw new Error('usePluginSettings must be used within PluginSettingsProvider');
  return ctx;
}
