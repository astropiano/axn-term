/**
 * Shells set the terminal title to `user@host: dir` (bash/zsh defaults). The
 * user knows who and where they are, so a session's name keeps only the
 * folder part. Titles without that prefix (agent titles, `vim file`) pass
 * through untouched; a title that is nothing but the prefix is kept as is.
 */
const USER_HOST_PREFIX = /^[\w.+-]+@[\w.-]+:\s*(?=\S)/;

export function stripUserHost(title: string): string {
  return title.replace(USER_HOST_PREFIX, '');
}
