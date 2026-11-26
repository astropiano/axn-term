/**
 * "This branch already merged" — shared by the GitLab and GitHub plugins.
 *
 * Both forges can list the merged MR/PR of a branch together with the head
 * commit it was merged at (GitLab `sha`, GitHub `headRefOid`). Merges are
 * usually squashed, so ancestry against the merge commit proves nothing;
 * the *source head* is what stays an ancestor of the local branch. That
 * gives the two states the session chip shows:
 *
 * - merged: HEAD is exactly that head, nothing uncommitted;
 * - merged, but there is new work: commits after it (pushed or not) or
 *   uncommitted/untracked files.
 *
 * A merged MR whose head is not an ancestor of HEAD is an older MR of a
 * reused branch name and is ignored.
 */

import { shellQuote } from '../../shellQuote';
import type { MrTone } from './mrStatus';

/** A merged MR/PR as the forge lists it. */
export interface MergedCandidate {
  reference: string;
  title: string;
  url: string;
  /** Head commit of the source branch when it was merged. */
  sha: string;
  mergedAt?: string;
}

/** What the local checkout looks like relative to that head. */
export interface MergedLocal {
  /** The merged head is an ancestor of (or equal to) HEAD. */
  ancestor: boolean;
  /** Commits on HEAD that the merged MR did not contain. */
  commitsAfter: number;
  /** Files with uncommitted changes (untracked excluded). */
  uncommitted: number;
  untracked: number;
}

/** Stored in pluginState (`merged`), apart from the open MRs/PRs every other consumer reads. */
export interface SessionMerged extends MergedCandidate, MergedLocal {
  /** `ahead/dirty/untracked` of the session's repo when probed — a change means: probe again. */
  sig: string;
}

/** Shell probe for one candidate head, run in the repo root. */
export function mergedProbeScript(sha: string): string {
  const q = shellQuote(sha);
  return [
    `if git merge-base --is-ancestor ${q} HEAD 2>/dev/null; then`,
    `echo "ancestor 1"; echo "after $(git rev-list --count ${q}..HEAD 2>/dev/null)";`,
    `else echo "ancestor 0"; fi;`,
    `echo "dirty $(git status --porcelain 2>/dev/null | grep -vc '^??')";`,
    `echo "untracked $(git status --porcelain 2>/dev/null | grep -c '^??')"`,
  ].join(' ');
}

export function parseMergedProbe(out: string): MergedLocal {
  const num = (key: string) => {
    const m = new RegExp(`^${key} (\\d+)`, 'm').exec(out);
    return m ? Number(m[1]) : 0;
  };
  return {
    ancestor: num('ancestor') === 1,
    commitsAfter: num('after'),
    uncommitted: num('dirty'),
    untracked: num('untracked'),
  };
}

/** The signature of the repo facts a probe was made under (see `SessionMerged.sig`). */
export function repoSig(
  repo: { ahead: number; dirty: boolean; untracked: number } | undefined,
): string {
  return repo ? `${repo.ahead}/${repo.dirty ? 1 : 0}/${repo.untracked}` : '';
}

/** Newest first; candidates without a date sort last. */
function newestFirst(a: MergedCandidate, b: MergedCandidate): number {
  return (Date.parse(b.mergedAt ?? '') || 0) - (Date.parse(a.mergedAt ?? '') || 0);
}

/**
 * The merged MR/PR this checkout is a continuation of: the newest candidate
 * whose head is an ancestor of HEAD. `probe` runs the git script in the repo.
 */
export async function findMerged(
  candidates: MergedCandidate[],
  probe: (script: string) => Promise<string>,
  sig: string,
): Promise<SessionMerged | undefined> {
  for (const candidate of candidates.filter((c) => c.sha).sort(newestFirst)) {
    let local: MergedLocal;
    try {
      local = parseMergedProbe(await probe(mergedProbeScript(candidate.sha)));
    } catch {
      continue;
    }
    if (local.ancestor) return { ...candidate, ...local, sig };
  }
  return undefined;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Chip colour and tooltip lines: violet = merged, orange = merged but there is new work. */
export function mergedVerdict(m: MergedLocal): { tone: MrTone; reasons: string[] } {
  const reasons = ['merged'];
  if (m.commitsAfter > 0) reasons.push(`${count(m.commitsAfter, 'new commit')} since the merge`);
  if (m.uncommitted > 0) reasons.push(count(m.uncommitted, 'uncommitted file'));
  if (m.untracked > 0) reasons.push(count(m.untracked, 'untracked file'));
  return { tone: reasons.length > 1 ? 'orange' : 'violet', reasons };
}
