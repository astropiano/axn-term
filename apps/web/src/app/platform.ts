import type { LogLevel, ShellPlatform } from '@axn-term/shell-ui';

const STATE_PREFIX = 'axn-term:state:';
const PLUGINS_KEY = 'axn-term:plugins.yaml';

function downloadText(content: string, defaultName: string): Promise<void> {
  const blob = new Blob([content]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(a.href);
  return Promise.resolve();
}

function pickTextFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      void file.text().then(resolve, () => resolve(null));
    };
    // Browsers may not fire a cancel event; treat close-without-file as cancel.
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * Browser ShellPlatform: localStorage persistence, download/file-picker for
 * workspace sets, no window lifecycle (the browser tab owns that), no
 * external `.mjs` plugin loading.
 */
export function browserPlatform(username: string | null): ShellPlatform {
  const queryLocalFonts = (window as unknown as {
    queryLocalFonts?: () => Promise<{ family: string }[]>;
  }).queryLocalFonts;
  const listFonts = queryLocalFonts
    ? async () => {
        try {
          const fonts = await queryLocalFonts();
          return [...new Set(fonts.map((f) => f.family))].sort();
        } catch {
          return [] as string[]; // permission denied / unsupported
        }
      }
    : undefined;

  return {
    ...(listFonts ? { listFonts } : {}),
    homeDir: () => Promise.resolve(username ? `/home/${username}` : '/'),
    emitLog: (level: LogLevel, target: string, message: string) => {
      const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'debug';
      console[fn](`[${target}] ${message}`);
    },
    stateStore: {
      load: (windowId) => {
        const raw = localStorage.getItem(STATE_PREFIX + windowId);
        return Promise.resolve(raw ? (JSON.parse(raw) as unknown) : null);
      },
      save: (windowId, state) => {
        // A failed write (QuotaExceededError) must reject: the caller keeps
        // the state dirty and retries instead of treating it as saved.
        try {
          localStorage.setItem(STATE_PREFIX + windowId, JSON.stringify(state));
        } catch (e) {
          return Promise.reject(e);
        }
        return Promise.resolve();
      },
      delete: (windowId) => {
        localStorage.removeItem(STATE_PREFIX + windowId);
        return Promise.resolve();
      },
    },
    pluginSettingsStore: {
      read: async () => {
        const stored = localStorage.getItem(PLUGINS_KEY);
        if (stored !== null) return stored;
        // Optional first-run seed (scenario deployments): fetch a YAML file
        // served from the web root until the user writes their own settings.
        const seedUrl = import.meta.env.VITE_PLUGINS_YAML_SEED as string | undefined;
        if (!seedUrl) return null;
        try {
          const res = await fetch(seedUrl);
          // Dev servers answer unknown paths with the SPA index — never
          // accept an HTML fallback as plugin settings.
          if (!res.ok || res.headers.get('content-type')?.includes('html')) return null;
          const text = await res.text();
          return text.trimStart().startsWith('<') ? null : text;
        } catch {
          return null;
        }
      },
      write: (content) => {
        localStorage.setItem(PLUGINS_KEY, content);
        return Promise.resolve();
      },
    },
    workspaceSetStorage: {
      save: (content, defaultName) => downloadText(content, defaultName),
      load: () => pickTextFile('.json,application/json'),
    },
    configFileStorage: {
      save: (content, defaultName) => downloadText(content, defaultName),
      load: () => pickTextFile('.yaml,.yml,text/yaml'),
    },
    // A browser tab never self-closes when the last session exits.
    autoCloseWhenEmpty: false,
  };
}
