/**
 * Session card layout — how a session's card in the panel is assembled from
 * session fields. Plugins only *provide* fields (`SessionViewPlugin.
 * sessionFields`: id, label, kind, default zone, value); the card is laid
 * out here, from the user's `sessionCard` setting in config.yaml or the
 * default below.
 *
 * Three zones:
 *  - `title`    — the title row (one row of inline fields, always visible)
 *  - `always`   — rows under the title, shown on every card
 *  - `selected` — rows shown only on the selected session's card
 *
 * A row is a list of field ids; inline fields in one row render `·`
 * separated, a block field takes the row's full width. Field ids are
 * `<pluginId>.<fieldId>` — built-in fields use the `core` namespace.
 */

export type SessionZone = 'title' | 'always' | 'selected';

/** What the layout needs to know about an available field. */
export interface FieldMeta {
  /** Full id, `<pluginId>.<fieldId>`. */
  id: string;
  label: string;
  kind: 'inline' | 'block';
  /** Where the default layout puts it. */
  zone: SessionZone;
}

/** The `sessionCard` setting (config.yaml). Every member optional. */
export interface SessionCardLayout {
  title?: string[];
  always?: string[][];
  selected?: string[][];
  /** Fields never shown, wherever their default zone is. */
  hidden?: string[];
}

export interface ResolvedCardLayout {
  title: string[];
  always: string[][];
  selected: string[][];
}

/** Built-in fields, in their default order. */
export const CORE_FIELDS: FieldMeta[] = [
  { id: 'core.name', label: 'Session name', kind: 'inline', zone: 'title' },
  { id: 'core.status', label: 'Status / progress', kind: 'inline', zone: 'title' },
  { id: 'core.summary', label: 'Summary', kind: 'block', zone: 'always' },
  { id: 'core.process', label: 'Process', kind: 'inline', zone: 'selected' },
  { id: 'core.tasks', label: 'Task list', kind: 'block', zone: 'selected' },
  { id: 'core.progress', label: 'Progress bar', kind: 'block', zone: 'selected' },
];

/**
 * The layout without user configuration — today's card: name, plugin title
 * badges, status in the title row; the summary (and other always fields)
 * below; process, plugin blocks, tasks and progress on the selected card.
 * `fields` lists plugin fields in plugin order.
 */
export function defaultCardLayout(fields: FieldMeta[]): ResolvedCardLayout {
  const plugin = fields.filter((f) => !f.id.startsWith('core.'));
  const inZone = (zone: SessionZone) => plugin.filter((f) => f.zone === zone);
  return {
    title: ['core.name', ...inZone('title').filter((f) => f.kind === 'inline').map((f) => f.id), 'core.status'],
    always: [['core.summary'], ...inZone('always').map((f) => [f.id])],
    selected: [
      ['core.process'],
      ...inZone('selected').map((f) => [f.id]),
      // A block field defaulting to the title row cannot sit there.
      ...inZone('title').filter((f) => f.kind === 'block').map((f) => [f.id]),
      ['core.tasks'],
      ['core.progress'],
    ],
  };
}

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

/** A zone's rows: a list of rows, or a flat list (one field per row). */
const rows = (v: unknown): string[][] =>
  Array.isArray(v)
    ? v
        .map((r) => (Array.isArray(r) ? ids(r) : typeof r === 'string' && r ? [r] : []))
        .filter((r) => r.length > 0)
    : [];

/** Normalize a raw `sessionCard` value (YAML) — invalid parts are dropped. */
export function parseCardLayout(raw: unknown): SessionCardLayout | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: SessionCardLayout = {};
  if (r.title !== undefined) out.title = ids(r.title);
  if (r.always !== undefined) out.always = rows(r.always);
  if (r.selected !== undefined) out.selected = rows(r.selected);
  if (r.hidden !== undefined) out.hidden = ids(r.hidden);
  return out;
}

/**
 * Resolve the effective layout for the fields available right now.
 * A configured zone replaces the default for that zone, and a field placed
 * explicitly anywhere is left out of zones still on their default; ids naming no
 * available field are skipped (a disabled plugin's fields simply vanish);
 * a block field configured into the title row moves to the selected zone.
 * Every available field placed nowhere and not `hidden` is appended to its
 * default zone, so a newly enabled plugin is never invisible. `core.name`
 * is always in the title row.
 */
export function resolveCardLayout(
  layout: SessionCardLayout | undefined,
  fields: FieldMeta[],
): ResolvedCardLayout {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const defaults = defaultCardLayout(fields);
  const hidden = new Set(layout?.hidden ?? []);
  hidden.delete('core.name');
  const placed = new Set<string>();
  const take = (id: string) => {
    if (placed.has(id) || hidden.has(id) || !byId.has(id)) return false;
    placed.add(id);
    return true;
  };
  // Explicit placements win: a zone still on its default never claims a
  // field the user configured into another zone.
  const configured = new Set([
    ...(layout?.title ?? []),
    ...(layout?.always ?? []).flat(),
    ...(layout?.selected ?? []).flat(),
  ]);
  const fromDefault = (ids: string[]) => ids.filter((id) => !configured.has(id));
  const demoted: string[][] = [];
  const title = (layout?.title ?? fromDefault(defaults.title)).filter((id) => {
    if (byId.get(id)?.kind === 'block') {
      if (take(id)) demoted.push([id]);
      return false;
    }
    return take(id);
  });
  if (!placed.has('core.name')) {
    title.unshift('core.name');
    placed.add('core.name');
  }
  const zoneRows = (rowsIn: string[][] | undefined, fallback: string[][]) =>
    (rowsIn ?? fallback.map(fromDefault)).map((row) => row.filter(take)).filter((row) => row.length > 0);
  const always = zoneRows(layout?.always, defaults.always);
  const selected = [...zoneRows(layout?.selected, defaults.selected), ...demoted];
  // Unplaced fields fall back to their default zone.
  for (const f of fields) {
    if (placed.has(f.id) || hidden.has(f.id)) continue;
    placed.add(f.id);
    if (f.zone === 'title' && f.kind === 'inline') {
      // Before core.status when it sits at the end of the title row.
      const at = title.indexOf('core.status');
      if (at >= 0) title.splice(at, 0, f.id);
      else title.push(f.id);
    } else if (f.zone === 'always') always.push([f.id]);
    else selected.push([f.id]);
  }
  return { title, always, selected };
}
