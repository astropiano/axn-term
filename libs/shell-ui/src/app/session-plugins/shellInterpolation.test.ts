import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for #30: a template literal handed straight to
 * `exec(` / `writeToSession(` must quote every interpolation
 * (`shellQuote` / `shellWord` / `promptArg`, or build the line with the `sh`
 * tagged template). The allowlist below holds the interpolations that are
 * already a complete, safely built command line (or a number) — adding to it
 * needs the same justification.
 */
const ALLOWED: Record<string, string[]> = {
  // pre-built resume/launch lines (ids captured from the agent's own output, cwd shellQuoted)
  'agentResume.ts': ['line'],
  'antigravity.ts': ['line'],
  'opencode.ts': ['line'],
  'claude.ts': ['cmd'],
  'codex.ts': ['CODEX_RESUME_COMMAND'],
  'devinTasks.tsx': ['cmd'],
  'vibe.tsx': ['cmd'],
  'agents.tsx': ['await personaCommand(ctx, persona)'],
  'worktrees.tsx': ['seed'],
  // the user's own bookmarked command
  'awesomeList.tsx': ["typeof res === 'string' ? res : item.path"],
  // workflow lines: env via envPrefix (shellWord), cmd via renderCommandTemplate;
  // prompt goes into the agent as a bracketed paste, not to a shell
  'devWorkflow.tsx': ['env', 'cmd', 'bracketedPaste(prompt)', "shellLine(action, state, line, bindingOf(ctx).token ?? '')"],
  // `b` is shellQuote(`branch.${branch}`)
  'ghPr.tsx': ['b'],
  // numeric MR iids (Math.trunc(Number(…)))
  'glabMr.tsx': ['iid', 'mr.iid', 'page'],
  // fixed op union; container id from `docker ps` (hex)
  'dockerView.tsx': ['op', 'c.id'],
};

const QUOTED = /^(?:shellQuote|shellWord|promptArg)\(/;

/** Interpolated expressions of the template literal starting at `src[start]` (a backtick). */
function interpolations(src: string, start: number): string[] {
  const out: string[] = [];
  let i = start + 1;
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') {
      i += 2;
    } else if (src[i] === '$' && src[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '`') {
          // nested template: skip it whole
          j += 1;
          while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
        } else if (src[j] === '{') depth += 1;
        else if (src[j] === '}') depth -= 1;
        j += 1;
      }
      out.push(src.slice(i + 2, j - 1).trim());
      i = j;
    } else {
      i += 1;
    }
  }
  return out;
}

describe('plugin shell command lines (#30)', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.(test|stories)\.tsx?$/.test(f));

  it('quote every interpolation in exec/writeToSession template literals', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(path.join(dir, file), 'utf8');
      for (const m of src.matchAll(/\b(?:exec|writeToSession)\(\s*`/g)) {
        for (const expr of interpolations(src, (m.index ?? 0) + m[0].length - 1)) {
          if (QUOTED.test(expr) || ALLOWED[file]?.includes(expr)) continue;
          const line = src.slice(0, m.index ?? 0).split('\n').length;
          offenders.push(`${file}:${line} \${${expr}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('catches an unquoted interpolation', () => {
    const src = 'ctx.exec(`axn-dev start -s ${scenario.name} ${shellQuote(x)}`)';
    expect(interpolations(src, src.indexOf('`'))).toEqual(['scenario.name', 'shellQuote(x)']);
  });
});
