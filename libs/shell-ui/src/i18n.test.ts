import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

  // An id missing from a catalog is what surfaces in the UI as an
  // untranslated entry — or as the raw hash id when there is no `message`
  // fallback. Catalogs drift when `lingui extract`/`compile` is not re-run
  // after adding messages; keep every locale at the source locale's key set.
  for (const [locale, messages] of Object.entries(catalogs)) {
    if (locale === 'en') continue;
    it(`${locale} has a translation for every en message`, () => {
      const missing = Object.keys(en).filter((id) => !(id in messages));
      const stale = Object.keys(messages).filter((id) => !(id in en));
      expect({ missing, stale }).toEqual({ missing: [], stale: [] });
    });
  }
});

describe('message sources (.po)', () => {
  // A msgid with an empty msgstr drops out of the compiled catalog — the
  // check above then sees a missing translation. Catch it at the source.
  for (const locale of Object.keys(catalogs)) {
    if (locale === 'en') continue;
    it(`every ${locale} msgid is translated`, () => {
      const po = readFileSync(
        fileURLToPath(new URL(`./locales/${locale}/messages.po`, import.meta.url)),
        'utf8',
      );
      const untranslated: string[] = [];
      const entry = /^msgid "(.*)"$/gm;
      let m: RegExpExecArray | null;
      while ((m = entry.exec(po))) {
        const msgid = m[1];
        if (!msgid) continue; // header
        const rest = po.slice(m.index);
        const msgstr = /^msgstr "((?:[^"\\]|\\.)*)"/m.exec(rest)?.[1];
        if (!msgstr) untranslated.push(msgid);
      }
      expect(untranslated).toEqual([]);
    });
  }
});

describe('catalog drift', () => {
  // The suites above compare catalog ↔ catalog; they cannot see a t`…`
  // string added to the code but never extracted — its hashed id is then
  // absent from every compiled catalog and the UI renders the raw id.
  // `check sync` re-runs extraction and diffs the committed .po files.
  it('committed catalogs match `lingui extract` output', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const res = spawnSync(
      process.execPath,
      ['node_modules/@lingui/cli/dist/lingui.js', 'check', 'sync'],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    expect(
      res.status,
      '`lingui check sync` found catalog drift — run `pnpm i18n:extract` then `pnpm i18n:compile`:\n' +
        `${res.stdout}${res.stderr}`,
    ).toBe(0);
  }, 60_000);
});
