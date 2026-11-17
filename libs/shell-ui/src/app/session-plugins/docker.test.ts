import { describe, expect, it } from 'vitest';
import {
  dockerStatusGroup,
  parseDockerAvailability,
  parseDockerDisk,
  parseDockerLive,
  parseDockerSize,
  type DockerLiveStats,
} from './docker';
import { containerMatches, parsePs } from './dockerView';

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
==limits==
{"NCPU":4,"MemTotal":8323334144}
==stats==
120.50%|1.5GiB / 7.75GiB
0.25%|45MiB / 7.75GiB
==vm==
6
MemTotal:       16734032 kB
MemAvailable:    4900000 kB
cpu  120000 300 480000 9200000 40000 0 12000 0 0 0`;

const DISK_SAMPLE = `==sizes==
1.2GB
45MB
0B
300MB
==disk==
/dev/disk3s5 489264072 123456789 360000000 26% 1234 5678 0% /`;

describe('parseDockerLive', () => {
  it('counts running vs stopped containers', () => {
    const stats = parseDockerLive(SAMPLE);
    expect(stats?.running).toBe(2);
    expect(stats?.stopped).toBe(1);
  });

  it('prefers VM exec values for cpu count and memory totals', () => {
    const stats = parseDockerLive(SAMPLE);
    expect(stats?.cpuCount).toBe(6);
    expect(stats?.memTotalBytes).toBe(16_734_032 * 1024);
    expect(stats?.memAvailBytes).toBe(4_900_000 * 1024);
  });

  it('parses the /proc/stat cpu line into jiffies', () => {
    const stat = parseDockerLive(SAMPLE)?.cpuStat;
    // idle + iowait and the field sum
    expect(stat?.idle).toBe(9_200_000 + 40_000);
    expect(stat?.total).toBe(9_852_300);
  });

  it('reads cpu/memory limits from podman-style info JSON', () => {
    const stats = parseDockerLive(`==states==
running
==limits==
{"host":{"cpus":4,"memTotal":8323334144}}
==stats==
==vm==
unavailable`);
    expect(stats?.cpuCount).toBe(4);
    expect(stats?.memTotalBytes).toBe(8_323_334_144);
    expect(stats?.memAvailBytes).toBeNull();
    expect(stats?.cpuStat).toBeNull();
  });

  it('sums container cpu percent and memory usage', () => {
    const stats = parseDockerLive(SAMPLE);
    expect(stats?.cpuPercent).toBeCloseTo(120.75);
    expect(stats?.memUsedBytes).toBe(1.5 * 1024 ** 3 + 45 * 1024 ** 2);
  });

  it('reports null cpu/mem when the stats probe failed', () => {
    const stats = parseDockerLive(`==states==
running
==limits==
{"NCPU":4,"MemTotal":8323334144}
==stats==
unavailable
==vm==
unavailable`);
    expect(stats?.cpuPercent).toBeNull();
    expect(stats?.memUsedBytes).toBeNull();
    expect(stats?.cpuCount).toBe(4);
    expect(stats?.memTotalBytes).toBe(8_323_334_144);
    expect(stats?.memAvailBytes).toBeNull();
  });

  it('treats an empty stats section as zero usage', () => {
    const stats = parseDockerLive(`==states==
==limits==
{"NCPU":2,"MemTotal":4000000000}
==stats==
==vm==
unavailable`);
    expect(stats?.running).toBe(0);
    expect(stats?.stopped).toBe(0);
    expect(stats?.cpuPercent).toBe(0);
    expect(stats?.memUsedBytes).toBe(0);
    expect(stats?.cpuCount).toBe(2);
    expect(stats?.memTotalBytes).toBe(4_000_000_000);
  });

  it('returns null when the markers are absent', () => {
    expect(parseDockerLive('some unrelated output')).toBeNull();
  });
});

describe('parseDockerAvailability', () => {
  it('reports ok when the stats sections are present', () => {
    expect(parseDockerAvailability(SAMPLE)).toBe('ok');
  });

  it('reads the daemon-down and no-cli markers', () => {
    expect(parseDockerAvailability('==unavailable==\ndaemon-down')).toBe('daemon-down');
    expect(parseDockerAvailability('==unavailable==\nno-cli')).toBe('no-cli');
  });

  it('reports unknown for unrelated output', () => {
    expect(parseDockerAvailability('some unrelated output')).toBe('unknown');
    expect(parseDockerAvailability('')).toBe('unknown');
  });
});

const PS_SAMPLE = `${JSON.stringify({
  ID: 'abc123',
  Names: 'proj-web-1',
  Image: 'node:22-alpine',
  State: 'running',
  Status: 'Up 2 hours',
  Ports: '0.0.0.0:8080->8080/tcp',
  Labels:
    'com.docker.compose.project=axn-term,com.docker.compose.service=web,com.docker.compose.version=2.30',
})}
${JSON.stringify({ ID: 'def456', Names: 'lonely', Image: 'redis:7-alpine', State: 'exited', Status: '', Ports: '', Labels: '' })}
==stats==
${JSON.stringify({ Name: 'proj-web-1', CPUPerc: '1.20%', MemUsage: '45MiB / 7GiB' })}`;

describe('parsePs', () => {
  it('reads the full compose project and service labels', () => {
    const [c] = parsePs(PS_SAMPLE);
    expect(c.project).toBe('axn-term');
    expect(c.service).toBe('web');
  });

  it('joins stats by container name and leaves unlabeled containers standalone', () => {
    const [web, lonely] = parsePs(PS_SAMPLE);
    expect(web.cpu).toBe('1.20%');
    expect(web.mem).toBe('45MiB');
    expect(lonely.project).toBeUndefined();
    expect(lonely.service).toBeUndefined();
    expect(lonely.cpu).toBeUndefined();
  });

  it('returns an empty list for the daemon-down probe output', () => {
    expect(parsePs('==unavailable==\ndaemon-down')).toEqual([]);
  });
});

describe('parseDockerDisk', () => {
  it('sums the docker system df sizes', () => {
    expect(parseDockerDisk(DISK_SAMPLE)?.usedBytes).toBe(
      1_200_000_000 + 45_000_000 + 300_000_000,
    );
  });

  it('reads free space from the df line (1K blocks)', () => {
    expect(parseDockerDisk(DISK_SAMPLE)?.freeBytes).toBe(360_000_000 * 1024);
  });

  it('handles an empty docker system df', () => {
    const stats = parseDockerDisk(`==sizes==
