import type { ITheme } from '@xterm/xterm';
import type { KnownServer } from '@axn-term/session-backend';
import { load as loadYaml } from 'js-yaml';
import { shellPlatform } from './platform';

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
  /**
   * Optional overrides for the derived design tokens in styles.css. Unset,
   * each is computed there from the values above (color-mix), so a theme
   * only needs these to pin an exact colour.
   */
  /** Rail, session panel and window base. */
  chrome?: string;
  /** Cards on the content pane. */
  raised?: string;
  /** Menus, tooltips, badges. */
  elevated?: string;
  /** "Needs you" colour (default: the theme's red). */
  attention?: string;
}

/** Named tag colours every theme provides (`themeTagPalette`). */
export const TAG_SLOTS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta'] as const;
export type TagSlot = (typeof TAG_SLOTS)[number];

export function isTagSlot(value: unknown): value is TagSlot {
  return typeof value === 'string' && (TAG_SLOTS as readonly string[]).includes(value);
}

export interface ThemeDefinition {
  id: string;
  name: string;
  mode: ThemeMode;
  colors: ThemeColors;
  ui?: ThemeUi;
  /** Optional hex per tag slot; unset slots come from the terminal colours. */
  tagColors?: Partial<Record<TagSlot, string>>;
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
  /**
   * Interface font family — rail, session panel, tabs, panels, dialogs.
   * Empty/unset = the system UI font. Terminals and editors keep their
   * monospace font.
   */
  uiFontFamily?: string;
  /** Session/workspace panel font family. Empty/unset = interface font. */
  panelFontFamily?: string;
  /** Panel font size in px — scales the panel relative to its 12px base. */
  panelFontSize?: number;
  /** Overall UI chrome scale in percent (100 = native). Excludes terminals. */
  uiZoom?: number;
  /** Render `session.summary` (set via `axn-session-summary`/`axn-session set --summary`) in the panel. */
  sessionSummaries?: boolean;
  /**
   * How a session card in the panel is assembled from session fields —
   * see `app/sessionCardLayout.ts`. Unset = the default layout.
   */
  sessionCard?: import('./app/sessionCardLayout').SessionCardLayout;
  /**
   * Where the panel's "new session" affordance lives: a ghost row at the
   * end of each workspace's session list (`list`), a `+` button in the
   * workspace header (`header`), or `both` (default).
   */
  newSessionButton?: 'list' | 'header' | 'both';
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
  /**
   * The server this desktop publishes to, as resolved from its discovery
   * document (Settings → Remote → Server). When set, hub URL, issuer and
   * client id below are derived from it and re-checked on network changes;
   * without it they stay hand-configured as before.
   */
  remoteServer?: KnownServer;
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
  /**
   * Extra dangerous-command regexes for the broadcast input's danger
   * gate — appended to the built-in rules (rm -rf, git push --force,
   * DROP TABLE, …). Each entry is matched case-insensitively against
   * every line of the broadcast buffer; a match opens the confirm
   * dialog before anything is sent. Invalid regexes are ignored with a
   * console warning.
   */
  broadcastDangerPatterns?: string[];
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
    tagColors: normalizeTagColors(t.tagColors),
  };
}

