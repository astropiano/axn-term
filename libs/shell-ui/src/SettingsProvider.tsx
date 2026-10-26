import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { I18nProvider } from '@lingui/react';
import { load as loadYaml, dump as dumpYaml } from 'js-yaml';
import type { AppSettings, ThemeDefinition, ThemeMode } from './themes';
import { applyTheme, defaultSettings, resolveTheme, themeMap } from './themes';
import type { AppConfigStore } from './platform';
import { setAppAttention } from './app/attention';
import { activateLanguage, i18n } from './i18n';

const STORAGE_KEY = 'axn-term:settings';

interface SettingsContextValue {
  settings: AppSettings;
  activeTheme: ThemeDefinition;
  setTheme: (theme: ThemeMode) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  /** Replaces the whole settings object — used by config import. */
  replaceSettings: (next: Partial<AppSettings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

/** Defaults + stored partial, incl. the legacy theme-id migration. */
export function mergeSettings(parsed: Partial<AppSettings>): AppSettings {
  const merged = { ...defaultSettings, ...parsed };
  const mode = merged.theme;
  if (mode !== 'light' && mode !== 'dark' && mode !== 'auto') {
    const def = themeMap.get(mode);
    merged.theme = def?.mode === 'light' ? 'light' : 'dark';
    if (def?.mode === 'light') {
      merged.lightTheme = def.id;
    } else if (def) {
      merged.darkTheme = def.id;
    }
  }
  return merged;
}

/** Serialize settings for config.yaml / export — drops undefined keys. */
export function settingsToYaml(settings: AppSettings): string {
  return dumpYaml(JSON.parse(JSON.stringify(settings)) as Record<string, unknown>);
}

/** Parse a config.yaml / import payload; null when not a plain object. */
export function settingsFromYaml(yaml: string): Partial<AppSettings> | null {
  const parsed: unknown = loadYaml(yaml);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Partial<AppSettings>;
}

/** App-level attention source key raised while config.yaml fails to parse. */
export const CONFIG_ATTENTION_SOURCE = 'Invalid settings';

export type ConfigParseResult =
  | { ok: true; settings: Partial<AppSettings> }
  | { ok: false; error: string };

/** settingsFromYaml with the error surfaced — used by the file watcher. */
export function parseConfigYaml(yaml: string): ConfigParseResult {
  try {
    const parsed = settingsFromYaml(yaml);
    if (!parsed) return { ok: false, error: 'not a YAML mapping' };
    return { ok: true, settings: parsed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function invalidConfigAttention(error: string) {
  return {
    level: 'warning' as const,
    message: `config.yaml is invalid — keeping current settings, changes are not saved until it is fixed (${error})`,
  };
}

function readLocalStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function initialSettings(): AppSettings {
  const raw = readLocalStorage();
  if (!raw) return defaultSettings;
  try {
    return mergeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return defaultSettings;
  }
}

function saveLocalStorage(settings: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

export function SettingsProvider({
  children,
  configStore,
}: {
  children: React.ReactNode;
  /** On-disk config store — desktop ~/.axn-term/config.yaml; absent on web. */
  configStore?: AppConfigStore;
}) {
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [activeTheme, setActiveTheme] = useState<ThemeDefinition>(() =>
    resolveTheme(settings)
  );
  // Writes are held back until the file load settles — otherwise the
  // localStorage initial state would clobber an existing config.yaml.
  const storeReadyRef = useRef(!configStore);
  // Raw YAML of our own last write — the file watcher ignores it so a save
  // never echoes back as an "external" reload.
  const lastWrittenRef = useRef<string | null>(null);
  // Set when settings were applied from a file-watch event: the resulting
  // save must be skipped or the user's formatting/comments get clobbered
  // (and invalid files would be overwritten by the write-back).
  const skipNextSaveRef = useRef(false);
  // Set while the on-disk config.yaml is known to be invalid: changes stay
  // in memory and are never written over the user's broken file. Cleared
  // once a valid file is read again.
  const fileInvalidRef = useRef(false);

  // Desktop bootstrap: config.yaml is the source of truth once it exists;
  // a legacy localStorage blob is migrated into it (or the file is seeded
  // with the current settings) and the blob removed. An invalid existing
  // file raises an attention flag and is left untouched.
  useEffect(() => {
    if (!configStore) return;
    let cancelled = false;
    void (async () => {
      try {
        const yaml = await configStore.load();
        const legacyRaw = readLocalStorage();
        if (yaml?.trim()) {
          const res = parseConfigYaml(yaml);
          lastWrittenRef.current = yaml;
          if (res.ok) {
            fileInvalidRef.current = false;
            storeReadyRef.current = true;
            if (!cancelled) {
              skipNextSaveRef.current = true;
              setSettings(mergeSettings(res.settings));
            }
          } else {
            fileInvalidRef.current = true;
            setAppAttention(CONFIG_ATTENTION_SOURCE, invalidConfigAttention(res.error));
            storeReadyRef.current = true;
          }
        } else {
          storeReadyRef.current = true;
          const toPersist = legacyRaw
            ? mergeSettings(JSON.parse(legacyRaw) as Partial<AppSettings>)
            : settingsRef.current;
          const out = settingsToYaml(toPersist);
          lastWrittenRef.current = out;
          await configStore.save(out);
          if (legacyRaw && !cancelled) setSettings(toPersist);
        }
        if (legacyRaw) {
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            // ignore
          }
        }
      } catch {
        storeReadyRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [configStore]);

  // Live-reload: the desktop configStore polls read_config; on a changed
  // file we re-apply it (or flag it as invalid). Own writes are echoed back
  // and skipped via lastWrittenRef; external edits suppress the write-back
  // so the file keeps the user's formatting/comments.
  useEffect(() => {
    if (!configStore?.watch) return;
    return configStore.watch((raw) => {
      if (raw === null) return;
      // While the file is known-invalid every read is re-parsed — reverting
      // it to the last written content must clear the flag.
      if (raw === lastWrittenRef.current && !fileInvalidRef.current) {
        setAppAttention(CONFIG_ATTENTION_SOURCE, null);
        return;
      }
      const res = parseConfigYaml(raw);
      if (!res.ok) {
        fileInvalidRef.current = true;
        setAppAttention(CONFIG_ATTENTION_SOURCE, invalidConfigAttention(res.error));
        return;
      }
      fileInvalidRef.current = false;
      setAppAttention(CONFIG_ATTENTION_SOURCE, null);
      const next = mergeSettings(res.settings);
      if (JSON.stringify(next) === JSON.stringify(settingsRef.current)) {
        lastWrittenRef.current = raw;
        return;
      }
      lastWrittenRef.current = raw;
      skipNextSaveRef.current = true;
      setSettings(next);
    });
  }, [configStore]);

  useEffect(() => {
    const theme = resolveTheme(settings);
    setActiveTheme(theme);
    applyTheme(theme);
    if (configStore) {
      if (storeReadyRef.current) {
        if (skipNextSaveRef.current) {
          skipNextSaveRef.current = false;
        } else if (!fileInvalidRef.current) {
          const out = settingsToYaml(settings);
          lastWrittenRef.current = out;
          configStore.save(out).catch(() => {});
        }
      }
    } else {
      saveLocalStorage(settings);
    }
  }, [settings, configStore]);

  useEffect(() => {
    if (settings.theme !== 'auto') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => {
      const theme = resolveTheme(settings);
      setActiveTheme(theme);
      applyTheme(theme);
    };
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [settings]);

  useEffect(() => {
    const apply = () => activateLanguage(settings.language ?? 'system');
    apply();
    // 'system' follows the OS/browser language live
    window.addEventListener('languagechange', apply);
    return () => window.removeEventListener('languagechange', apply);
  }, [settings.language]);

  const setTheme = useCallback((theme: ThemeMode) => {
    setSettings((prev) => ({ ...prev, theme }));
  }, []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const replaceSettings = useCallback((next: Partial<AppSettings>) => {
    setSettings(mergeSettings(next));
  }, []);

  const value = useMemo(
    () => ({ settings, activeTheme, setTheme, updateSettings, replaceSettings }),
    [settings, activeTheme, setTheme, updateSettings, replaceSettings]
  );

  return (
    <I18nProvider i18n={i18n}>
      <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
    </I18nProvider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
