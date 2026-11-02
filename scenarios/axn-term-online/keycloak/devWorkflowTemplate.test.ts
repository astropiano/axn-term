import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCommandTemplate } from './devWorkflow';

// Values an MR title / branch / workflow var could carry. Each one tries to
// create a file in the cwd if any part of it runs as shell code.
const HOSTILE = [
  '$(touch pwned-a)',
  '`touch pwned-b`',
  '"; touch pwned-c; echo "',
  "'; touch pwned-d; echo '",
  '\\"; touch pwned-e #',
  "x\\'; touch pwned-f; '",
  'line1\ntouch pwned-g\n',
  '\n"\ntouch pwned-h\n"',
  '-n',
  '--help',
  '*',
  '${HOME}$PATH',
  'a b\tc',
  '',
  'fix: {{mr_title}} "quoted" \'single\' \\ back',
];

const SHELLS = ['sh', 'bash'].filter((s) => spawnSync(s, ['-c', 'true']).status === 0);

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'axn-tpl-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(shell: string, cmd: string): string {
  const r = spawnSync(shell, ['-c', cmd], { cwd: dir, encoding: 'utf8' });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  return r.stdout;
}

// template → expected output for value v
const POSITIONS: Array<[string, string, (v: string) => string]> = [
  ['bare', "printf '<%s>' {{x}}", (v) => `<${v}>`],
  ['bare, glued to text', "printf '<%s>' pre-{{x}}-post", (v) => `<pre-${v}-post>`],
  ['inside "…"', 'printf \'<%s>\' "pre {{x}} post"', (v) => `<pre ${v} post>`],
  ["inside '…'", "printf '<%s>' 'pre {{x}} post'", (v) => `<pre ${v} post>`],
  ['wrapped "{{x}}"', 'printf \'<%s>\' "{{x}}"', (v) => `<${v}>`],
  ["wrapped '{{x}}'", "printf '<%s>' '{{x}}'", (v) => `<${v}>`],
  ['twice in one "…"', 'printf \'<%s>\' "{{x}}={{x}}"', (v) => `<${v}=${v}>`],
  ['after an escaped quote', 'printf \'<%s>\' "a \\" {{x}}"', (v) => `<a " ${v}>`],
  [
    'inside "…$(…)…"',
    'printf \'<%s>\' "a $(printf \'[%s]\' "in {{x}}") b"',
    (v) => `<a [in ${v}] b>`,
  ],
  ['after a comment line', "# note {{x}}\nprintf '<%s>' {{x}}", (v) => `<${v}>`],
  ['commit message style', 'printf \'<%s>\' "fix: {{x}} (!12)"', (v) => `<fix: ${v} (!12)>`],
];

describe('renderCommandTemplate quoting', () => {
  for (const shell of SHELLS) {
    describe(shell, () => {
      for (const [name, tpl, expected] of POSITIONS) {
        it(`passes hostile values verbatim — ${name}`, () => {
          for (const v of HOSTILE) {
            const cmd = renderCommandTemplate(tpl, { x: v });
            expect(run(shell, cmd), cmd).toBe(expected(v));
          }
          expect(readdirSync(dir)).toEqual([]);
        });
      }
    });
  }

  it('keeps the seed templates working', () => {
    const vars = { workflow: 'simple', state: 'doing', cwd: '/home/u/src/$(touch pwned) "x"' };
    const cmd = renderCommandTemplate(
      'echo "simple workflow {{workflow}} now in state {{state}} (cwd {{cwd}})"',
      vars,
    );
    expect(run('sh', cmd)).toBe(`simple workflow simple now in state doing (cwd ${vars.cwd})\n`);
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
  });

  it('keeps readable output for plain values', () => {
    expect(renderCommandTemplate('git commit -m "fix: {{t}}"', { t: 'typo' })).toBe(
      'git commit -m "fix: "typo""',
    );
    expect(renderCommandTemplate('git commit -m "fix: {{t}}"', { t: 'a"b' })).toBe(
      'git commit -m "fix: "\'a"b\'""',
    );
  });

  it('puts raw keys in as whole words in every context', () => {
    const raw = '"$(printf %s aGk= | base64 -d)"';
    const out = renderCommandTemplate('printf \'<%s>\' "say: {{prompt}}" \'{{prompt}}\'', { prompt: raw }, ['prompt']);
    expect(run('sh', out)).toBe('<say: hi><hi>');
  });

  it('refuses placeholders where a word cannot be spliced in', () => {
    for (const tpl of [
      'echo `echo {{x}}`',
      'echo "`echo {{x}}`"',
      'echo ${X:-{{x}}}',
      'echo $(( {{x}} + 1 ))',
      "echo $'{{x}}'",
      'cat <<EOF\n{{x}}\nEOF',
    ]) {
      expect(() => renderCommandTemplate(tpl, { x: '1' }), tpl).toThrow(/cannot be used inside/);
    }
    // here-strings and unknown keys are fine
    expect(renderCommandTemplate('cat <<<{{x}} {{nope}}', { x: 'a b' })).toBe("cat <<<'a b' {{nope}}");
  });

  it('keeps comments on one line', () => {
    const cmd = renderCommandTemplate('true # {{x}}', { x: 'a\ntouch pwned-comment' });
    expect(cmd).toBe('true # a touch pwned-comment');
  });
});
