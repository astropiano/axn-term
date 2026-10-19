import { describe, it, expect } from 'vitest';
import {
  buildExplainPrompt,
  buildTalkPrompt,
  explainCommand,
  explainKeyForCommit,
  explainKeyForCommitFile,
  explainKeyForWorktreeFile,
  fnv1a,
  loadExplanations,
  normalizeReviewAgent,
  removeExplanation,
  saveExplanation,
  talkCommand,
  talkResumeCommand,
} from './gitReview';

const memStorage = () => {
  const m = new Map<string, string>();
  return {
    get: (k: string) => Promise.resolve(m.get(k) ?? null),
    set: (k: string, v: string | null) => {
      if (v === null) m.delete(k);
      else m.set(k, v);
      return Promise.resolve();
    },
  };
};

describe('normalizeReviewAgent', () => {
  it('accepts the resumable agent clis, rejects everything else', () => {
    expect(normalizeReviewAgent('devin')).toBe('devin');
    expect(normalizeReviewAgent('claude')).toBe('claude');
    expect(normalizeReviewAgent('gemini')).toBe('gemini');
    expect(normalizeReviewAgent('codex')).toBe('codex');
    expect(normalizeReviewAgent('')).toBeNull();
    expect(normalizeReviewAgent('gpt')).toBeNull();
    expect(normalizeReviewAgent('vibe')).toBeNull();
    expect(normalizeReviewAgent(undefined)).toBeNull();
  });
});

describe('fnv1a', () => {
  it('is stable and differs on content', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
    expect(fnv1a('')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('explain keys', () => {
  it('addresses commits by sha', () => {
    expect(explainKeyForCommit('abc123')).toBe('commit:abc123');
    expect(explainKeyForCommitFile('abc123', 'src/a.ts')).toBe('commit:abc123:src/a.ts');
    expect(explainKeyForWorktreeFile('src/a.ts')).toBe('wt:src/a.ts');
  });
});

describe('prompts', () => {
  it('embeds subject and diff, truncates long diffs', () => {
    const p = buildExplainPrompt('commit abc — fix bug', 'diff --git a/f b/f\n+x');
    expect(p).toContain('commit abc — fix bug');
    expect(p).toContain('+x');
    const long = 'y'.repeat(20000);
    expect(buildExplainPrompt('s', long).length).toBeLessThan(20000);
    expect(buildExplainPrompt('s', long)).toContain('[diff truncated]');
    expect(buildTalkPrompt('s', 'd')).toContain('summarizing');
  });
});

describe('agent commands', () => {
  const b64Of = (cmd: string) => /printf %s '([A-Za-z0-9+/=]+)'/.exec(cmd)?.[1] ?? '';
  const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');

  it('devin uses -p for explain and -- for interactive', () => {
    expect(explainCommand('devin', 'p')).toContain('devin -p "$(');
    expect(talkCommand('devin', 'p')).toContain('devin -- "$(');
    expect(talkCommand('devin', 'p')).toContain('exec');
  });
  it('claude uses -p for explain and a seeded interactive prompt', () => {
    expect(explainCommand('claude', 'p')).toContain('claude -p "$(');
    expect(talkCommand('claude', 'p')).toContain('claude "$(');
  });
  it('gemini uses -p for explain and -i for the seeded interactive prompt', () => {
    expect(explainCommand('gemini', 'p')).toContain('gemini -p "$(');
    expect(talkCommand('gemini', 'p')).toContain('gemini -i "$(');
  });
  it('codex uses exec for explain and a positional prompt interactively', () => {
    expect(explainCommand('codex', 'p')).toContain('codex exec "$(');
    expect(talkCommand('codex', 'p')).toContain('codex "$(');
  });
  it('embeds the prompt as base64 — survives quotes/$()/backticks unchanged', () => {
    const prompt = "don't expand $HOME `id` $(whoami) «üñï»";
    const cmd = explainCommand('devin', prompt);
    expect(decode(b64Of(cmd))).toBe(prompt);
    expect(cmd).not.toContain('rm -f');
    // single line — no heredoc parsing hazards under POSIX sh
    expect(cmd).not.toContain('\n');
  });
  it('strips NUL bytes argv cannot carry', () => {
    expect(decode(b64Of(explainCommand('devin', 'a\0b')))).toBe('ab');
  });
  it('resume command re-enters the conversation instead of re-seeding', () => {
    // devin resumes by captured name once known, else the directory's latest
    expect(talkResumeCommand('devin', 'gray-party')).toBe(
      'devin -r gray-party; exec "${SHELL:-sh}" -l',
    );
    expect(talkResumeCommand('devin')).toBe('devin -c; exec "${SHELL:-sh}" -l');
    expect(talkResumeCommand('claude')).toBe('claude -c; exec "${SHELL:-sh}" -l');
    // claude ignores the name — -c continues the most recent conversation
    expect(talkResumeCommand('claude', 'ignored')).toBe(
      'claude -c; exec "${SHELL:-sh}" -l',
    );
    // gemini picks interactively, codex resumes its latest
    expect(talkResumeCommand('gemini')).toBe('gemini --resume; exec "${SHELL:-sh}" -l');
    expect(talkResumeCommand('codex')).toBe('codex resume --last; exec "${SHELL:-sh}" -l');
  });
});

describe('explanation store', () => {
  const entry = { text: 'motivation', agent: 'devin', diffHash: 'h', at: 1 };

  it('saves, loads, and removes entries', async () => {
    const s = memStorage();
    let map = await loadExplanations(s);
    expect(map).toEqual({});
    map = await saveExplanation(s, map, 'commit:a', entry);
    expect(map['commit:a'].text).toBe('motivation');
    map = await removeExplanation(s, map, 'commit:a');
    expect(map['commit:a']).toBeUndefined();
  });

  it('caps the map at 200 entries, dropping the oldest', async () => {
    const s = memStorage();
    let map = await loadExplanations(s);
    for (let i = 0; i < 201; i++) {
      map = await saveExplanation(s, map, `k${i}`, { ...entry, at: i });
    }
    expect(Object.keys(map)).toHaveLength(200);
    expect(map.k0).toBeUndefined();
    expect(map.k200).toBeDefined();
  });

  it('tolerates corrupt store content', async () => {
    const s = memStorage();
    await s.set('git-review-explanations', 'not json{');
    expect(await loadExplanations(s)).toEqual({});
  });
});
