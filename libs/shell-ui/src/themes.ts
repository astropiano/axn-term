import type { ITheme } from '@xterm/xterm';
import { load as loadYaml } from 'js-yaml';

export type ThemeMode = 'light' | 'dark' | 'auto';
export type EffectiveTheme = 'light' | 'dark';

export interface ThemeColors {
  background: string;
  foreground: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
  orange?: string;
  violet?: string;
}

export interface ThemeUi {
  bg?: string;
  bgSecondary?: string;
  surface?: string;
  surfaceHover?: string;
  text?: string;
  textSecondary?: string;
  textInverted?: string;
  border?: string;
  accent?: string;
  accentHover?: string;
  cursor?: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  mode: ThemeMode;
  colors: ThemeColors;
  ui?: ThemeUi;
}

export interface AppSettings {
  theme: ThemeMode;
  lightTheme?: string;
  darkTheme?: string;
  defaultShell?: string;
  devinTaskParserEnabled?: boolean;
  sessionIcons?: Record<string, string>;
  /** Shell terminal font family. Empty/unset = built-in monospace stack. */
  shellFontFamily?: string;
  /** Shell terminal font size in px (default 14). */
  shellFontSize?: number;
  /** Session/workspace panel font family. Empty/unset = app font. */
  panelFontFamily?: string;
  /** Panel font size in px — scales the panel relative to its 12px base. */
  panelFontSize?: number;
  /** Render `session.summary` (set via `axn-session-summary`) in the panel. */
  sessionSummaries?: boolean;
  /**
   * Terminal cell renderer: `auto` (WebGL → canvas → DOM fallback chain,
   * including WebGL context loss), `webgl`, `canvas`, or `dom` to force.
   */
  terminalRenderer?: 'auto' | 'webgl' | 'canvas' | 'dom';
  /** UI language — one of the locales bundled in libs/shell-ui (`en`, `ko`). */
  language?: 'en' | 'ko';
  /**
   * Extra directories (absolute or `~/…`) the desktop file views — axn-edit,
   * axn-browse, axn-preview — may read and write, on top of `$HOME`. Applied
   * live when added; a removed root stays allowed until the app restarts.
   */
  fileAccessRoots?: string[];
}

export const defaultSettings: AppSettings = {
  theme: 'auto',
  lightTheme: 'solarized-light',
  darkTheme: 'solarized-dark',
  defaultShell: '',
  devinTaskParserEnabled: true,
  sessionSummaries: true,
  sessionIcons: {
    devin: 'Bot',
    claude: 'Bot',
    'claude-code': 'Bot',
    aider: 'Bot',
    codex: 'Bot',
  },
};

const themeFiles = import.meta.glob('../themes/*.{json,yaml,yml}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function normalizeTheme(raw: unknown): ThemeDefinition | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const t = raw as Partial<ThemeDefinition>;
  if (!t.id || !t.name || !t.mode || !t.colors) {
    return null;
  }

  return {
    id: String(t.id),
    name: String(t.name),
    mode: t.mode === 'light' ? 'light' : 'dark',
    colors: t.colors,
    ui: t.ui,
  };
}

const fallbackTheme: ThemeDefinition = {
  id: 'solarized-dark',
  name: 'Solarized Dark',
  mode: 'dark',
  colors: {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    selectionForeground: '#839496',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
};

export const themeDefinitions: ThemeDefinition[] = Object.entries(themeFiles)
  .map(([path, content]) => {
    try {
      const parsed =
        path.endsWith('.json') ? JSON.parse(content) : loadYaml(content);
      return normalizeTheme(parsed);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`Failed to load theme ${path}:`, e);
      return null;
    }
  })
  .filter((t): t is ThemeDefinition => t !== null)
  .sort((a, b) => a.name.localeCompare(b.name));

export const themeMap = new Map(themeDefinitions.map((t) => [t.id, t]));

