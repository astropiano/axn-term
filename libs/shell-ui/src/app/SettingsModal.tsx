import { useEffect, useState, type ReactNode } from 'react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Sun, Moon, Monitor, Pencil, Plus, Minus, Trash2, X } from 'lucide-react';
import { IconButton } from './IconButton';
import { FontPicker } from './FontPicker';
import { SessionIconGlyph } from './SessionPanel';
import { useSettings, settingsFromYaml, settingsToYaml } from '../SettingsProvider';
import { usePluginSettings } from './PluginSettingsProvider';
import type { AppSettings, ThemeMode } from '../themes';
import { defaultShellLineHeight, themeDefinitions } from '../themes';
import { useSessionBackend, useShellPlatform } from '../services';
import { availableLocales, localeNames } from '../i18n';
import { getSessionViewPlugins, isPluginEnabled, pluginDependencies } from './session-plugins';
import { PanelSearch, PluginIcon } from './SessionPanel';
import { collectIconBag } from './iconModel';
import type { PluginSettingField, SessionViewPlugin } from './session-plugins';
import { isSandboxedPlugin } from './session-plugins/sandbox';
import { getFilePreviewPlugins, isFilePreviewEnabled } from './preview-plugins';
import type { FilePreviewPlugin } from './preview-plugins';
import { usePanelStatus } from './panelStatus';

const cycle: Record<ThemeMode, ThemeMode> = {
  light: 'dark',
  dark: 'auto',
  auto: 'light',
};

const themeIcon: Record<ThemeMode, ReactNode> = {
  light: <Sun className="h-4 w-4" />,
  dark: <Moon className="h-4 w-4" />,
  auto: <Monitor className="h-4 w-4" />,
};

function ThemeToggle() {
  const { t } = useLingui();
  const { settings, setTheme } = useSettings();
  const next = cycle[settings.theme];

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      data-tip={t`Switch to ${t(modeMessages[next])}`}
      aria-label={t`Switch to ${t(modeMessages[next])}`}
      className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg)] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]"
    >
      {themeIcon[settings.theme]}
    </button>
  );
}

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  embedded?: boolean;
}

const modeMessages: Record<ThemeMode, MessageDescriptor> = {
  light: msg`Light`,
  dark: msg`Dark`,
  auto: msg`Auto`,
};

const modeOptions: { value: ThemeMode }[] = [
  { value: 'light' },
  { value: 'dark' },
  { value: 'auto' },
];

const lightThemes = themeDefinitions.filter((t) => t.mode === 'light');
const darkThemes = themeDefinitions.filter((t) => t.mode === 'dark');