const TAG_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function normalizeTagColors(raw: unknown): Partial<Record<TagSlot, string>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Partial<Record<TagSlot, string>> = {};
  for (const [slot, value] of Object.entries(raw)) {
    if (isTagSlot(slot) && typeof value === 'string' && TAG_HEX.test(value)) out[slot] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Used for a slot neither the theme nor its terminal colours fill with a hex. */
const FALLBACK_TAG_COLORS: Record<TagSlot, string> = {
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#ffb224',
  green: '#46a758',
  cyan: '#12a594',
  blue: '#0091ff',
  violet: '#6e56cf',
  magenta: '#d6409f',
};

/**
 * The theme's tag colours as hex: its `tagColors`, else its terminal
 * colours (orange and violet mixed from their neighbours when absent).
 */
export function themeTagPalette(theme: ThemeDefinition): Record<TagSlot, string> {
  const c = theme.colors;
  const fromTerminal: Record<TagSlot, string | undefined> = {
    red: c.red,
    orange: c.orange ?? mixHex(c.red, c.yellow, 0.5),
    yellow: c.yellow,
    green: c.green,
    cyan: c.cyan,
    blue: c.blue,
    violet: c.violet ?? mixHex(c.blue, c.magenta, 0.5),
    magenta: c.magenta,
  };
  const out = {} as Record<TagSlot, string>;
  for (const slot of TAG_SLOTS) {
    const value = theme.tagColors?.[slot] ?? fromTerminal[slot];
    out[slot] = value && TAG_HEX.test(value) ? value : FALLBACK_TAG_COLORS[slot];
  }
  return out;
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
 * Font existence check. Two cases:
 *
 * - A web font registered with the document (bundled `@font-face`, or a
 *   `FontFace` added at runtime) is found in `document.fonts`.
 * - An installed font is measured in the DOM against two different generic
 *   fallbacks: a family that exists renders the probe itself and measures
 *   the same next to `serif` and `monospace`; a missing one falls through
 *   and takes each fallback's width.
 *
 * `document.fonts.check()` is NOT used: for a name without a matching
 * `@font-face` it answers "nothing to load" (true) in WebKit and Chromium,
 * so every typo would pass. A detached canvas is not used either — in
 * WebKit it cannot see user-installed fonts, and comparing against
 * `monospace` alone misreports the many coding fonts that share its 0.6em
 * advance.
 */
const fontProbeCache = new Map<string, boolean>();
// Webfonts resolve asynchronously — a name probed "missing" before the font
// loaded must not stay cached as missing forever.
if (typeof document !== 'undefined') {
  void document.fonts?.ready?.then(() => fontProbeCache.clear());
}

const FONT_PROBE_TEXT = 'mmmmmmmmmmWWWiiiiill';

function isRegisteredWebFont(name: string): boolean {
  const wanted = name.toLowerCase();
  try {
    const faces = document.fonts as unknown as Iterable<{ family: string }> | undefined;
    if (!faces || typeof (faces as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
      return false;
    }
    for (const face of faces) {
      if (face.family.replace(/^["']|["']$/g, '').toLowerCase() === wanted) return true;
    }
  } catch {
    // FontFaceSet not iterable here — fall through to the measurement.
  }
  return false;
}

/** Rendered width of the probe text in `fontFamily`, or null without layout. */
function measureProbe(fontFamily: string): number | null {
  const host = document.body ?? document.documentElement;
  if (!host) return null;
  const el = document.createElement('span');
  el.textContent = FONT_PROBE_TEXT;
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText =
    'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;' +
    'font-size:72px;font-style:normal;font-weight:400;letter-spacing:0;font-variant:normal;';
  el.style.fontFamily = fontFamily;
  host.appendChild(el);
  const width = el.getBoundingClientRect().width;
  el.remove();
  return Number.isFinite(width) ? width : null;
}

function singleFontExists(name: string): boolean {
  const cached = fontProbeCache.get(name);
  if (cached !== undefined) return cached;
  let exists = true;
  try {
    if (!isRegisteredWebFont(name)) {
      const quoted = `"${name.replace(/["\\]/g, '')}"`;
      const serif = measureProbe('serif');
      const mono = measureProbe('monospace');
      // No layout engine (tests, SSR) or indistinguishable fallbacks: there
      // is nothing to compare against, so stay permissive.
      if (serif !== null && mono !== null && Math.abs(serif - mono) > 0.5) {
        const nextToSerif = measureProbe(`${quoted}, serif`);
        const nextToMono = measureProbe(`${quoted}, monospace`);
        exists =
          nextToSerif !== null && nextToMono !== null && Math.abs(nextToSerif - nextToMono) < 0.5;
      }
    }
  } catch {
    exists = true;
  }
  fontProbeCache.set(name, exists);
  return exists;
}

/** Test hook: forget probe results (fonts registered after a probe). */
export function resetFontProbeCache(): void {
  fontProbeCache.clear();
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

/**
 * The interface (chrome) font from settings: the configured stack when it
 * resolves to something real, else `undefined` — the stylesheet's system UI
 * stack applies. A generic fallback is appended so a partially matching
 * stack never drops to serif.
 */
export function resolveUiFont(settings: AppSettings): string | undefined {
  const family = settings.uiFontFamily?.trim();
  if (!family || !fontStackAvailable(family)) return undefined;
  return /(^|,)\s*(sans-serif|system-ui|ui-sans-serif|monospace|ui-monospace|serif)\s*$/i.test(family)
    ? family
    : `${family}, system-ui, sans-serif`;
}

/** Push the interface font to the document (unset → stylesheet default). */
export function applyUiFont(settings: AppSettings) {
  if (typeof document === 'undefined') return;
  const family = resolveUiFont(settings);
  const root = document.documentElement;
  if (family) root.style.setProperty('--font-ui-user', family);
  else root.style.removeProperty('--font-ui-user');
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

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** Share of `--bg` in `--chrome` — keep in sync with styles.css. */
const CHROME_BG_SHARE = 0.94;

/**
 * sRGB mix of two #rrggbb colours (`share` of `a`, the rest `b`) — the same
 * result as CSS `color-mix(in srgb, a share%, b)`. Undefined when either is
 * not a plain hex colour.
 */
export function mixHex(a: string | undefined, b: string | undefined, share: number): string | undefined {
  if (!a || !b || !HEX_COLOR.test(a) || !HEX_COLOR.test(b)) return undefined;
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const mixed = [0, 1, 2].map((i) => Math.round(channel(a, i) * share + channel(b, i) * (1 - share)));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
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
  for (const [slot, value] of Object.entries(themeTagPalette(theme))) {
    root.style.setProperty(`--tag-${slot}`, value);
  }

  // Optional pins for the derived tokens — cleared when the theme leaves
  // them out, so the stylesheet's color-mix defaults apply again.
  const derived: Record<string, string | undefined> = {
    '--chrome': ui.chrome,
    '--raised': ui.raised,
    '--elevated': ui.elevated,
    '--attention': ui.attention,
  };
  for (const [key, value] of Object.entries(derived)) {
    if (value) root.style.setProperty(key, value);
    else root.style.removeProperty(key);
  }

  // Desktop (macOS): paint the native window background / title bar in the
  // chrome colour, so the title bar row and the rail read as one surface.
  // The native side needs #rrggbb, so the stylesheet's color-mix default is
  // computed here as well; anything that is not a hex colour skips.
  const chrome = ui.chrome ?? mixHex(vars['--bg'], vars['--text-primary'], CHROME_BG_SHARE);
  if (chrome && HEX_COLOR.test(chrome)) {
    shellPlatform()?.setTitlebarColor?.(chrome);
  }

  root.dataset.theme = theme.mode;
  root.style.colorScheme = theme.mode;
}
