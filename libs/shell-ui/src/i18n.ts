import { i18n } from '@lingui/core';
import { messages as en } from './locales/en/messages';
import { messages as ko } from './locales/ko/messages';

/** Locales bundled with the app — keep in sync with lingui.config.ts. */
export const availableLocales = ['en', 'ko'] as const;
export type AvailableLocale = (typeof availableLocales)[number];

const catalogs: Record<AvailableLocale, typeof en> = { en, ko };

for (const locale of availableLocales) {
  i18n.load(locale, catalogs[locale]);
}
i18n.activate('en');

export function activateLanguage(locale: string) {
  const next = (availableLocales as readonly string[]).includes(locale)
    ? locale
    : 'en';
  if (i18n.locale !== next) i18n.activate(next);
}

export { i18n };
