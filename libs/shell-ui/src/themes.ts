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
  pluginIcons?: Record<string, string>;
  /** Flat custom-icon bag (process names + plugin ids) — synced across remote viewers. */
  customIcons?: Record<string, string>;
  /** Shell terminal font family. Empty/unset = built-in monospace stack. */
  shellFontFamily?: string;
  /** Shell terminal font size in px (default 14). */
  shellFontSize?: number;
  /**
   * Shell terminal line height multiplier (default 1.2 — xterm itself
   * defaults to 1.0). Applies to terminals only, not the panel.
   */
  shellLineHeight?: number;
  /** Session/workspace panel font family. Empty/unset = app font. */
  panelFontFamily?: string;
  /** Panel font size in px — scales the panel relative to its 12px base. */
  panelFontSize?: number;
  /** Overall UI chrome scale in percent (100 = native). Excludes terminals. */
  uiZoom?: number;
  /** Render `session.summary` (set via `axn-session-summary`/`axn-session set --summary`) in the panel. */
  sessionSummaries?: boolean;
  /**
   * Terminal cell renderer: `auto` (WebGL → canvas → DOM fallback chain,
   * including WebGL context loss), `webgl`, `canvas`, or `dom` to force.
   */
  terminalRenderer?: 'auto' | 'webgl' | 'canvas' | 'dom';
  /** UI language — one of the locales bundled in libs/shell-ui (`en`, `ko`). */
  language?: 'system' | 'en' | 'ko' | 'de' | 'fr' | 'it' | 'nl' | 'zh' | 'ja';
  /**
   * Extra directories (absolute or `~/…`) the desktop file views — axn-edit,
   * axn-browse, axn-preview — may read and write, on top of `$HOME`. Applied
   * live when added; a removed root stays allowed until the app restarts.
   */
  fileAccessRoots?: string[];
  /**
   * Remote access — when true the rail shows the Remote console icon.
   * Publishing additionally needs remoteAuthorityUrl (configured inside the
   * console view). Undefined behaves as enabled-without-console (icon shows
   * only where a remote console already exists, e.g. web viewers).
   */
  remoteEnabled?: boolean;
  /**
   * Remote authority — publish this window's terminals to a Ramphastos
   * /remote hub so remote viewers (e.g. a phone browser) can attach and
   * drive them. Applied on app start.
   */
  remoteAuthorityUrl?: string;
  /** Optional user JWT for identity-bound hubs (anonymous dev hubs: unset). */
  remoteAuthorityToken?: string;
  /**
   * OIDC issuer for remote sign-in, e.g.
   * https://<host>:<port>/realms/axn-term — signs the desktop in so the hub
   * binds mirrored sessions to the account (multi-user isolation).
   */
  remoteAuthIssuer?: string;
  /** OIDC public client id used for the device-flow sign-in. */
  remoteAuthClientId?: string;
  /**
   * App log verbosity — desktop only (web has no file logger). Applies live;
   * `LOG_LEVEL` env still overrides at process start. Default: `info`.
   */
  logLevel?: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /**
   * App log folder — desktop only. Default is the OS-standard location
   * (macOS `~/Library/Logs/axn-term`); `AXN_TERM_LOG_DIR` env overrides.
   * Changing it takes effect on the next app start.
   */
  logDir?: string;
}

