import { i18n } from '@lingui/core';
import { messages as en } from './locales/en/messages';
import { messages as ko } from './locales/ko/messages';
import { messages as de } from './locales/de/messages';
import { messages as fr } from './locales/fr/messages';
import { messages as it } from './locales/it/messages';
import { messages as nl } from './locales/nl/messages';
import { messages as zh } from './locales/zh/messages';
import { messages as ja } from './locales/ja/messages';

/** Locales bundled with the app — keep in sync with lingui.config.ts. */
export const availableLocales = ['en', 'ko', 'de', 'fr', 'it', 'nl', 'zh', 'ja'] as const;
export type AvailableLocale = (typeof availableLocales)[number];

/** Native display names for the language picker. */
export const localeNames: Record<AvailableLocale, string> = {
  en: 'English',
  ko: '한국어',
  de: 'Deutsch',
  fr: 'Français',
  it: 'Italiano',
  nl: 'Nederlands',
  zh: '中文',
  ja: '日本語',
};

const catalogs: Record<AvailableLocale, typeof en> = { en, ko, de, fr, it, nl, zh, ja };

for (const locale of availableLocales) {
  i18n.load(locale, catalogs[locale]);
}

/**
 * Best bundled match for the OS/browser language — walks
 * `navigator.languages` (e.g. 'de-AT' → 'de'), English fallback.
 */
export function systemLanguage(): AvailableLocale {
  const tags =
    typeof navigator !== 'undefined'
      ? (navigator.languages ?? [navigator.language])
      : [];
  for (const tag of tags) {
    const primary = tag.toLowerCase().split('-')[0];
    if ((availableLocales as readonly string[]).includes(primary)) {
      return primary as AvailableLocale;
    }
  }
  return 'en';
}

/**
 * Activate a language setting: 'system' (or unset) resolves against the
 * OS/browser language, anything else must be a bundled locale.
 */
export function activateLanguage(locale: string | undefined) {
  const next =
    !locale || locale === 'system'
      ? systemLanguage()
      : (availableLocales as readonly string[]).includes(locale)
        ? (locale as AvailableLocale)
        : 'en';
  if (i18n.locale !== next) i18n.activate(next);
}

activateLanguage('system');

export { i18n };
