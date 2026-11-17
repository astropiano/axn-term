import { describe, expect, it } from 'vitest';
import type { ShellSession } from '../types';
import type { SessionViewPlugin } from './session-plugins/plugin';
import { matchesTerms, placedFieldIds, searchLayout, sessionSearchTerms } from './sessionSearch';

const session = (extra: Partial<ShellSession> = {}): ShellSession => ({
  id: 's1',
  workspaceId: 'w',
  name: '',
  topic: '',
  summary: 'wiring the manifest',
  tasks: [],
  progress: 0,
  output: '',
  autoName: '✳ AIACC-921 Onnx',
  process: 'claude',
  ...extra,
});

const plugin: SessionViewPlugin = {
  id: 'p',
  title: 'p',
  sessionFields: [
    { id: 'branch', label: 'Branch', kind: 'inline', zone: 'title', value: () => 'x', search: () => ['feature/VECTORDB-29-x'] },
    { id: 'quiet', label: 'Quiet', kind: 'inline', zone: 'always', value: () => null, search: () => null },
    { id: 'persona', label: 'Persona', kind: 'inline', zone: 'title', value: () => 'bot' }, // not searchable
    { id: 'boom', label: 'Boom', kind: 'inline', zone: 'always', value: () => 'x', search: () => { throw new Error('x'); } },
  ],
};

const termsFor = (sessionCard: unknown, s = session(), summaries = true) =>
  sessionSearchTerms(s, [plugin], placedFieldIds(searchLayout([plugin], sessionCard)), { sessionSummaries: summaries }, () => ({}) as never);

describe('sessionSearchTerms', () => {
  it('collects core names, summary, process and placed searchable fields', () => {
    const t = termsFor({ title: ['core.name', 'p.branch', 'p.persona'], always: [['core.summary'], ['p.quiet'], ['p.boom']] });
    expect(t).toEqual(['✳ AIACC-921 Onnx', 'wiring the manifest', 'claude', 'feature/VECTORDB-29-x']);
    expect(matchesTerms(t, 'vectordb-29')).toBe(true);
    expect(matchesTerms(t, 'aiacc-921')).toBe(true);
    expect(matchesTerms(t, 'bot')).toBe(false); // persona declares no search
  });

  it('never searches hidden fields', () => {
    const t = termsFor({ title: ['core.name', 'p.branch'], hidden: ['p.branch', 'core.summary', 'core.process'] });
    expect(t).toEqual(['✳ AIACC-921 Onnx']);
  });

  it('never searches plugin fields the layout does not place', () => {
    expect(termsFor(undefined)).not.toContain('feature/VECTORDB-29-x');
  });

  it('skips the summary while summaries are switched off', () => {
    expect(termsFor(undefined, session(), false)).not.toContain('wiring the manifest');
  });
});
