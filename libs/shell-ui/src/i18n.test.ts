import { describe, expect, it } from 'vitest';
import { setupI18n } from '@lingui/core';
import { messages as en } from './locales/en/messages';
import { messages as ko } from './locales/ko/messages';
import { messages as de } from './locales/de/messages';
import { messages as fr } from './locales/fr/messages';
import { messages as it_ } from './locales/it/messages';
import { messages as nl } from './locales/nl/messages';
import { messages as zh } from './locales/zh/messages';
import { messages as ja } from './locales/ja/messages';

const catalogs: Record<string, typeof en> = {
  en, ko, de, fr, it: it_, nl, zh, ja,
};

// Any placeholder name a message may reference — unknown names render as
// undefined, which is fine; what must never happen is a throw.
const values = new Proxy(
  { '0': 'v0', '1': 'v1' } as Record<string, unknown>,
  { get: (t, k) => (k in t ? t[k as string] : `v-${String(k)}`) },
);

describe('compiled message catalogs', () => {
  for (const [locale, messages] of Object.entries(catalogs)) {
    it(`every ${locale} message interpolates without throwing`, () => {
      const i18n = setupI18n({ locale, messages: { [locale]: messages } });
      i18n.activate(locale);
      const failures: string[] = [];
      for (const id of Object.keys(messages)) {
        try {
          i18n._({ id, values });
        } catch (e) {
          failures.push(`${id}: ${(e as Error).message}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
