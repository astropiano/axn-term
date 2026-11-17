/**
 * The view keys whose views stay mounted (plugins declaring
 * `keepViewMounted`): every such view opened so far, in opening order,
 * minus those no longer valid. Same array back when nothing changed, so it
 * can feed a React state setter without re-rendering.
 */
export function nextKeptViews(
  prev: readonly string[],
  active: string | null,
  keep: (key: string) => boolean,
  valid: (key: string) => boolean,
): string[] {
  const kept = prev.filter(valid);
  if (active && !kept.includes(active) && keep(active) && valid(active)) kept.push(active);
  return kept.length === prev.length && kept.every((k, i) => k === prev[i])
    ? (prev as string[])
    : kept;
}
