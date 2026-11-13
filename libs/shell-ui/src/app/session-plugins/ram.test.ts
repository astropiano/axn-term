import { describe, expect, it } from 'vitest';
import { pressureColor, pressureLevel, ramStatusGroup } from './ram';

const MB = 1024;
const GB = 1024 * MB;

describe('pressureColor', () => {
  it('is green below the warning threshold with no swap', () => {
    expect(pressureColor(50, 0)).toBe('var(--green)');
    expect(pressureColor(64, 0)).toBe('var(--green)');
  });

  it('turns yellow once memory is getting tight', () => {
    expect(pressureColor(65, 0)).toBe('var(--yellow)');
    expect(pressureColor(79, 0)).toBe('var(--yellow)');
  });

  it('turns yellow on moderate swap usage even with low RAM usage', () => {
    expect(pressureColor(40, 600 * MB)).toBe('var(--yellow)');
  });

  it('turns orange near the limit', () => {
    expect(pressureColor(80, 0)).toBe('var(--orange)');
    expect(pressureColor(89, 0)).toBe('var(--orange)');
  });

  it('turns red at critical usage or heavy swap', () => {
    expect(pressureColor(90, 0)).toBe('var(--red)');
    expect(pressureColor(95, 0)).toBe('var(--red)');
    expect(pressureColor(40, 3 * GB)).toBe('var(--red)');
  });
});

describe('ramStatusGroup (session panel System accordion)', () => {
  const GB = 1024 * 1024; // KiB
  const stats = (over: Partial<Parameters<typeof ramStatusGroup>[0] & object> = {}) => ({
    totalKb: 32 * GB,
    availableKb: 14.4 * GB, // 55% used
    swapTotalKb: 4 * GB,
    swapFreeKb: 2.8 * GB, // 1.2 GB used
    appRssKb: 1.5 * GB,
    ...over,
  });

  it('is empty without stats', () => {
    expect(ramStatusGroup(null)).toBeNull();
    expect(ramStatusGroup(stats({ totalKb: 0 }))).toBeNull();
  });

  it('reports RAM as a percentage with absolute numbers', () => {
    const group = ramStatusGroup(stats())!;
    expect(group.title).toBe('Memory');
    expect(group.system).toBe(true); // machine-level: the "System" accordion
    const ram = group.meters[0];
    expect(ram).toMatchObject({ label: 'RAM', value: '55%', pct: 55, level: 0, color: 'var(--green)' });
    expect(ram.detail).toBe('17.6 GB of 32.0 GB · axn-term 1.5 GB');
  });

  it('reports swap in use next to it, judged on its own thresholds', () => {
    const swap = ramStatusGroup(stats())!.meters[1];
    expect(swap).toMatchObject({ label: 'Swap', value: '1.2 GB', pct: 30, level: 1, color: 'var(--yellow)' });
    expect(swap.detail).toBe('1.2 GB of 4.0 GB');
    expect(ramStatusGroup(stats({ swapFreeKb: 1 * GB }))!.meters[1].level).toBe(3);
  });

  it('leaves swap out on machines without any', () => {
    expect(ramStatusGroup(stats({ swapTotalKb: 0, swapFreeKb: 0 }))!.meters).toHaveLength(1);
  });

  it('keeps the pressure colours of the old rail gauge', () => {
    expect(ramStatusGroup(stats({ availableKb: 4.8 * GB }))!.meters[0]).toMatchObject({ value: '85%', level: 2, color: 'var(--orange)' });
    expect(ramStatusGroup(stats({ availableKb: 1.6 * GB }))!.meters[0]).toMatchObject({ value: '95%', level: 3, color: 'var(--red)' });
    for (const [pct, swapKb] of [[10, 0], [70, 0], [85, 0], [95, 0], [10, 3 * GB]] as const) {
      expect(pressureColor(pct, swapKb)).toBe(
        ['var(--green)', 'var(--yellow)', 'var(--orange)', 'var(--red)'][pressureLevel(pct, swapKb)],
      );
    }
  });
});
