import { describe, expect, it } from 'vitest';
import {
  commonPrefix,
  createHiddenCommandInput,
  parseSessionSummary,
  runCommandChain,
  SESSION_SUMMARY_MAX,
} from './hiddenCommands';

function setup(overrides: Partial<Parameters<typeof createHiddenCommandInput>[0]> = {}) {
  const written: string[] = [];
  const deps = {
    write: (d: string) => written.push(d),
    mode: () => 'full' as const,
    ...overrides,
  };
  const input = createHiddenCommandInput(deps);
  return { input, written };
}

const type = (input: (d: string) => boolean, s: string) =>
  s.split('').map((ch) => input(ch));

describe('createHiddenCommandInput', () => {
  it('passes normal input through to the shell', () => {
    const { input, written } = setup();
    for (const consumed of type(input, 'ls -la\r')) expect(consumed).toBe(false);
    expect(written).toEqual([]);
  });

  it('intercepts axn-edit: clears the line, opens the editor', () => {
    const paths: string[] = [];
    const { input, written } = setup({ onEditorRequest: (p) => paths.push(p) });
    const results = type(input, 'axn-edit foo.txt\r');
    expect(results.at(-1)).toBe(true); // Enter consumed
    expect(written).toEqual(['\x15']);
    expect(paths).toEqual(['foo.txt']);
  });

  it('intercepts axn-browse and axn-preview', () => {
    const browsed: string[] = [];
    const previewed: string[] = [];
    const { input } = setup({
      onBrowserRequest: (p) => browsed.push(p),
      onPreviewRequest: (p) => previewed.push(p),
    });
    type(input, 'axn-browse .\r');
    type(input, 'axn-preview img.png\r');
    expect(browsed).toEqual(['.']);
    expect(previewed).toEqual(['img.png']);
  });

  it('intercepts axn-session via onSessionCommand', () => {
    const lines: string[] = [];
    const { input, written } = setup({
      onSessionCommand: (l) => {
        lines.push(l);
        return false;
      },
    });
    const results = type(input, 'axn-session src\r');
    expect(results.at(-1)).toBe(true);
    expect(written).toEqual(['\x15']);
    expect(lines).toEqual(['axn-session src']);
  });

  it('writes a replacement command returned by onSessionCommand', async () => {
    const { input, written } = setup({ onSessionCommand: () => 'echo hi' });
    type(input, 'axn-foo\r');
    await Promise.resolve();
    expect(written).toEqual(['\x15', 'echo hi\r']);
  });

  it('async pass-through (Promise<undefined>) submits the typed line unchanged', async () => {
    const { input, written } = setup({
      onSessionCommand: () => Promise.resolve(undefined),
    });
    const results = type(input, 'make test\r');
    expect(results.at(-1)).toBe(true); // Enter held until the outcome is known
    expect(written).toEqual([]); // line not cleared while pending
    await Promise.resolve();
    expect(written).toEqual(['\r']);
  });

  it('async replacement (Promise<string>) clears the line and runs the result', async () => {
    const { input, written } = setup({
      onSessionCommand: () => Promise.resolve('echo hi'),
    });
    type(input, 'axn-foo\r');
    expect(written).toEqual([]);
    await Promise.resolve();
    expect(written).toEqual(['\x15', 'echo hi\r']);
  });

  it('async swallow (Promise<false>) clears the line', async () => {
    const { input, written } = setup({ onSessionCommand: () => Promise.resolve(false) });
    type(input, 'axn-foo\r');
    await Promise.resolve();
    expect(written).toEqual(['\x15']);
  });

  it('a rejected async handler submits the typed line', async () => {
    const { input, written } = setup({
      onSessionCommand: () => Promise.reject(new Error('timeout')),
    });
    type(input, 'make test\r');
    await Promise.resolve();
    await Promise.resolve();
    expect(written).toEqual(['\r']);
  });

  it('passes unknown commands through to the shell', () => {
    const { input, written } = setup({ onSessionCommand: () => undefined });
    const results = type(input, 'make test\r');
    expect(results.every((r) => r === false)).toBe(true);
    expect(written).toEqual([]);
  });

  it('calls onLocalCommand first (sub-shell axn-rename)', () => {
    const local: string[] = [];
    const session: string[] = [];
    const { input } = setup({
      onLocalCommand: (l) => {
        local.push(l);
        return /axn-rename/.test(l);
      },
      onSessionCommand: (l) => {
        session.push(l);
        return false;
      },
    });
    type(input, 'axn-rename mine\r');
    type(input, 'axn-session\r');
    expect(local).toEqual(['axn-rename mine', 'axn-session']);
    expect(session).toEqual(['axn-session']);
  });

  it('handles backspace and ctrl-c in the tracked line', () => {
    const paths: string[] = [];
    const { input } = setup({ onEditorRequest: (p) => paths.push(p) });
    type(input, 'axn-edit fooox\x7f\x7f\x7ft.txt\r');
    expect(paths).toEqual(['fot.txt']);
    // Ctrl-C resets the buffer: the next line starts fresh.
    type(input, 'axn-edit abc\x03');
    type(input, 'axn-edit def\r');
    expect(paths).toEqual(['fot.txt', 'def']);
  });

  it('desyncs on escape sequences and resumes after Enter', () => {
    const paths: string[] = [];
    const { input } = setup({ onEditorRequest: (p) => paths.push(p) });
    // Arrow-key escape mid-line: buffer desyncs, Enter does not intercept.
    const results = type(input, 'axn-edi\x1b[D\r');
    expect(results.every((r) => r === false)).toBe(true);
    expect(paths).toEqual([]);
    // Next line tracks again.
    type(input, 'axn-edit x\r');
    expect(paths).toEqual(['x']);
  });

  it('intercepts nothing while a foreground process runs (off)', () => {
    const paths: string[] = [];
    let mode: 'full' | 'devin' | 'off' = 'off';
    const { input, written } = setup({
      mode: () => mode,
      onEditorRequest: (p) => paths.push(p),
    });
    const results = type(input, 'axn-edit foo\r');
    expect(results.every((r) => r === false)).toBe(true);
    expect(written).toEqual([]);
    expect(paths).toEqual([]);
    mode = 'full';
    type(input, 'axn-edit bar\r');
    expect(paths).toEqual(['bar']);
  });

  it('devin mode: only /exit is notified, everything else passes', () => {
    const lines: string[] = [];
    const paths: string[] = [];
    const { input, written } = setup({
      mode: () => 'devin',
      onSessionCommand: (l) => {
        lines.push(l);
        return false;
      },
      onEditorRequest: (p) => paths.push(p),
    });
    const exitResults = type(input, '/exit\r');
    expect(exitResults.every((r) => r === false)).toBe(true); // passes to devin
    expect(lines).toEqual(['/exit']);
    const editResults = type(input, 'axn-edit foo\r');
    expect(editResults.every((r) => r === false)).toBe(true);
    expect(paths).toEqual([]);
    expect(written).toEqual([]);
  });

  it('Tab completes axn-* lines and swallows the tab', async () => {
    const { input, written } = setup({
      onCompleteInput: (l) =>
        Promise.resolve(l === 'axn-se' ? ['axn-session ', 'axn-session-mv '] : []),
    });
    type(input, 'axn-se');
    expect(input('\t')).toBe(true);
    await Promise.resolve();
    expect(written).toEqual(['\x15axn-session']);
  });

  it('Tab on non-axn lines passes through', () => {
    const { input, written } = setup({
      onCompleteInput: () => Promise.resolve(['x']),
    });
    type(input, 'ls ');
    expect(input('\t')).toBe(false);
    expect(written).toEqual([]);
  });
});