export const defaultSettings: AppSettings = {
  theme: 'dark',
  lightTheme: 'axn-light',
  darkTheme: 'axn-dark',
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

// Used only if the bundled theme files fail to load: Axn Dark's terminal colours.
const fallbackTheme: ThemeDefinition = {
  id: 'axn-dark',
  name: 'Axn Dark',
  mode: 'dark',
  colors: {
    background: '#141110',
    foreground: '#E9E5E2',
    cursor: '#F0A3AA',
    cursorAccent: '#141110',
    selectionBackground: '#3A3330',
    selectionForeground: '#E9E5E2',
    black: '#2A2523',
    red: '#F45B69',
    green: '#3DBB72',
    yellow: '#E3B341',
    blue: '#4F9FD0',
    magenta: '#C08FD8',
    cyan: '#59C3C3',
    white: '#CFC9C5',
    brightBlack: '#877D79',
    brightRed: '#F0A3AA',
    brightGreen: '#6FD396',
    brightYellow: '#F0C869',
    brightBlue: '#82C6DC',
    brightMagenta: '#D8B4F0',
    brightCyan: '#A2D7D7',
    brightWhite: '#F7F4F2',
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

export const defaultAutoDarkThemeId = 'axn-dark';
export const defaultAutoLightThemeId = 'axn-light';
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
  const fallbackId = mode === 'dark' ? defaultAutoDarkThemeId : defaultAutoLightThemeId;
  const id = mode === 'dark' ? settings.darkTheme : settings.lightTheme;
  // A stored id whose theme no longer ships (renamed or removed)
  // falls back to the default of the same mode, not to a dark theme.
  return getTheme(id && themeMap.has(id) ? id : fallbackId);
}

export const defaultShellFontFamily =
  '"Monaspace Neon Var", "Monaspace Neon", "Monaspace Argon Var", "Monaspace Argon", "Fira Code", "Cascadia Code", "Source Code Pro", monospace';
export const defaultShellFontSize = 14;
/**
 * xterm lineHeight multiplier. 1.0 packed rows too tightly once Monaspace
 * Neon started loading everywhere (it is bundled since Oct '24); 1.2 keeps
 * the relaxed spacing the previous fallback fonts gave.
 */
export const defaultShellLineHeight = 1.2;

/** CSS generic families — always "installed", no probe needed. */
const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

/**
 * Font existence check: draw the probe string in "family, monospace" and
 * compare widths with plain monospace — a missing font falls back to the
 * same glyph run and measures identically. Reliable for system fonts where
 * document.fonts.check() reports false positives.
 */
let fontProbeCtx: CanvasRenderingContext2D | null | undefined;
const fontProbeCache = new Map<string, boolean>();
// Webfonts resolve asynchronously — a name probed "missing" before the font
// loaded must not stay cached as missing forever.
if (typeof document !== 'undefined') {
  void document.fonts?.ready?.then(() => fontProbeCache.clear());
}
function singleFontExists(name: string): boolean {
  const cached = fontProbeCache.get(name);
  if (cached !== undefined) return cached;
  let exists = true;
  try {
    if (document.fonts?.check?.(`12px "${name}"`)) {
      exists = true;
    } else {
      if (fontProbeCtx === undefined) {
        fontProbeCtx = document.createElement('canvas').getContext('2d');
      }
      if (!fontProbeCtx) {
        exists = true;
      } else {
        const probe = 'mmmmmmmmmmWWW';
        fontProbeCtx.font = '72px monospace';
        const base = fontProbeCtx.measureText(probe).width;
        fontProbeCtx.font = `72px "${name}", monospace`;
        exists = Math.abs(fontProbeCtx.measureText(probe).width - base) > 0.01;
      }
    }
  } catch {
    exists = true;
  }
  fontProbeCache.set(name, exists);
  return exists;
}

/**
 * Does a single font family name resolve to an installed (or bundled) font?
 * Empty and generic family names count as available. Without a DOM there is
 * nothing to render with anyway, so everything counts as available.
 */
export function fontFamilyExists(family: string): boolean {
  const name = family.trim().replace(/^["']|["']$/g, '');
  if (!name) return true;
  if (GENERIC_FONT_FAMILIES.has(name.toLowerCase())) return true;
  if (typeof document === 'undefined') return true;
  return singleFontExists(name);
}

/**
 * Does a CSS font-family stack resolve to something real? A stack applies
 * when at least one listed (non-generic) family exists — a stack of only
 * missing names would fall through to the UA default (serif), which is why
 * configured fonts must be validated at apply time, not only at input time
 * (config.yaml edits bypass the settings field's own check).
 */
export function fontStackAvailable(stack: string): boolean {
  const names = stack
    .split(',')
    .map((n) => n.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  if (names.length === 0) return false;
  return names.some(
    (n) => GENERIC_FONT_FAMILIES.has(n.toLowerCase()) || fontFamilyExists(n),
  );
}

/** Resolve the shell terminal font from settings (defaults in parens). */
export function resolveShellFont(settings: AppSettings): {
  family: string;
  size: number;
  lineHeight: number;
} {
  const family = settings.shellFontFamily?.trim();
  return {
    // A configured font only applies when it actually exists — otherwise
    // every config.yaml typo would restyle the terminal in fallback serif.
    family: family && fontStackAvailable(family) ? family : defaultShellFontFamily,
    // xterm fontSize wants integer px.
    size: Math.round(
      (settings.shellFontSize && settings.shellFontSize > 0
        ? settings.shellFontSize
        : defaultShellFontSize) *
        (settings.uiZoom && settings.uiZoom > 0 ? settings.uiZoom / 100 : 1),
    ),
    lineHeight:
      settings.shellLineHeight && settings.shellLineHeight > 0
        ? settings.shellLineHeight
        : defaultShellLineHeight,
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