function ThemeSelect({
  label,
  value,
  onChange,
  themes,
}: {
  label: string;
  value: string | undefined;
  onChange: (id: string) => void;
  themes: typeof themeDefinitions;
}) {
  return (
    <div>
      <label className="mb-1 block text-[13px] text-[var(--text-secondary)]">{label}</label>
      <select
        value={value ?? themes[0]?.id ?? ''}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
      >
        {themes.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}

type SettingsTab = 'general' | 'plugins';

/** Section-filter predicate for the Settings search box. */
function matchSetting(query: string, keywords: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || keywords.includes(q);
}

const tabs: { id: SettingsTab; label: MessageDescriptor }[] = [
  { id: 'general', label: msg`General` },
  { id: 'plugins', label: msg`Plugins` },
];

export function SettingsModal({ open, onClose, embedded }: SettingsModalProps) {
  const { t } = useLingui();
  const [tab, setTab] = useState<SettingsTab>('general');

  useEffect(() => {
    if (!open || embedded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, embedded]);

  if (!open) return null;

  const panel = (
      <div
        className={
          embedded
            ? 'flex h-full w-full flex-col bg-[var(--surface)]'
            : 'flex h-[560px] w-[700px] max-w-[92vw] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-[var(--radius-xl)] bg-[var(--elevated)] shadow-[var(--shadow-pop)]'
        }
        onClick={embedded ? undefined : (e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 pl-5 pr-3 shadow-[inset_0_-1px_0_var(--hairline)]">
          <div className="flex items-center gap-4">
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">
              <Trans>Settings</Trans>
            </h2>
            <div className="flex gap-0.5">
              {tabs.map((tabItem) => (
                <button
                  key={tabItem.id}
                  type="button"
                  onClick={() => setTab(tabItem.id)}
                  className={`h-7 rounded-[var(--radius-md)] px-3 text-[13px] transition-colors duration-[var(--dur-1)] ${
                    tab === tabItem.id
                      ? 'bg-[var(--fill-2)] font-medium text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--fill-1)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {t(tabItem.label)}
                </button>
              ))}
            </div>
          </div>
          {!embedded && (
            <IconButton title={t`Close`} onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          )}
        </div>

        <div className="flex min-h-0 flex-1">
          {tab === 'general' ? <GeneralTab /> : <PluginsTab />}
        </div>
      </div>
  );

  if (embedded) return panel;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      {panel}
    </div>
  );
}

/**
 * Font-size field with explicit −/+ buttons that move exactly one step per
 * click. The native number spinner auto-repeats while the button is held,
 * and every step re-fonts all terminals — a slow main thread delays the
 * mouse-up, so one click ran several steps (14 → 7). Native spinners are
 * hidden; arrow keys still step one at a time.
 */
function FontSizeInput({
  value,
  fallback,
  min,
  max,
  stepSize = 1,
  onChange,
}: {
  value: number | undefined;
  /** Effective size while unset — the base the buttons step from. */
  fallback: number;
  min: number;
  max: number;
  /** Button step (1 for px sizes, 10 for uiZoom %). */
  stepSize?: number;
  onChange: (next: number | undefined) => void;
}) {
  const { t } = useLingui();
  const step = (delta: number) =>
    onChange(Math.min(max, Math.max(min, (value ?? fallback) + delta * stepSize)));
  const buttonClass =
    'flex h-6 w-5 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-40';
  return (
    <div className="flex shrink-0 items-center gap-0.5" data-tip={t`Font size (px)`}>
      <button
        type="button"
        className={buttonClass}
        onClick={() => step(-1)}
        disabled={(value ?? fallback) <= min}
        aria-label={t`Decrease font size`}
      >
        <Minus className="h-3 w-3" />
      </button>
      <input
        type="number"
        min={min}
        max={max}
        step={stepSize}
        value={value ?? ''}
        onChange={(e) =>
          onChange(
            e.currentTarget.value === ''
              ? undefined
              : Math.min(max, Math.max(min, Number(e.currentTarget.value))),
          )
        }
        placeholder={String(fallback)}
        className="w-10 rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-1 text-center text-[13px] text-[var(--text-primary)] outline-none [appearance:textfield] focus:border-[var(--accent)] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        className={buttonClass}
        onClick={() => step(1)}
        disabled={(value ?? fallback) >= max}
        aria-label={t`Increase font size`}
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * Line-height field — same ± stepping as FontSizeInput but fractional
 * (xterm's multiplier, 0.05 steps between 1.0 and 2.0). Rounded to two
 * decimals so repeated steps don't accumulate float noise.
 */
function LineHeightInput({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  const { t } = useLingui();
  const min = 1;
  const max = 2;
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
  const step = (delta: number) => onChange(clamp((value ?? defaultShellLineHeight) + delta * 0.05));
  const buttonClass =
    'flex h-6 w-5 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-40';
  return (
    <div className="flex shrink-0 items-center gap-0.5" data-tip={t`Line height`}>
      <button
        type="button"
        className={buttonClass}
        onClick={() => step(-1)}
        disabled={(value ?? defaultShellLineHeight) <= min}
        aria-label={t`Decrease line height`}
      >
        <Minus className="h-3 w-3" />
      </button>
      <input
        type="number"
        min={min}
        max={max}
        step={0.05}
        value={value ?? ''}
        onChange={(e) =>
          onChange(
            e.currentTarget.value === '' ? undefined : clamp(Number(e.currentTarget.value)),
          )
        }
        placeholder={String(defaultShellLineHeight)}
        className="w-10 rounded border border-[var(--border)] bg-[var(--bg)] px-1 py-1 text-center text-[13px] text-[var(--text-primary)] outline-none [appearance:textfield] focus:border-[var(--accent)] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        className={buttonClass}
        onClick={() => step(1)}
        disabled={(value ?? defaultShellLineHeight) >= max}
        aria-label={t`Increase line height`}
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}

function GeneralTab() {
  const { t } = useLingui();
  const { settings, setTheme, updateSettings, replaceSettings } = useSettings();
  const platform = useShellPlatform();
  const remoteEnabled = settings.remoteEnabled ?? Boolean(settings.remoteAuthorityUrl);
  const [defaultShell, setDefaultShell] = useState(settings.defaultShell ?? '');
  const [configError, setConfigError] = useState<string | null>(null);
  const [configNote, setConfigNote] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  async function importConfig() {
    setConfigError(null);
    setConfigNote(null);
    const text = await platform.configFileStorage.load().catch(() => null);
    if (text === null) return;
    try {
      const parsed = settingsFromYaml(text);
      if (!parsed) {
        setConfigError(t`Not a valid config.yaml — expected a YAML mapping.`);
        return;
      }
      replaceSettings(parsed);
      setConfigNote(t`Imported.`);
    } catch {
      setConfigError(t`Could not parse the file as YAML.`);
    }
  }

  async function exportConfig() {
    setConfigError(null);
    setConfigNote(null);
    try {
      await platform.configFileStorage.save(settingsToYaml(settings), 'config.yaml');
      setConfigNote(t`Exported.`);
    } catch {
      setConfigError(t`Export failed.`);
    }
  }

  useEffect(() => {
    setDefaultShell(settings.defaultShell ?? '');
  }, [settings.defaultShell]);

  const backend = useSessionBackend();
  useEffect(() => {
    if (settings.defaultShell) return;
    backend.getDefaultShell?.()
      .then((shell) => setDefaultShell(shell))
      .catch(() => {});
  }, [settings.defaultShell, backend]);

  const showLightPicker = settings.theme === 'light' || settings.theme === 'auto';
  const showDarkPicker = settings.theme === 'dark' || settings.theme === 'auto';

  async function setSystemShell() {
    try {
      const shell = (await backend.getDefaultShell?.()) ?? '';
      setDefaultShell(shell);
      updateSettings({ defaultShell: shell });
    } catch {
      // ignore
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-[var(--border)] px-3 py-2">
        <PanelSearch value={query} onChange={setQuery} placeholder={t`Filter settings…`} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-4" hidden={!matchSetting(query, 'theme light dark appearance color scheme')}>
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[13px] text-[var(--text-secondary)]"><Trans>Theme</Trans></label>
          <ThemeToggle />
        </div>
        <div className="flex gap-1">
          {modeOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setTheme(opt.value)}
              className={`rounded px-2 py-1.5 text-left text-[13px] transition ${
                settings.theme === opt.value
                  ? 'bg-[var(--accent)] text-[var(--text-inverted)]'
                  : 'hover:bg-[var(--surface-hover)] text-[var(--text-primary)]'
              }`}
            >
              {t(modeMessages[opt.value])}
            </button>
          ))}
        </div>
        {(showLightPicker || showDarkPicker) && (
          <div className="mt-3 flex flex-col gap-3">
            {showLightPicker && (
              <ThemeSelect
                label={t`Light theme`}
                value={settings.lightTheme}
                onChange={(id) => updateSettings({ lightTheme: id })}
                themes={lightThemes}
              />
            )}
            {showDarkPicker && (
              <ThemeSelect
                label={t`Dark theme`}
                value={settings.darkTheme}
                onChange={(id) => updateSettings({ darkTheme: id })}
                themes={darkThemes}
              />
            )}
          </div>
        )}
      </div>

      <div className="mb-4" hidden={!matchSetting(query, 'language locale translation')}>
        <label className="mb-1 block text-[13px] text-[var(--text-secondary)]">
          <Trans>Language</Trans>
        </label>
        <select
          value={settings.language ?? 'system'}
          onChange={(e) =>
            updateSettings({ language: e.currentTarget.value as AppSettings['language'] })
          }
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        >
          <option value="system">{t`System`}</option>
          {availableLocales.map((loc) => (
            <option key={loc} value={loc}>
              {localeNames[loc]}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-4" hidden={!matchSetting(query, 'default shell bash zsh fish')}>
        <label className="mb-1 block text-[13px] text-[var(--text-secondary)]">
          <Trans>Default shell</Trans>
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={defaultShell}
            onChange={(e) => {
              setDefaultShell(e.currentTarget.value);
              updateSettings({ defaultShell: e.currentTarget.value });
            }}
            placeholder="/bin/bash"
            className="flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <button
            type="button"
            onClick={setSystemShell}
            data-tip={t`Use system default`}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          >
            auto
          </button>
        </div>
        <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
          <Trans>Leave empty to use the system $SHELL.</Trans>
        </p>
      </div>

      <div className="mb-4" hidden={!matchSetting(query, 'interface font ui font family chrome system')}>
        <label className="mb-1 block text-[13px] text-[var(--text-secondary)]"><Trans>Interface font</Trans></label>
        <div className="flex items-start gap-2">
          <FontPicker
            kind="ui"
            value={settings.uiFontFamily ?? ''}
            onCommit={(v) => updateSettings({ uiFontFamily: v })}
            placeholder={t`System font`}
            defaultLabel={t`System font`}
          />
        </div>
        <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
          <Trans>Font for the rail, session panel, tabs and dialogs. Empty uses the system font.</Trans>
        </p>
      </div>

      <div className="mb-4" hidden={!matchSetting(query, 'shell font terminal font family size line height nerd')}>
        <label className="mb-1 block text-[13px] text-[var(--text-secondary)]"><Trans>Shell font</Trans></label>
        <div className="flex items-start gap-2">
          <FontPicker
            kind="mono"
            value={settings.shellFontFamily ?? ''}
            onCommit={(v) => updateSettings({ shellFontFamily: v })}
            placeholder="Monaspace Neon, Fira Code, …"
            defaultLabel={t`Built-in font`}
          />
          <FontSizeInput
            value={settings.shellFontSize}
            fallback={14}
            min={6}
            max={40}
            onChange={(shellFontSize) => updateSettings({ shellFontSize })}
          />
          <LineHeightInput
            value={settings.shellLineHeight}
            onChange={(shellLineHeight) => updateSettings({ shellLineHeight })}
          />
        </div>
        <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
          <Trans>Terminal font family, size in px, and line height. Empty uses the built-in monospace stack at 14px.</Trans>
        </p>
      </div>

      <div className="mb-4" hidden={!matchSetting(query, 'panel font size')}>
        <label className="mb-1 block text-[13px] text-[var(--text-secondary)]"><Trans>Panel font</Trans></label>
        <div className="flex items-start gap-2">
          <FontPicker
            kind="ui"
            value={settings.panelFontFamily ?? ''}
            onCommit={(v) => updateSettings({ panelFontFamily: v })}
            placeholder="Monaspace Neon, Inter, …"
            defaultLabel={t`Interface font`}
          />
          <FontSizeInput
            value={settings.panelFontSize}
            fallback={12}
            min={6}
            max={30}
            onChange={(panelFontSize) => updateSettings({ panelFontSize })}
          />
        </div>
        <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
          <Trans>Font for the session/workspace panel. Size scales it relative to the 12px default.</Trans>
        </p>
      </div>

      <div className="mb-4" hidden={!matchSetting(query, 'ui zoom scale percent')}>
        <label className="mb-1 block text-[13px] text-[var(--text-secondary)]"><Trans>UI zoom</Trans></label>
        <FontSizeInput
          value={settings.uiZoom}
          fallback={100}
          min={50}
          max={200}
          stepSize={10}
          onChange={(uiZoom) => updateSettings({ uiZoom })}
        />
        <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
          <Trans>Overall UI scale in percent — panel, tabs, banners, menus. The terminal uses its own font size.</Trans>
        </p>
      </div>

      <div className="mb-4 flex items-center gap-2" hidden={!matchSetting(query, 'devin task parser enable')}>
        <input
          id="devin-task-parser"
          type="checkbox"
          checked={settings.devinTaskParserEnabled ?? false}
          onChange={(e) => updateSettings({ devinTaskParserEnabled: e.currentTarget.checked })}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        <label htmlFor="devin-task-parser" className="text-[13px] text-[var(--text-primary)]">
          <Trans>Enable devin task parser</Trans>
        </label>
      </div>

      <div className="mb-4 flex items-center gap-2" hidden={!matchSetting(query, 'session summaries axn-session-summary render')}>
        <input
          id="session-summaries"
          type="checkbox"
          checked={settings.sessionSummaries ?? true}
          onChange={(e) => updateSettings({ sessionSummaries: e.currentTarget.checked })}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        <label htmlFor="session-summaries" className="text-[13px] text-[var(--text-primary)]">
          <Trans>Render session summaries (set via axn-session-summary)</Trans>
        </label>
      </div>

      <div className="mb-4" hidden={!matchSetting(query, 'new session button placement workspace header list both')}>
        <label className="mb-1 block text-[13px] text-[var(--text-secondary)]">
          <Trans>New session button</Trans>
        </label>
        <select
          value={settings.newSessionButton ?? 'both'}
          onChange={(e) =>
            updateSettings({
              newSessionButton: e.currentTarget.value as AppSettings['newSessionButton'],
            })
          }
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        >
          <option value="both">{t`Both`}</option>
          <option value="list">{t`End of session list`}</option>
          <option value="header">{t`Workspace header`}</option>
        </select>
        <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
          <Trans>
            Where the "+" for a new session appears: a ghost row at the end of
            each workspace's session list, the workspace header, or both.
          </Trans>
        </p>
      </div>

      <div className="mb-4" hidden={!matchSetting(query, 'terminal renderer webgl canvas dom auto')}>
        <label className="mb-1 block text-[13px] text-[var(--text-secondary)]">
          <Trans>Terminal renderer</Trans>
        </label>
        <select
          value={settings.terminalRenderer ?? 'auto'}
          onChange={(e) =>
            updateSettings({
              terminalRenderer: e.currentTarget.value as AppSettings['terminalRenderer'],
            })
          }
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        >
          <option value="auto">{t`Auto (WebGL → canvas → DOM)`}</option>
          <option value="webgl">WebGL</option>
          <option value="canvas">Canvas</option>
          <option value="dom">DOM</option>
        </select>
        <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
          <Trans>
            Cell renderer for terminals. Auto uses GPU (WebGL) and falls back
            automatically. Force canvas/DOM if you hit rendering glitches.
          </Trans>
        </p>
      </div>

      <div className="mb-4" hidden={!matchSetting(query, 'session icons lucide svg executable mapping')}>
        <label className="mb-1 block text-[13px] text-[var(--text-secondary)]">
          <Trans>Session icons</Trans>
        </label>
        <SessionIconEditor
          icons={collectIconBag(settings)}
          updateIcons={(key, value) => {
            const customIcons = { ...(settings.customIcons ?? {}) };
            const sessionIcons = { ...(settings.sessionIcons ?? {}) };
            const pluginIcons = { ...(settings.pluginIcons ?? {}) };
            if (value === undefined) {
              delete customIcons[key];
              delete sessionIcons[key];
              delete pluginIcons[key];
            } else {
              customIcons[key] = value;
              delete sessionIcons[key];
              delete pluginIcons[key];
            }
            updateSettings({ customIcons, sessionIcons, pluginIcons });
          }}
        />
        <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
          <Trans>
            Map executable names or plugin ids to a Lucide icon (e.g., Bot, SquareTerminal) or an SVG
            tag.
          </Trans>
        </p>
      </div>

      <div className="mb-4" hidden={!matchSetting(query, 'config file import export yaml')}>
        <label className="mb-1 block text-[13px] text-[var(--text-secondary)]">
          <Trans>Config file</Trans>
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void importConfig()}
            className="rounded border border-[var(--border)] px-2 py-1 text-[13px] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
          >
            <Trans>Import…</Trans>
          </button>
          <button
            type="button"
            onClick={() => void exportConfig()}
            className="rounded border border-[var(--border)] px-2 py-1 text-[13px] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
          >
            <Trans>Export…</Trans>
          </button>
          {configNote && (
            <span className="text-[11px] text-[var(--text-secondary)]">{configNote}</span>
          )}
        </div>
        {configError && <p className="mt-1 text-[11px] text-[var(--red)]">{configError}</p>}
        <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
          <Trans>Import replaces all settings with the picked config.yaml.</Trans>
        </p>
        <p className="mt-1 font-mono text-[11px] text-[var(--text-secondary)]">
          {platform.configStore
            ? t`Stored in ~/.axn-term/config.yaml`
            : t`Stored in browser localStorage`}
        </p>
      </div>

      {platform.openLogDir && (
        <div className="mb-4" hidden={!matchSetting(query, 'log level logging debug trace diagnostics folder')}>
          <label className="mb-1 block text-[13px] text-[var(--text-secondary)]">
            <Trans>Log level</Trans>
          </label>
          <select
            value={settings.logLevel ?? 'info'}
            onChange={(e) =>
              updateSettings({
                logLevel: e.currentTarget.value as AppSettings['logLevel'],
              })
            }
            className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            <option value="error">error</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
            <option value="debug">debug</option>
            <option value="trace">trace</option>
          </select>
          <div className="mt-2">
            <button
              type="button"
              onClick={() => platform.openLogDir?.()}
              className="rounded border border-[var(--border)] px-2 py-1 text-[13px] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
            >
              <Trans>Open log folder…</Trans>
            </button>
          </div>
          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
            <Trans>
              Applies immediately to the running app. Logs rotate in the OS
              log folder (~/Library/Logs/axn-term); LOG_LEVEL env overrides.
            </Trans>
          </p>
        </div>
      )}

      <div className="mb-4" hidden={!matchSetting(query, 'remote access ramphastos authority session token url')}>
        <label className="mb-1 block text-[13px] text-[var(--text-secondary)]"><Trans>Remote access</Trans></label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={remoteEnabled}
            onChange={(e) => updateSettings({ remoteEnabled: e.currentTarget.checked })}
            className="h-3.5 w-3.5 accent-[var(--accent)]"
          />
          <span className="text-[13px] text-[var(--text-primary)]">
            <Trans>Enable remote — show the Remote console in the rail</Trans>
          </span>
        </label>
      </div>
      </div>
    </div>
  );
}

type PluginEntry =
  | { kind: 'session'; plugin: SessionViewPlugin }
  | { kind: 'preview'; plugin: FilePreviewPlugin };

function PluginsTab() {
  const { t } = useLingui();
  const { pluginSettings, updatePluginSection } = usePluginSettings();
  const [query, setQuery] = useState('');
  // Plugins currently publishing a panel status group — they get the
  // Status display choice even without a detailed rail item.
  const statusSources = new Set(usePanelStatus().map((g) => g.source));
  const groups: { label: string; entries: PluginEntry[] }[] = [
    {
      label: t`Session plugins`,
      entries: getSessionViewPlugins().map(
        (plugin): PluginEntry => ({ kind: 'session', plugin }),
      ),
    },
    {
      label: t`File previews`,
      entries: getFilePreviewPlugins().map(
        (plugin): PluginEntry => ({ kind: 'preview', plugin }),
      ),
    },
  ];
  const entries = groups.flatMap((g) => g.entries);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = entries.find((e) => e.plugin.id === selectedId) ?? entries[0];

  function enabled(entry: PluginEntry): boolean {
    const all = getSessionViewPlugins();
    return entry.kind === 'session'
      ? isPluginEnabled(entry.plugin, pluginSettings, all)
      : isFilePreviewEnabled(entry.plugin, pluginSettings);
  }

  const q = query.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({
      ...g,
      entries: g.entries.filter(
        (e) =>
          !q ||
          e.plugin.title.toLowerCase().includes(q) ||
          e.plugin.id.toLowerCase().includes(q) ||
          (e.plugin.settingsKey ?? '').toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.entries.length > 0);

  const settingsKey = selected ? (selected.plugin.settingsKey ?? selected.plugin.id) : '';
  const section = pluginSettings[settingsKey] ?? {};
  const deps =
    selected?.kind === 'session'
      ? pluginDependencies(selected.plugin, pluginSettings, getSessionViewPlugins())
      : [];

  return (
    <>
      <div className="flex w-44 shrink-0 flex-col border-r border-[var(--border)]">
        <div className="shrink-0 border-b border-[var(--border)] px-2 py-1.5">
          <PanelSearch value={query} onChange={setQuery} placeholder={t`Filter plugins…`} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {filtered.map((group) => (
          <div key={group.label}>
            <div className="px-3 pb-0.5 pt-2 text-[11px] font-semibold text-[var(--text-secondary)]">
              {group.label}
            </div>
            {group.entries.map((entry) => {
              const isSelected = selected?.plugin.id === entry.plugin.id;
              return (
                <button
                  key={`${entry.kind}:${entry.plugin.id}`}
                  type="button"
                  onClick={() => setSelectedId(entry.plugin.id)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition ${
                    isSelected
                      ? 'bg-[var(--bg)] text-[var(--accent)]'
                      : 'text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
                  }`}
                >
                  <PluginIcon plugin={entry.plugin} className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{entry.plugin.title}</span>
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      enabled(entry)
                        ? 'bg-[var(--accent)]'
                        : 'bg-[var(--text-secondary)] opacity-40'
                    }`}
                    data-tip={enabled(entry) ? t`enabled` : t`disabled`}
                  />
                </button>
              );
            })}
          </div>
        ))}
        </div>
      </div>

      {selected && (
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text-primary)]">
                <PluginIcon plugin={selected.plugin} className="h-4 w-4 shrink-0" />
                {selected.plugin.title}
              </div>
              <div className="text-[11px] text-[var(--text-secondary)]">
                {selected.kind === 'session' ? t`session plugin` : t`file preview`} ·{' '}
                <span className="font-mono">{settingsKey}</span>
                {selected.plugin.version && (
                  <>
                    {' · v'}
                    <span className="font-mono">{selected.plugin.version}</span>
                  </>
                )}
              </div>
              {deps.map(({ dep, met }) => (
                <div
                  key={dep.id}
                  className={`text-[11px] ${
                    met ? 'text-[var(--text-secondary)]' : 'text-[var(--orange)]'
                  }`}
                >
                  {t`requires ${dep.id}${dep.version ? ` ${dep.version}` : ''}`}
                  {met ? '' : ` — ${t`unmet, plugin disabled`}`}
                </div>
              ))}
              {selected.kind === 'session' && isSandboxedPlugin(selected.plugin) && (
                <div className="text-[11px] text-[var(--text-secondary)]">
                  {selected.plugin.sandbox.manifest.permissions?.length ? (
                    <>
                      <Trans>permissions:</Trans>{' '}
                      <span className="font-mono text-[var(--text-primary)]">
                        {selected.plugin.sandbox.manifest.permissions.join(', ')}
                      </span>
                    </>
                  ) : (
                    <Trans>sandboxed — no permissions (no shell, files or terminal access)</Trans>
                  )}
                </div>
              )}
            </div>
            <label className="flex shrink-0 items-center gap-2 text-[13px] text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={enabled(selected)}
                onChange={(e) =>
                  updatePluginSection(settingsKey, { enabled: e.currentTarget.checked })
                }
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <Trans>enabled</Trans>
            </label>
          </div>

          {selected.plugin.logo !== undefined && <PluginLogoField plugin={selected.plugin} />}

          {selected.kind === 'session' &&
            selected.plugin.settings?.map((field) => (
              <PluginSettingRow
                key={field.key}
                field={field}
                section={section}
                onChange={(value) => updatePluginSection(settingsKey, { [field.key]: value })}
              />
            ))}

          {/* Standard choice for plugins with status in the panel's stack or a
              heavier rail form: the panel accordion, or the rail only — the
              detailed rail item where the plugin has one, else its plain
              icon. Unset ('auto') means the rail on touch devices for
              detailed items and the panel otherwise. */}
          {selected.kind === 'session' &&
            (selected.plugin.renderRailDetail || statusSources.has(selected.plugin.id)) && (
            <PluginSettingRow
              field={{
                key: 'statusDisplay',
                label: t`Status display`,
                description: selected.plugin.renderRailDetail
                  ? t`Where this plugin's status meters appear. Auto uses the rail on touch devices and the session panel otherwise.`
                  : t`Show this plugin's status as an accordion in the session panel, or keep only its rail icon.`,
                type: 'string',
                default: 'auto',
                options: [
                  { value: 'auto', label: t`Auto` },
                  { value: 'panel', label: t`Panel accordion` },
                  {
                    value: 'rail',
                    label: selected.plugin.renderRailDetail ? t`Rail item` : t`Rail icon only`,
                  },
                ],
              }}
              section={section}
              onChange={(value) => updatePluginSection(settingsKey, { statusDisplay: value })}
            />
          )}

          {selected.kind === 'session' &&
            selected.plugin.renderSettings?.({
              settings: section,
              update: (patch) => updatePluginSection(settingsKey, patch),
            })}

          {selected.kind === 'session' &&
            !selected.plugin.settings?.length &&
            !selected.plugin.renderSettings &&
            !selected.plugin.renderRailDetail && (
              <p className="text-[11px] text-[var(--text-secondary)]">
                <Trans>This plugin declares no settings.</Trans>
              </p>
            )}

          <p className="mt-4 text-[11px] text-[var(--text-secondary)]">
            <Trans>Stored in ~/.axn-term/plugins.yaml</Trans>
          </p>
        </div>
      )}
    </>
  );
}

/**
 * Editable logo override — only rendered for plugins that declare `logo`
 * (the has-an-icon capability). Reads the merged icon bag so an entry set
 * through the Session icons editor shows here too; for agent plugins the
 * plugin id is the process name, so this field and that row edit the same
 * icon.
 */
function PluginLogoField({ plugin }: { plugin: { id: string; logo?: string; processPattern?: RegExp } }) {
  const { settings, updateSettings } = useSettings();
  const override = collectIconBag(settings)[plugin.id] ?? '';
  const [draft, setDraft] = useState<string | null>(null);

  function commit() {
    if (draft === null) return;
    const value = draft.trim();
    const customIcons = { ...(settings.customIcons ?? {}) };
    const sessionIcons = { ...(settings.sessionIcons ?? {}) };
    const pluginIcons = { ...(settings.pluginIcons ?? {}) };
    if (value) customIcons[plugin.id] = value;
    else delete customIcons[plugin.id];
    delete sessionIcons[plugin.id];
    delete pluginIcons[plugin.id];
    updateSettings({ customIcons, sessionIcons, pluginIcons });
    setDraft(null);
  }

  const value = draft ?? override;
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <label className="w-14 shrink-0 text-[11px] text-[var(--text-secondary)]">
          <Trans>Logo</Trans>
        </label>
        <SessionIconGlyph
          value={value.trim() || plugin.logo || 'Puzzle'}
          className="h-4 w-4 shrink-0"
        />
        <input
          value={value}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setDraft(null);
          }}
          placeholder={plugin.logo ?? 'Puzzle'}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      </div>
      {plugin.processPattern && (
        <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
          <Trans>Also used as the session icon while this process is foreground.</Trans>
        </p>
      )}
    </div>
  );
}

