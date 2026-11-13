import type { ShellSession } from '../types';
import { pluginSessionFields, type PluginApi, type SessionViewContext, type SessionViewPlugin } from './session-plugins/plugin';
import {
  CORE_FIELDS,
  parseCardLayout,
  resolveCardLayout,
  type FieldMeta,
  type ResolvedCardLayout,
} from './sessionCardLayout';

/**
 * Panel-filter search over session fields. A field is searchable when its
 * plugin declares `search` AND the card layout places it (any zone — the
 * selected zone counts, it is visible once selected); hidden fields never
 * match, so a match is always something the user can see on the card.
 */

/** Every field's meta, core first, plugin fields in plugin order. */
export function cardFieldMetas(plugins: readonly SessionViewPlugin[]): FieldMeta[] {
  const metas: FieldMeta[] = [...CORE_FIELDS];
  for (const plugin of plugins) {
    for (const f of pluginSessionFields(plugin)) {
      metas.push({ id: `${plugin.id}.${f.id}`, label: f.label, kind: f.kind, zone: f.zone });
    }
  }
  return metas;
}

/** Ids of every field the layout places, in any zone. */
export function placedFieldIds(layout: ResolvedCardLayout): Set<string> {
  return new Set([...layout.title, ...layout.always.flat(), ...layout.selected.flat()]);
}

const terms = (v: string | string[] | null | undefined): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).filter((t): t is string => typeof t === 'string' && t.length > 0);

export interface SessionSearchOptions {
  /** The raw `sessionCard` setting. */
  sessionCard: unknown;
  /** `sessionSummaries` — the summary only shows (and matches) when on. */
  sessionSummaries: boolean;
}

/** The layout every session's search uses — resolve once per render. */
export function searchLayout(
  plugins: readonly SessionViewPlugin[],
  sessionCard: unknown,
): ResolvedCardLayout {
  return resolveCardLayout(parseCardLayout(sessionCard), cardFieldMetas(plugins));
}

/**
 * Search terms of one session: its core fields (name — custom and
 * terminal-reported —, summary, process) and every placed plugin field's
 * `search`. `apiFor` builds the plugin ctx for this session.
 */
export function sessionSearchTerms(
  session: ShellSession,
  plugins: readonly SessionViewPlugin[],
  placed: Set<string>,
  opts: Pick<SessionSearchOptions, 'sessionSummaries'>,
  apiFor: (plugin: SessionViewPlugin) => SessionViewContext & PluginApi,
): string[] {
  const out: string[] = [];
  // The name is always in the title row.
  out.push(...terms([session.name ?? '', session.autoName ?? '']));
  if (placed.has('core.summary') && opts.sessionSummaries) out.push(...terms(session.summary));
  if (placed.has('core.process')) out.push(...terms(session.process));
  for (const plugin of plugins) {
    const fields = pluginSessionFields(plugin).filter(
      (f) => f.search && placed.has(`${plugin.id}.${f.id}`),
    );
    if (fields.length === 0) continue;
    const api = apiFor(plugin);
    for (const f of fields) {
      try {
        out.push(...terms(f.search!(api)));
      } catch {
        // a broken plugin search never breaks the filter
      }
    }
  }
  return out;
}

/** Case-insensitive substring match of an already-lowercased query. */
export function matchesTerms(termsList: string[], q: string): boolean {
  return termsList.some((t) => t.toLowerCase().includes(q));
}