0B
0B
0B
0B
==disk==
overlay 1000000 1000 999000 1% /var/lib/docker`);
    expect(stats?.usedBytes).toBe(0);
    expect(stats?.freeBytes).toBe(999_000 * 1024);
  });

  it('reports null freeBytes when the df line is missing or unparsable', () => {
    const stats = parseDockerDisk(`==sizes==
1GB
==disk==
`);
    expect(stats?.freeBytes).toBeNull();
  });

  it('returns null when the markers are absent', () => {
    expect(parseDockerDisk('some unrelated output')).toBeNull();
  });
});

describe('containerMatches', () => {
  const [web, lonely] = parsePs(PS_SAMPLE);

  it('matches everything on an empty query', () => {
    expect(containerMatches(web, '')).toBe(true);
    expect(containerMatches(web, '   ')).toBe(true);
  });

  it('matches name, image, service and project substrings', () => {
    expect(containerMatches(web, 'proj-web')).toBe(true);
    expect(containerMatches(web, 'axn-term')).toBe(true);
    expect(containerMatches(web, 'WEB')).toBe(true);
    expect(containerMatches(lonely, 'redis')).toBe(true);
    expect(containerMatches(lonely, 'axn-term')).toBe(false);
  });
});

describe('dockerStatusGroup (session panel Docker accordion)', () => {
  const live = (over: Partial<DockerLiveStats> = {}): DockerLiveStats => ({
    running: 5,
    stopped: 2,
    cpuPercent: 120,
    memUsedBytes: 3e9,
    cpuCount: 8,
    memTotalBytes: 12e9,
    vmBacked: true,
    memAvailBytes: 6.84e9,
    cpuStat: null,
    vmCpuPct: 12,
    ...over,
  });
  const disk = { usedBytes: 40e9, freeBytes: 60e9 };
  const pct = { cpu: 12, mem: 43, vmMem: 43, disk: 40 };

  it('is empty until docker answered', () => {
    expect(dockerStatusGroup(null, null, { cpu: null, mem: null, vmMem: null, disk: 0 })).toBeNull();
  });

  it('lists the containers and CPU, memory and disk of the docker VM with absolute numbers', () => {
    const group = dockerStatusGroup(live(), disk, pct)!;
    expect(group.title).toBe('Docker');
    expect(group.meters.map((m) => [m.label, m.summaryLabel, m.value, m.pct])).toEqual([
      ['Containers', 'Running', '5', undefined],
      ['CPU', undefined, '12%', 12],
      ['Memory', 'Mem', '43%', 43],
      ['Disk', undefined, '40%', 40],
    ]);
    expect(group.meters[0].detail).toBe('5 running · 2 stopped');
    expect(group.meters[1].detail).toBe('containers 1.2 of 8 cores');
    expect(group.meters[2].detail).toBe('5.2 GB of 12.0 GB');
    expect(group.meters[3].detail).toBe('40.0 GB docker objects · 60.0 GB free');
  });

  it('names the host on native Linux and falls back to the containers working set', () => {
    const group = dockerStatusGroup(
      live({ vmBacked: false, memAvailBytes: null, vmCpuPct: null }),
      null,
      { cpu: 15, mem: 25, vmMem: null, disk: 0 },
    )!;
    expect(group.title).toBe('Docker');
    expect(group.meters.map((m) => m.summaryLabel)).toEqual(['Running', undefined, 'Mem']);
    expect(group.meters[2].detail).toBe('3.0 GB of 12.0 GB');
  });

  it('colours and levels follow the pressure thresholds', () => {
    const group = dockerStatusGroup(live(), disk, { cpu: 50, mem: 85, vmMem: 85, disk: 95 })!;
    expect(group.meters.slice(1).map((m) => m.level)).toEqual([0, 2, 3]);
    expect(group.meters.slice(1).map((m) => m.color)).toEqual(['var(--green)', 'var(--orange)', 'var(--red)']);
  });

  it('skips what is unknown', () => {
    const group = dockerStatusGroup(live(), { usedBytes: 1e9, freeBytes: null }, {
      cpu: null,
      mem: 43,
      vmMem: 43,
      disk: 0,
    })!;
    expect(group.meters.map((m) => m.label)).toEqual(['Containers', 'Memory']);
  });
});