function PluginSettingRow({
  field,
  section,
  onChange,
}: {
  field: PluginSettingField;
  section: Record<string, unknown>;
  onChange: (value: boolean | number | string) => void;
}) {
  const value = section[field.key] ?? field.default;

  return (
    <div className="mb-3">
      {field.type === 'boolean' ? (
        <label className="flex items-center gap-2 text-[13px] text-[var(--text-primary)]">
          <input
            type="checkbox"
            checked={value !== false}
            onChange={(e) => onChange(e.currentTarget.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          {field.label}
        </label>
      ) : (
        <>
          <label className="mb-1 block text-[13px] text-[var(--text-secondary)]">
            {field.label}
          </label>
          {field.options ? (
            <select
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => onChange(e.currentTarget.value)}
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            >
              {field.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={field.secret ? 'password' : field.type}
              autoComplete={field.secret ? 'off' : undefined}
              value={typeof value === 'number' || typeof value === 'string' ? value : ''}
              onChange={(e) =>
                onChange(
                  field.type === 'number'
                    ? Number(e.currentTarget.value)
                    : e.currentTarget.value,
                )
              }
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          )}
        </>
      )}
      {field.description && (
        <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{field.description}</p>
      )}
    </div>
  );
}

const SVG_HINT_EXAMPLE =
  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2l12 6-12 6z"/></svg>';

function SessionIconEditor({
  icons,
  updateIcons,
}: {
  icons: Record<string, string>;
  /** Write one entry (value) or remove it (value undefined) — hits `customIcons` and clears any legacy-map shadow. */
  updateIcons: (key: string, value: string | undefined) => void;
}) {
  const { t } = useLingui();
  const keys = Object.keys(icons).sort((a, b) => a.localeCompare(b));
  const [editing, setEditing] = useState<{ key: string; isNew: boolean } | null>(null);
  const [draftKey, setDraftKey] = useState('');
  const [draftValue, setDraftValue] = useState('');

  function openAdd() {
    setEditing({ key: '', isNew: true });
    setDraftKey('');
    setDraftValue('');
  }

  function openEdit(key: string) {
    setEditing({ key, isNew: false });
    setDraftKey(key);
    setDraftValue(icons[key] ?? '');
  }

  function remove(key: string) {
    updateIcons(key, undefined);
    if (editing?.key === key) setEditing(null);
  }

  function save() {
    const key = draftKey.trim().toLowerCase();
    if (!key || !editing) return;
    if (!editing.isNew && key !== editing.key) updateIcons(editing.key, undefined);
    updateIcons(key, draftValue);
    setEditing(null);
  }

  return (
    <div>
      <div className="rounded border border-[var(--border)]">
        {keys.map((key) => (
          <div
            key={key}
            className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-1 last:border-b-0"
          >
            <SessionIconGlyph value={icons[key]} className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate font-mono text-[13px] text-[var(--text-primary)]" data-tip={key}>
              {key}
            </span>
            <IconButton title={t`Edit icon`} size="sm" onClick={() => openEdit(key)}>
              <Pencil className="h-3 w-3" />
            </IconButton>
            <IconButton title={t`Remove icon`} size="sm" danger onClick={() => remove(key)}>
              <Trash2 className="h-3 w-3" />
            </IconButton>
          </div>
        ))}
        {keys.length === 0 && (
          <div className="px-2 py-1.5 text-[11px] text-[var(--text-secondary)]">
            <Trans>No icons configured — every session shows the default terminal icon.</Trans>
          </div>
        )}
      </div>

      {editing ? (
        <div className="mt-2 space-y-1.5 rounded border border-[var(--border)] p-2">
          <div className="flex items-center gap-2">
            <label className="w-14 shrink-0 text-[11px] text-[var(--text-secondary)]">
              <Trans>Process</Trans>
            </label>
            <input
              value={draftKey}
              onChange={(e) => setDraftKey(e.currentTarget.value)}
              placeholder="e.g. claude"
              autoFocus={editing.isNew}
              className="flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div className="flex gap-2">
            <textarea
              value={draftValue}
              onChange={(e) => setDraftValue(e.currentTarget.value)}
              rows={3}
              placeholder="GitFork"
              autoFocus={!editing.isNew}
              className="flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <div className="flex w-14 shrink-0 flex-col items-center justify-center gap-1 rounded border border-[var(--border)] bg-[var(--bg)]">
              <SessionIconGlyph
                value={draftValue.trim() || 'SquareTerminal'}
                className="h-5 w-5"
              />
            </div>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)]">
            <Trans>
              A Lucide icon name (e.g. <code>GitFork</code>) or an inline SVG
              tag, e.g. <code className="break-all">{SVG_HINT_EXAMPLE}</code>
            </Trans>
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded border border-[var(--border)] px-2 py-1 text-[13px] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
            >
              <Trans>Cancel</Trans>
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!draftKey.trim()}
              className="rounded border border-[var(--border)] px-2 py-1 text-[13px] text-[var(--accent)] transition hover:bg-[var(--surface-hover)] disabled:opacity-40"
            >
              <Trans>Save</Trans>
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2">
          <IconButton title={t`Add icon`} size="auto" onClick={openAdd}>
            <Plus className="h-3 w-3" />
            <span className="ml-1 text-[11px]"><Trans>Add icon</Trans></span>
          </IconButton>
        </div>
      )}
    </div>
  );
}
