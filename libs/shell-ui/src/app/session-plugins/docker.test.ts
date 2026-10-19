import { describe, expect, it } from 'vitest';
import { parseDockerSize, parseDockerStats } from './docker';

describe('parseDockerSize', () => {
  it('parses plain and unit-suffixed sizes', () => {
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerSize('512B')).toBe(512);
    expect(parseDockerSize('12kB')).toBe(12_000);
    expect(parseDockerSize('1.5MB')).toBe(1_500_000);
    expect(parseDockerSize('2.34GB')).toBe(2_340_000_000);
    expect(parseDockerSize('1TB')).toBe(1_000_000_000_000);
  });

  it('accepts whitespace and KiB-style units', () => {
    expect(parseDockerSize(' 10 MiB ')).toBe(10 * 1024 * 1024);
    expect(parseDockerSize('100')).toBe(100);
  });

  it('rejects garbage', () => {
    expect(parseDockerSize('abc')).toBeNull();
    expect(parseDockerSize('')).toBeNull();
    expect(parseDockerSize('1.2.3GB')).toBeNull();
  });
});

const SAMPLE = `==states==
running
running
exited
==sizes==
1.2GB
45MB
0B
300MB
==disk==
/dev/disk3s5 489264072 123456789 360000000 26% 1234 5678 0% /`;

describe('parseDockerStats', () => {
  it('counts running vs stopped containers', () => {
    const stats = parseDockerStats(SAMPLE);
    expect(stats?.running).toBe(2);
    expect(stats?.stopped).toBe(1);
  });

  it('sums the docker system df sizes', () => {
    expect(parseDockerStats(SAMPLE)?.usedBytes).toBe(1_200_000_000 + 45_000_000 + 300_000_000);
  });

  it('reads free space from the df line (1K blocks)', () => {
    expect(parseDockerStats(SAMPLE)?.freeBytes).toBe(360_000_000 * 1024);
  });

  it('handles an empty container list', () => {
    const stats = parseDockerStats(`==states==
==sizes==
0B
0B
0B
0B
==disk==
overlay 1000000 1000 999000 1% /var/lib/docker`);
    expect(stats?.running).toBe(0);
    expect(stats?.stopped).toBe(0);
    expect(stats?.usedBytes).toBe(0);
    expect(stats?.freeBytes).toBe(999_000 * 1024);
  });

  it('reports null freeBytes when the df line is missing or unparsable', () => {
    const stats = parseDockerStats(`==states==
running
==sizes==
1GB
==disk==
`);
    expect(stats?.freeBytes).toBeNull();
  });

  it('returns null when the markers are absent', () => {
    expect(parseDockerStats('some unrelated output')).toBeNull();
  });
});
