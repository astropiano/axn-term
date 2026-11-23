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

  it('intercepts axn-ide: optional dir arg defaults to cwd', () => {
    const paths: string[] = [];
    const { input, written } = setup({ onIdeRequest: (p) => paths.push(p) });
    type(input, 'axn-ide src\r');
    type(input, 'axn-ide\r');
    expect(paths).toEqual(['src', '.']);
    expect(written).toEqual(['\x15', '\x15']);
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

  it('off mode: axn-* still intercepts, other input passes through', () => {
    const paths: string[] = [];
    let mode: 'full' | 'agent' | 'off' = 'off';
    const { input } = setup({
      mode: () => mode,
      onEditorRequest: (p) => paths.push(p),
    });
    // A foreground program owns input, but axn-* is our namespace — the
    // line is claimed (chars + a \x15 clear go to the writer).
    type(input, 'axn-edit foo\r');
    expect(paths).toEqual(['foo']);
    // Non-axn input passes straight through untouched.
    const results = type(input, 'echo hi\r');
    expect(results.every((r) => r === false)).toBe(true);
    expect(paths).toEqual(['foo']);
    mode = 'full';
    type(input, 'axn-edit bar\r');
    expect(paths).toEqual(['foo', 'bar']);
  });

  it('OSC color reports pass through without desyncing the line buffer', () => {
    const paths: string[] = [];
    const { input } = setup({ onEditorRequest: (p) => paths.push(p) });
    // A report chunk mid-input is terminal data, not typing: it must not
    // reset tracking (its \x1b would otherwise kill the next line's
    // interception — command falls through to the shell, "not found").
    input('axn-edit ');
    const passed = input('\x1b]11;rgb:fdfd/f6f6/e3e3\x1b\\');
    expect(passed).toBe(false);
    input('foo\r');
    expect(paths).toEqual(['foo']);
  });

  it('bracketed paste of an axn-* line still intercepts', () => {
    const paths: string[] = [];
    const { input } = setup({ onEditorRequest: (p) => paths.push(p) });
    // Pasted text arrives wrapped in \x1b[200~ ... \x1b[201~ — the markers
    // are input markers, not cursor moves; the pasted line must track.
    type(input, '\x1b[200~axn-edit foo\x1b[201~\r');
    expect(paths).toEqual(['foo']);
  });

  it('an escape at an empty buffer does not kill the next line', () => {
    const paths: string[] = [];
    const { input } = setup({ onEditorRequest: (p) => paths.push(p) });
    input('\x1b[I'); // e.g. a stray terminal sequence before typing
    type(input, 'axn-edit foo\r');
    expect(paths).toEqual(['foo']);
  });

  describe('command feedback (display channel)', () => {
    const setupDisplay = (
      result: string | false | undefined | Promise<string | false | undefined>,
    ) => {
      const written: string[] = [];
      const display: string[] = [];
      const input = createHiddenCommandInput({
        write: (d) => written.push(d),
        writeDisplay: (d) => display.push(d),
        mode: () => 'full' as const,
        onSessionCommand: () => result,
      });
      return { input, written, display };
    };

    it('echo "msg" feedback renders as command output, not an echo command', () => {
      const { input, written, display } = setupDisplay('echo "done: opened"');
      type(input, 'axn-session .\r');
      // Display: newline + message + newline — the typed line stays on screen.
      expect(display).toEqual(['\r\ndone: opened\r\n']);
      // PTY: kill the input buffer + empty submit for a fresh prompt —
      // the literal `echo` never reaches the shell.
      expect(written).toEqual(['\x15\r']);
    });

    it('multi-line feedback becomes \r\n-separated output lines', () => {
      const { input, written, display } = setupDisplay('echo "a\\nb"');
      type(input, 'axn-workspaces\r');
      expect(display).toEqual(['\r\na\r\nb\r\n']);
      expect(written).toEqual(['\x15\r']);
    });

    it('a swallowed command (false) keeps the line and draws a blank line', () => {
      const { input, written, display } = setupDisplay(false);
      type(input, 'axn-workspace-up\r');
      expect(display).toEqual(['\r\n']);
      expect(written).toEqual(['\x15\r']);
    });

    it('a real replacement string is typed into the shell, not displayed', () => {
      const { input, written, display } = setupDisplay('devin -r work');
      type(input, 'axn-devin-resume\r');
      expect(display).toEqual([]);
      expect(written).toEqual(['\x15', 'devin -r work\r']);
    });

    it('undefined lets the line pass through to the shell', () => {
      const { input, written, display } = setupDisplay(undefined);
      const results = type(input, 'whatever\r');
      expect(results.at(-1)).toBe(false);
      expect(display).toEqual([]);
      expect(written).toEqual([]);
    });

    it('async echo feedback resolves to the same display path', async () => {
      const { input, written, display } = setupDisplay(Promise.resolve('echo "late"'));
      type(input, 'axn-session .\r');
      await Promise.resolve();
      expect(display).toEqual(['\r\nlate\r\n']);
      expect(written).toEqual(['\x15\r']);
    });

    it('without a display channel echo falls back to a literal shell command', () => {
      const { input, written } = setup({ onSessionCommand: () => 'echo "msg"' });
      type(input, 'axn-x\r');
      expect(written).toEqual(['\x15', 'echo "msg"\r']);
    });
  });

  it('agent mode: only /exit is notified, everything else passes', () => {
    const lines: string[] = [];
    const paths: string[] = [];
    const { input } = setup({
      mode: () => 'agent',
      onSessionCommand: (l) => {
        lines.push(l);
        return false;
      },
      onEditorRequest: (p) => paths.push(p),
    });
    const exitResults = type(input, '/exit\r');
    expect(exitResults.every((r) => r === false)).toBe(true); // passes to the agent
    expect(lines).toEqual(['/exit']);
    // axn-* is our namespace — claimed even with an agent foreground,
    // so a stale fg can't turn it into a shell 'command not found'.
    type(input, 'axn-edit foo\r');
    expect(paths).toEqual(['foo']);
    // Non-axn input still belongs to the agent — untouched.
    const otherResults = type(input, 'hello agent\r');
    expect(otherResults.every((r) => r === false)).toBe(true);
    expect(lines).toEqual(['/exit']);
    expect(paths).toEqual(['foo']);
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

describe('createHiddenCommandInput — whole chunks', () => {
  // What reaches the PTY: handler writes plus chunks it hands back.
  function pty(overrides: Partial<Parameters<typeof createHiddenCommandInput>[0]> = {}) {
    const { input, written } = setup(overrides);
    const send = (d: string) => {
      if (!input(d)) written.push(d);
    };
    return { send, out: () => written.join('') };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('async pass-through with text and Enter in one chunk keeps the text', async () => {
    const { send, out } = pty({ onSessionCommand: () => Promise.resolve(undefined) });
    send('git status\r');
    expect(out()).toBe('git status'); // Enter held until the outcome is known
    await flush();
    expect(out()).toBe('git status\r');
  });

  it('async hook: the rest of the chunk follows the line, in order', async () => {
    const lines: string[] = [];
    const { send, out } = pty({
      onSessionCommand: (l) => {
        lines.push(l);
        return Promise.resolve(l === 'axn-x' ? 'echo replaced' : undefined);
      },
    });
    send('git status\raxn-x\rls\r');
    await flush();
    expect(lines).toEqual(['git status', 'axn-x', 'ls']);
    expect(out()).toBe('git status\raxn-x\x15echo replaced\rls\r');
  });

  it('sync built-in mid-chunk does not swallow later input', () => {
    const renamed: string[] = [];
    const { send, out } = pty({
      onLocalCommand: (l) => {
        const m = /^axn-rename\s+(.*)$/.exec(l);
        if (m) renamed.push(m[1]);
        return !!m;
      },
      onSessionCommand: () => undefined,
    });
    send('axn-rename x\rls\r');
    expect(renamed).toEqual(['x']);
    expect(out()).toBe('axn-rename x\x15ls\r');
  });

  it('sync session command mid-chunk, then more input', () => {
    const { send, out } = pty({
      onSessionCommand: (l) => (l === 'axn-session' ? false : undefined),
    });
    send('pwd\raxn-session\rls');
    expect(out()).toBe('pwd\raxn-session\x15ls');
  });

  it('plain chunks are handed back to the caller whole', () => {
    const { input, written } = setup({ onSessionCommand: () => undefined });
    expect(input('ls\rpwd\r')).toBe(false);
    expect(written).toEqual([]);
  });

  it('input typed while a hook is pending waits behind the Enter', async () => {
    let resolve!: (r: undefined) => void;
    const { send, out } = pty({
      onSessionCommand: (l) =>
        l === 'make' ? new Promise<undefined>((r) => (resolve = r)) : undefined,
    });
    for (const ch of 'make\r') send(ch);
    for (const ch of 'ls') send(ch);
    expect(out()).toBe('make');
    resolve(undefined);
    await flush();
    expect(out()).toBe('make\rls');
    // tracking continues normally afterwards
    send('\r');
    expect(out()).toBe('make\rls\r');
  });

  it('a second async line while the first is pending stays in order', async () => {
    const resolvers: Array<(r: string | undefined) => void> = [];
    const { send, out } = pty({
      onSessionCommand: () => new Promise((r) => resolvers.push(r)),
    });
    send('a\r');
    send('b\r');
    send('c');
    expect(out()).toBe('a');
    resolvers[0](undefined);
    await flush();
    expect(out()).toBe('a\rb');
    resolvers[1]('echo b');
    await flush();
    expect(out()).toBe('a\rb\x15echo b\rc');
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
