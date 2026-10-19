export interface PluginSettingsSection {
  /** Whether the plugin is active. When unset, `plugin.defaultEnabled` applies. */
  enabled?: boolean;
  [key: string]: unknown;
}

/**
 * plugins.yaml sections keyed by plugin id (or `settingsKey`). Each section is
 * a free-form object; kebab-case keys are normalized to camelCase so YAML like
 * `restore-session: true` is read as `restoreSession`.
 */
export type PluginSettings = Record<string, PluginSettingsSection>;

export const defaultPluginSettings: PluginSettings = {
  devin: { restoreSession: false },
};

function kebabToCamel(key: string): string {
  return key.replace(/-([a-zA-Z])/g, (_, c: string) => c.toUpperCase());
}

function normalizeSection(raw: unknown): PluginSettingsSection | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: PluginSettingsSection = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[kebabToCamel(key)] = value;
  }
  return out;
}

export function normalizePluginSettings(raw: unknown): PluginSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...defaultPluginSettings };
  }
  const out: PluginSettings = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const section = normalizeSection(value);
    if (section) out[key] = section;
  }
  // Keep the devin defaults merged so a partial devin section still resolves.
  out.devin = { ...defaultPluginSettings.devin, ...out.devin };
  return out;
}

function camelToKebab(key: string): string {
  return key.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Convert normalized settings back into a YAML-friendly object — section keys
 * go back to kebab-case so a UI-written plugins.yaml keeps the documented
 * style (e.g. `restoreSession` → `restore-session`).
 */
export function pluginSettingsToYaml(
  settings: PluginSettings,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, section] of Object.entries(settings)) {
    const s: Record<string, unknown> = {};
    for (const [sk, sv] of Object.entries(section)) {
      s[camelToKebab(sk)] = sv;
    }
    out[key] = s;
  }
  return out;
}
