import { git } from '../gitClient';
import type { SessionViewPlugin } from './plugin';

/**
 * Repo inspect plugin: contributes the "Git changes…" row to the git-status
 * repo context menu (opens a `git` session tab — a GitKraken-style view with
 * the working-copy diff, commit/amend UI, and the lane-graph history) and the
 * `axn-git` hidden command doing the same from the shell.
 *
 * The tab view itself lives in the app (`app/GitInspectView.tsx`, rendered
 * for `editors[].kind === 'git'`), so persisted git tabs keep working even
 * when this plugin is disabled — the plugin only owns the entry points.
 */
export const gitInspectPlugin: SessionViewPlugin = {
  id: 'git-inspect',
  title: 'git inspect',
  version: '0.1.0',
  dependsOn: [{ id: 'git-status', version: '>=0.1.0' }],
  settings: [
    {
      key: 'reviewAgent',
      label: 'Review agent',
      description:
        'Agent powering "Explain this change"/"Talk about this change" in the git view ' +
        '(runs in the session environment; the CLI must be on PATH there).',
      type: 'string',
      options: [
        { value: '', label: 'Off' },
        { value: 'devin', label: 'Devin' },
        { value: 'claude', label: 'Claude' },
        { value: 'gemini', label: 'Gemini' },
        { value: 'codex', label: 'Codex' },
      ],
      default: '',
    },
  ],
  repoMenuItems: (ctx, repo) => [
    {
      label: 'Git changes…',
      onClick: () => ctx.openTab({ path: repo.root, kind: 'git' }),
    },
  ],
  commands: [
    {
      name: 'axn-git',
      takesArg: true,
      run: async (ctx, arg) => {
        const cwd = (await ctx.getCwd()) ?? ctx.session.cwd;
        if (!cwd) return `echo ${JSON.stringify('axn-git: no working directory')}`;
        try {
          const root = (
            await git(ctx.session.id, cwd, ['rev-parse', '--show-toplevel'])
          ).trim();
          if (!root) throw new Error('empty toplevel');
          // Optional arg is a compare ref (`axn-git origin/develop`) — the
          // view shows a "Changes vs <ref>" section (merge-base diff). An
          // unresolvable ref still opens the tab, minus the section.
          let warn: string | undefined;
          let base = arg || undefined;
          if (base) {
            const ok = await git(ctx.session.id, root, [
              'rev-parse',
              '--verify',
              '--quiet',
              base,
            ]).catch(() => '');
            if (!ok.trim()) {
              warn = `axn-git: unknown ref ${base}`;
              base = undefined;
            }
          }
          ctx.openTab({ path: root, kind: 'git', base });
          return warn ? `echo ${JSON.stringify(warn)}` : false;
        } catch {
          return `echo ${JSON.stringify('axn-git: not inside a git repository')}`;
        }
      },
    },
  ],
};
