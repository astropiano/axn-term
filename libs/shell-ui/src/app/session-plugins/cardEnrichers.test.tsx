// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginSettings } from '../pluginSettings';

let settings: PluginSettings = {};
vi.mock('../PluginSettingsProvider', () => ({
  useOptionalPluginSettings: () => ({ pluginSettings: settings }),
}));

import { CardChips, chipStyle, registerCardEnricher, resetCardEnrichers, resolveChipColor, type CardEnricher } from './cardEnrichers';

function fakeEnricher(overrides: Partial<CardEnricher> = {}) {
  const enrich = vi.fn(async (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, { chips: [{ label: `${k} · Open`, href: `https://x/${k}` }] }])),
  );
  const enricher: CardEnricher = {
    id: 'fake',
    enabled: (s) => s.fake?.enabled === true,
    match: (subject) => /([A-Z]+-\d+)/.exec(subject.mr?.title ?? '')?.[1],
    enrich,
    ...overrides,
  };
  registerCardEnricher(enricher);
  return enrich;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mr = (title: string) => ({ mr: { title, url: '' } });

let root: Root;
let host: HTMLDivElement;
const roots: Root[] = [];

function render(node: ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  const r = root;
  return { container: host, unmount: () => act(() => r.unmount()) };
}

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 60)));
const text = () => document.body.textContent ?? '';

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  resetCardEnrichers();
  settings = {};
});

describe('CardChips', () => {
  it('batches every visible key into one enrich call and renders the chips', async () => {
    settings = { fake: { enabled: true } };
    const enrich = fakeEnricher();
    render(
      <>
        <CardChips subject={mr('A-1 first')} />
        <CardChips subject={mr('A-2 second')} />
        <CardChips subject={mr('no key')} />
      </>,
    );
    await settle();
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich.mock.calls[0][0].sort()).toEqual(['A-1', 'A-2']);
    expect(text()).toContain('A-1 · Open');
    expect(text()).toContain('A-2 · Open');
  });

  it('serves repeat renders from the cache', async () => {
    settings = { fake: { enabled: true } };
    const enrich = fakeEnricher();
    const { unmount } = render(<CardChips subject={mr('A-1')} />);
    await settle();
    unmount();
    render(<CardChips subject={mr('A-1')} />);
    await settle();
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(text()).toContain('A-1 · Open');
  });

  it('does nothing while the enricher is disabled', async () => {
    const enrich = fakeEnricher();
    const { container } = render(<CardChips subject={mr('A-1')} />);
    await settle();
    expect(enrich).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('keeps the card plain when the enricher fails', async () => {
    settings = { fake: { enabled: true } };
    fakeEnricher({ enrich: vi.fn(async () => Promise.reject(new Error('down'))) });
    const { container } = render(<CardChips subject={mr('A-1')} />);
    await settle();
    expect(container.textContent).toBe('');
  });
});

describe('chip colors', () => {
  it('resolves named theme colors and hex, nothing else', () => {
    expect(resolveChipColor('Blue')).toBe('var(--blue)');
    expect(resolveChipColor('purple')).toBe('var(--violet)');
    expect(resolveChipColor('#8E44AD')).toBe('#8e44ad');
    expect(resolveChipColor('#abc')).toBe('#abc');
    expect(resolveChipColor('red; background: url(x)')).toBeUndefined();
    expect(resolveChipColor('rgb(1,2,3)')).toBeUndefined();
    expect(resolveChipColor(undefined)).toBeUndefined();
  });

  it('fills the chip, with an explicit color winning over the tone', () => {
    expect(chipStyle({ tone: 'progress' })).toEqual({
      borderColor: 'var(--yellow)',
      background: 'color-mix(in srgb, var(--yellow) 22%, transparent)',
      color: 'color-mix(in srgb, var(--yellow) 55%, var(--text-primary))',
    });
    expect(chipStyle({ tone: 'progress', color: '#123456' }).borderColor).toBe('#123456');
    expect(chipStyle({ color: 'not-a-color' }).borderColor).toBe('var(--text-secondary)');
  });
});

describe('settings-aware cache', () => {
  it('refetches when the enricher settings fingerprint changes', async () => {
    settings = { fake: { enabled: true, palette: 'a' } };
    const enrich = fakeEnricher({ settingsKey: (s) => String(s.fake?.palette) });
    const first = render(<CardChips subject={mr('A-1')} />);
    await settle();
    first.unmount();
    settings = { fake: { enabled: true, palette: 'b' } };
    render(<CardChips subject={mr('A-1')} />);
    await settle();
    expect(enrich).toHaveBeenCalledTimes(2);
  });
});

import { useEnrichedKeys } from './cardEnrichers';

function Probe({ keys }: { keys: string[] }) {
  const r = useEnrichedKeys('fake', keys);
  return <span>{keys.map((k) => `${k}=${r[k] === null ? 'null' : r[k] ? 'data' : 'undef'}`).join(',')}</span>;
}

describe('useEnrichedKeys', () => {
  it('marks keys the enricher answered without as null', async () => {
    settings = { fake: { enabled: true } };
    fakeEnricher({ enrich: vi.fn(async () => ({ 'A-1': { chips: [{ label: 'A-1' }] } })) });
    const { container } = render(<Probe keys={['A-1', 'NOPE-9']} />);
    await settle();
    expect(container.textContent).toBe('A-1=data,NOPE-9=null');
  });

  it('keeps keys undefined (not unknown) when the request failed', async () => {
    settings = { fake: { enabled: true } };
    fakeEnricher({ enrich: vi.fn(async () => Promise.reject(new Error('down'))) });
    const { container } = render(<Probe keys={['A-1']} />);
    await settle();
    expect(container.textContent).toBe('A-1=undef');
  });
});