describe('runCommandChain', () => {
  const noError = () => {
    throw new Error('unexpected error');
  };

  it('returns the first sync claim and skips later handlers', () => {
    const seen: number[] = [];
    const result = runCommandChain(
      [1, 2, 3],
      (n) => {
        seen.push(n);
        return n === 2 ? 'two' : undefined;
      },
      noError,
    );
    expect(result).toBe('two');
    expect(seen).toEqual([1, 2]);
  });

  it('continues past an async handler that resolves undefined', async () => {
    const seen: number[] = [];
    const result = runCommandChain(
      [1, 2, 3],
      (n) => {
        seen.push(n);
        if (n === 1) return Promise.resolve(undefined);
        if (n === 2) return Promise.resolve(false);
        return 'three';
      },
      noError,
    );
    await expect(result).resolves.toBe(false);
    expect(seen).toEqual([1, 2]);
  });

  it('continues past failing handlers and passes through when unclaimed', async () => {
    const errors: number[] = [];
    const result = runCommandChain(
      [1, 2, 3],
      (n) => {
        if (n === 1) throw new Error('sync');
        if (n === 2) return Promise.reject(new Error('async'));
        return Promise.resolve(undefined);
      },
      (n) => errors.push(n),
    );
    await expect(result).resolves.toBeUndefined();
    expect(errors).toEqual([1, 2]);
  });

  it('is synchronous when no handler is async', () => {
    expect(runCommandChain([1, 2], () => undefined, noError)).toBeUndefined();
  });
});

describe('parseSessionSummary', () => {
  it('parses quoted and unquoted text', () => {
    expect(parseSessionSummary("axn-session-summary 'fixing the auth bug'")).toBe(
      'fixing the auth bug',
    );
    expect(parseSessionSummary('axn-session-summary "double quoted"')).toBe('double quoted');
    expect(parseSessionSummary('axn-session-summary bare words here')).toBe('bare words here');
  });

  it('clears on no argument', () => {
    expect(parseSessionSummary('axn-session-summary')).toBe('');
    expect(parseSessionSummary("axn-session-summary ''")).toBe('');
  });

  it('caps at SESSION_SUMMARY_MAX', () => {
    const long = 'x'.repeat(SESSION_SUMMARY_MAX + 50);
    expect(parseSessionSummary(`axn-session-summary ${long}`)).toHaveLength(SESSION_SUMMARY_MAX);
  });

  it('returns undefined for other commands', () => {
    expect(parseSessionSummary('axn-session')).toBeUndefined();
    expect(parseSessionSummary('axn-session-mv ws')).toBeUndefined();
    expect(parseSessionSummary('ls -la')).toBeUndefined();
  });
});

describe('commonPrefix', () => {
  it('finds the longest shared prefix', () => {
    expect(commonPrefix(['axn-session', 'axn-session-mv'])).toBe('axn-session');
    expect(commonPrefix([])).toBe('');
    expect(commonPrefix(['abc'])).toBe('abc');
    expect(commonPrefix(['abc', 'xyz'])).toBe('');
  });
});