export const defaultAutoDarkThemeId = 'solarized-dark';
export const defaultAutoLightThemeId = 'solarized-light';
export const defaultThemeId = defaultAutoDarkThemeId;

export function getTheme(id: string | undefined): ThemeDefinition {
  return (id ? themeMap.get(id) : undefined) ?? fallbackTheme;
}

export function getEffectiveMode(mode: ThemeMode): EffectiveTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  if (mode !== 'auto') return 'dark';
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveTheme(settings: AppSettings): ThemeDefinition {
  const mode = getEffectiveMode(settings.theme);
  const id = mode === 'dark'
    ? (settings.darkTheme ?? defaultAutoDarkThemeId)
    : (settings.lightTheme ?? defaultAutoLightThemeId);
  return getTheme(id);
}

export const defaultShellFontFamily =
  '"Monaspace Neon Var", "Monaspace Neon", "Monaspace Argon Var", "Monaspace Argon", "Fira Code", "Cascadia Code", "Source Code Pro", monospace';
export const defaultShellFontSize = 14;

/** Resolve the shell terminal font from settings (defaults in parens). */
export function resolveShellFont(settings: AppSettings): { family: string; size: number } {
  return {
    family: settings.shellFontFamily?.trim() || defaultShellFontFamily,
    size:
      settings.shellFontSize && settings.shellFontSize > 0
        ? settings.shellFontSize
        : defaultShellFontSize,
  };
}

export function getXtermColors(theme: ThemeDefinition): ITheme {
  const c = theme.colors;
  return {
    background: c.background,
    foreground: c.foreground,
    cursor: c.cursor,
    cursorAccent: c.cursorAccent ?? c.background,
    selectionBackground: c.selectionBackground,
    selectionForeground: c.selectionForeground ?? c.foreground,
    black: c.black,
    red: c.red,
    green: c.green,
    yellow: c.yellow,
    blue: c.blue,
    magenta: c.magenta,
    cyan: c.cyan,
    white: c.white,
    brightBlack: c.brightBlack,
    brightRed: c.brightRed,
    brightGreen: c.brightGreen,
    brightYellow: c.brightYellow,
    brightBlue: c.brightBlue,
    brightMagenta: c.brightMagenta,
    brightCyan: c.brightCyan,
    brightWhite: c.brightWhite,
  };
}

export function applyTheme(theme: ThemeDefinition) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const c = theme.colors;
  const ui = theme.ui ?? {};

  const vars: Record<string, string | undefined> = {
    '--bg': ui.bg ?? c.background,
    '--terminal-bg': c.background,
    '--bg-secondary': ui.bgSecondary ?? c.selectionBackground ?? c.background,
    '--surface': ui.surface ?? c.selectionBackground ?? c.background,
    '--surface-hover': ui.surfaceHover ?? c.brightBlack ?? c.background,
    '--text-primary': ui.text ?? c.foreground,
    '--text-secondary': ui.textSecondary ?? c.brightBlack ?? c.foreground,
    '--text-inverted':
      ui.textInverted ?? (theme.mode === 'dark' ? '#000000' : '#ffffff'),
    '--border': ui.border ?? c.brightBlack ?? c.background,
    '--accent': ui.accent ?? c.blue,
    '--accent-hover': ui.accentHover ?? c.cyan,
    '--cursor': ui.cursor ?? c.cursor ?? c.foreground,
    '--green': c.green,
    '--red': c.red,
    '--yellow': c.yellow,
    '--blue': c.blue,
    '--magenta': c.magenta,
    '--cyan': c.cyan,
    // Themes rarely define a dedicated orange — falling back to brightRed
    // made "warning" indistinguishable from "critical", so default to a true
    // orange instead.
    '--orange': c.orange ?? '#f97316',
    '--violet': c.violet ?? c.brightMagenta,
  };

  for (const [key, value] of Object.entries(vars)) {
    if (value) {
      root.style.setProperty(key, value);
    }
  }

  root.dataset.theme = theme.mode;
  root.style.colorScheme = theme.mode;
}
