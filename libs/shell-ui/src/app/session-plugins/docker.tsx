import { useEffect, useRef, useState } from 'react';
import type { SessionViewPlugin } from './plugin';
import type { SessionAttention, ShellSession } from '../../types';
import { ptyIdOf } from '../../types';
import { useSessionBackend } from '../../services';
import { pressureColor, pressureLevel } from './ram';
import { PluginIcon } from '../SessionPanel';
import { RailItem } from '../RailItem';
import { publishPanelStatus, type StatusGroup } from '../panelStatus';
import { DockerView } from './dockerView';




/** Container counts and CPU/memory usage — refreshed every poll. */
export interface DockerLiveStats {
  /** Containers in state `running`. */
  running: number;
  /** Containers in any other state (exited, created, paused, dead, …). */
  stopped: number;
  /**
   * Sum of container CPU percentages from `docker stats` (100% ≈ one core).
   * `null` when the stats probe failed. Excludes VM/daemon overhead —
   * kept for the tooltip and as fallback when the VM exec is unavailable.
   */
  cpuPercent: number | null;
  /** Sum of container working-set memory; `null` when the stats probe failed. */
  memUsedBytes: number | null;
  /**
   * VM logical CPUs — read from `/proc/cpuinfo` inside a container (`==vm==`
   * exec), with `docker info`/`podman info` as fallback.
   */
  cpuCount: number | null;
  /** VM total memory bytes — meminfo via the exec, `info` as fallback. */
  memTotalBytes: number | null;
  /**
   * True when the `==vm==` numbers describe a real VM — colima/Lima, Docker
   * Desktop, Rancher, podman machine — detected from `docker info`
   * Name/OperatingSystem. False on native Linux, where they are host numbers.
   */
  vmBacked: boolean;
  /**
   * VM `MemAvailable` bytes — the real VM headroom on colima/Desktop/podman-
   * machine (proc is not cgroup-namespaced), the host's on native Linux.
   * `null` when the exec probe failed (no running container, distroless, …).
   */
  memAvailBytes: number | null;
  /**
   * VM cumulative CPU jiffies (`idle+iowait`, `total`) from `/proc/stat` —
   * the poller diffs successive samples into `vmCpuPct`.
   */
  cpuStat: { idle: number; total: number } | null;
  /** VM CPU% over the last poll interval — filled by the poller, not the parser. */
  vmCpuPct: number | null;
}

/** Docker disk usage — refreshed only every `DISK_POLL_EVERY` polls. */
export interface DockerDiskStats {
  /** Bytes held by docker objects — the `docker system df` size total. */
  usedBytes: number;
  /**
   * Free bytes on docker's backing filesystem (`df` of `DockerRootDir`,
   * falling back to `/` — e.g. on macOS where the root dir lives inside the
   * docker VM). `null` when the df line could not be parsed.
   */
  freeBytes: number | null;
}

/**
 * The fast per-poll `sh -c` probe producing the sections `parseDockerLive`
 * consumes. When the docker CLI is absent or the daemon unreachable it
 * prints an `==unavailable==` section (`no-cli` / `daemon-down`) and exits
 * zero — the rail parses that into a "daemon down" indicator instead of
 * silently hiding; a non-zero exit (→ exec rejects) now only means the
 * probe could not run at all. `docker stats` only lists running
 * containers — an empty ==stats== section means zero usage; a failed call
 * prints `unavailable` so the parser falls back gracefully. `==vm==` execs
 * a read-only /proc snapshot inside the first running container: proc is
 * not cgroup-namespaced, so cpuinfo/meminfo/stat report the real VM numbers
 * on colima/Desktop/podman-machine (host numbers on native Linux). Works on
 * docker and podman CLIs alike; `unavailable` when nothing runs or the
 * container is too minimal — the parser then falls back to container sums
 * and the `==limits==` info JSON (docker `NCPU`/`MemTotal`, podman
 * `host.cpus`/`host.memTotal`).
 */
const DOCKER_STATS_CMD = `
if ! command -v docker >/dev/null 2>&1; then
  echo '==unavailable=='
  echo 'no-cli'
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo '==unavailable=='
  echo 'daemon-down'
  exit 0
fi
echo '==states=='
docker ps -a --format '{{.State}}' 2>/dev/null
echo '==limits=='
docker info --format '{{json .}}' 2>/dev/null
echo '==stats=='
docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' 2>/dev/null || echo unavailable
echo '==vm=='
cid="$(docker ps -q | head -n 1)"
if [ -n "$cid" ]; then
  docker exec "$cid" sh -c "grep -c '^processor' /proc/cpuinfo; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; head -n 1 /proc/stat" 2>/dev/null || echo unavailable
else
  echo unavailable
fi
`.trim();

/**
 * The slow disk probe run only every `DISK_POLL_EVERY` polls — `docker
 * system df` walks every image/container layer and can take several
 * seconds, and disk usage barely moves within a minute. Exits non-zero
 * (→ exec rejects → last disk values kept) when docker is unreachable.
 */
const DOCKER_DISK_CMD = `
command -v docker >/dev/null 2>&1 || exit 1
docker info >/dev/null 2>&1 || exit 1
echo '==sizes=='
docker system df --format '{{.Size}}' 2>/dev/null
echo '==disk=='
cid="$(docker ps -q | head -n 1)"
if [ -n "$cid" ] && out="$(docker exec "$cid" df -k / 2>/dev/null)" && [ -n "$out" ]; then
  # df inside a container reports the VM's root filesystem — the real docker
  # disk on colima/Desktop/podman-machine, not the macOS host's.
  echo "$out" | tail -n 1
else
  root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || docker info --format '{{.Store.GraphRoot}}' 2>/dev/null)"
  { df -k "$root" 2>/dev/null || df -k / 2>/dev/null; } | tail -n 1
fi
`.trim();

/** Slow disk probe runs once per this many fast polls (~1 min at 15 s). */
const DISK_POLL_EVERY = 4;

/** Docker's humanized sizes (`12.3GB`, `456kB`, `0B`) → bytes. */
export function parseDockerSize(text: string): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([a-z]{0,3})\s*$/i.exec(text);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const mult: Record<string, number> = {
    '': 1,
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    pb: 1e15,
    eb: 1e18,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    pib: 1024 ** 5,
    eib: 1024 ** 6,
  };
  const k = mult[m[2].toLowerCase()];
  return k === undefined ? null : Math.round(value * k);
}

function sectionLines(output: string, name: string): string[] {
  const lines: string[] = [];
  let inside = false;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    const marker = /^==(.+)==$/.exec(line);
    if (marker) {
      inside = marker[1] === name;
      continue;
    }
    if (inside && line) lines.push(line);
  }
  return lines;
}

/** Parse the `DOCKER_STATS_CMD` output; `null` when the markers are absent. */
export function parseDockerLive(output: string): DockerLiveStats | null {
  if (!/^==states==$/m.test(output)) return null;
  const states = sectionLines(output, 'states');
  const running = states.filter((s) => s === 'running').length;

  // ==limits== — `docker info --format '{{json .}}'`; docker keeps the host
  // numbers top-level, podman nests them under `host`.
  let infoCpu = NaN;
  let infoMem = NaN;
  let vmBacked = false;
  try {
    const info = JSON.parse(sectionLines(output, 'limits')[0] ?? 'null');
    if (info && typeof info === 'object') {
      infoCpu = Number(info.NCPU ?? info.host?.cpus ?? info.Host?.Cpus);
      infoMem = Number(info.MemTotal ?? info.host?.memTotal ?? info.Host?.MemTotal);
      vmBacked = /docker.?desktop|colima|lima|rancher|podman.?machine|minikube|\bcrc\b/i.test(
        `${info.OperatingSystem ?? ''} ${info.Name ?? ''}`,
      );
    }
  } catch {
    // Unparsable info JSON — limits fall back to the ==vm== values only.
  }

  // ==stats== — per-container `docker stats` sums.
  const statsLines = sectionLines(output, 'stats');
  const statsFailed = statsLines.includes('unavailable');
  let cpuPercent = 0;
  let memUsedBytes = 0;
  for (const line of statsLines) {
    const [cpuField, memField] = line.split('|');
    const cpu = parseFloat(cpuField ?? '');
    if (!Number.isNaN(cpu)) cpuPercent += cpu;
    memUsedBytes += parseDockerSize((memField ?? '').split('/')[0] ?? '') ?? 0;
  }

  // ==vm== — cpuinfo count, meminfo lines, /proc/stat aggregate cpu line;
  // all reported for the VM kernel, not the container.
  const vmRaw = sectionLines(output, 'vm');
  const vmFailed = vmRaw.includes('unavailable');
  let vmCpuCount = NaN;
  let memTotalKb = NaN;
  let memAvailKb = NaN;
  let cpuStat: DockerLiveStats['cpuStat'] = null;
  for (const line of vmRaw) {
    let m = /^(\d+)$/.exec(line);
    if (m) vmCpuCount = parseInt(m[1], 10);
    m = /^MemTotal:\s+(\d+)\s+kB/.exec(line);
    if (m) memTotalKb = parseInt(m[1], 10);
    m = /^MemAvailable:\s+(\d+)\s+kB/.exec(line);
    if (m) memAvailKb = parseInt(m[1], 10);
    m = /^cpu\s+(.*)/.exec(line);
    if (m) {
      const f = m[1].trim().split(/\s+/).map(Number);
      if (f.length >= 5 && f.every((n) => Number.isFinite(n))) {
        cpuStat = { idle: f[3] + f[4], total: f.reduce((a, b) => a + b, 0) };
      }
    }
  }
  const cpuCount =
    Number.isFinite(vmCpuCount) && vmCpuCount > 0
      ? vmCpuCount
      : Number.isFinite(infoCpu) && infoCpu > 0
        ? infoCpu
        : null;
  const memTotalBytes =
    Number.isFinite(memTotalKb) && memTotalKb > 0
      ? memTotalKb * 1024
      : Number.isFinite(infoMem) && infoMem > 0
        ? infoMem
        : null;
  return {
    running,
    stopped: states.length - running,
    cpuPercent: statsFailed ? null : cpuPercent,
    memUsedBytes: statsFailed ? null : memUsedBytes,
    cpuCount,
    memTotalBytes,
    memAvailBytes: !vmFailed && memAvailKb >= 0 ? memAvailKb * 1024 : null,
    cpuStat,
    vmCpuPct: null,
    vmBacked,
  };
}

/**
 * Why docker can't be managed on the probed host:
 * - `ok` — daemon answered, stats are live
 * - `daemon-down` — CLI present, daemon unreachable (colima/Desktop stopped)
 * - `no-cli` — no docker/podman CLI on the host at all
 * - `unknown` — output carried neither stats nor an `==unavailable==` marker
 *   (e.g. the probe never ran)
 */
export type DockerAvailability = 'ok' | 'daemon-down' | 'no-cli' | 'unknown';

/** Parse the probe's `==unavailable==`/`==states==` markers into an availability. */
export function parseDockerAvailability(output: string): DockerAvailability {
  const reason = sectionLines(output, 'unavailable')[0];
  if (reason === 'daemon-down' || reason === 'no-cli') return reason;
  return /^==states==$/m.test(output) ? 'ok' : 'unknown';
}

/** Parse the `DOCKER_DISK_CMD` output; `null` when the markers are absent. */
export function parseDockerDisk(output: string): DockerDiskStats | null {
  if (!/^==sizes==$/m.test(output)) return null;
  const usedBytes = sectionLines(output, 'sizes').reduce(
    (sum, line) => sum + (parseDockerSize(line) ?? 0),
    0,
  );
  const diskLines = sectionLines(output, 'disk');
  const diskFields = diskLines[diskLines.length - 1]?.split(/\s+/);
  const freeKb = diskFields && diskFields.length >= 4 ? parseInt(diskFields[3], 10) : NaN;
  return { usedBytes, freeBytes: Number.isNaN(freeKb) ? null : freeKb * 1024 };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** Attention flag for docker disk/memory pressure — same thresholds as RAM. */
function pressureAttention(kind: string, usedPct: number): SessionAttention | null {
  if (usedPct >= 90) {
    return { level: 'critical', message: `docker ${kind} ${usedPct}% used` };
  }
  if (usedPct >= 80) return { level: 'warning', message: `docker ${kind} ${usedPct}% used` };
  return null;
}

/** CPU tooltip: VM/host busy share when the VM probe works, else the containers' share. */
function cpuTipOf(live: DockerLiveStats, cpuPct: number | null): string {
  const containerCores = live.cpuPercent != null ? (live.cpuPercent / 100).toFixed(1) : null;
  return live.vmCpuPct != null
    ? `${live.vmBacked ? 'VM' : 'host'} cpu — ${live.vmCpuPct}% busy${
        containerCores != null ? ` · containers ${containerCores} cores` : ''
      }`
    : `container cpu — ${cpuPct}% of ${live.cpuCount} cores`;
}

/** Memory tooltip: real VM/host pressure when known, else the containers' working set. */
function memTipOf(live: DockerLiveStats, memPct: number | null, vmMemPct: number | null): string {
  return vmMemPct != null
    ? `${live.vmBacked ? 'VM' : 'host'} memory — ${formatBytes(live.memTotalBytes! - live.memAvailBytes!)} of ${formatBytes(
        live.memTotalBytes!,
      )} used (${vmMemPct}%)${
        live.memUsedBytes != null ? ` · containers ${formatBytes(live.memUsedBytes)}` : ''
      }`
    : `container memory — ${formatBytes(live.memUsedBytes!)} of ${formatBytes(
        live.memTotalBytes!,
      )} (${memPct}%)`;
}

/**
 * Docker's accordion in the session panel's status stack — what the rail
 * tooltip used to list: the containers (running, stopped) and CPU, memory
 * and disk of the docker VM (the host on native Linux) with absolute
 * numbers. `null` when nothing is known.
 */
export function dockerStatusGroup(
  live: DockerLiveStats | null,
  disk: DockerDiskStats | null,
  pct: { cpu: number | null; mem: number | null; vmMem: number | null; disk: number },
): StatusGroup | null {
  if (!live) return null;
  // Summary labels stay short: the accordion is named Docker, so "CPU" and
  // "Mem" need no "VM" in front, and three pairs fit beside the name.
  const meters: StatusGroup['meters'] = [
    {
      label: 'Containers',
      summaryLabel: 'Running',
      value: String(live.running),
      detail: `${live.running} running · ${live.stopped} stopped`,
    },
  ];
  if (pct.cpu != null) {
    const containerCores = live.cpuPercent != null ? (live.cpuPercent / 100).toFixed(1) : null;
    meters.push({
      label: 'CPU',
      value: `${pct.cpu}%`,
      detail:
        live.cpuCount != null
          ? containerCores != null
            ? `containers ${containerCores} of ${live.cpuCount} cores`
            : `${live.cpuCount} cores`
          : undefined,
      pct: pct.cpu,
      color: pressureColor(pct.cpu, 0),
      level: pressureLevel(pct.cpu, 0),
      tip: cpuTipOf(live, pct.cpu),
    });
  }
  if (pct.mem != null && live.memTotalBytes != null) {
    const usedBytes =
      pct.vmMem != null && live.memAvailBytes != null
        ? live.memTotalBytes - live.memAvailBytes
        : live.memUsedBytes;
    meters.push({
      label: 'Memory',
      summaryLabel: 'Mem',
      value: `${pct.mem}%`,
      detail:
        usedBytes != null ? `${formatBytes(usedBytes)} of ${formatBytes(live.memTotalBytes)}` : undefined,
      pct: pct.mem,
      color: pressureColor(pct.mem, 0),
      level: pressureLevel(pct.mem, 0),
      tip: memTipOf(live, pct.mem, pct.vmMem),
    });
  }
  if (disk?.freeBytes != null) {
    meters.push({
      label: 'Disk',
      value: `${pct.disk}%`,
      detail: `${formatBytes(disk.usedBytes)} docker objects · ${formatBytes(disk.freeBytes)} free`,
      pct: pct.disk,
      color: pressureColor(pct.disk, 0),
      level: pressureLevel(pct.disk, 0),
      tip: `docker objects — ${formatBytes(disk.usedBytes)} of the backing filesystem (${pct.disk}%)`,
    });
  }
  return { title: 'Docker', meters };
}

function DockerRail({
  sessions,
  pluginSettings,
  setAppAttention,
  viewActive,
  toggleView,
}: {
  sessions: ShellSession[];
  pluginSettings: unknown;
  setAppAttention: (attention: SessionAttention | null) => void;
  viewActive: boolean;
  toggleView: () => void;
}) {
  const backend = useSessionBackend();
  const [live, setLive] = useState<DockerLiveStats | null>(null);
  const [disk, setDisk] = useState<DockerDiskStats | null>(null);
  const [avail, setAvail] = useState<DockerAvailability>('unknown');
  // Previous /proc/stat sample — VM CPU% is the delta between polls.
  const prevCpuStat = useRef<DockerLiveStats['cpuStat']>(null);
  const intervalSec =
    (pluginSettings as { refreshIntervalSeconds?: number } | undefined)
      ?.refreshIntervalSeconds ?? 15;
  const showMeters =
    (pluginSettings as { systemMeters?: boolean } | undefined)?.systemMeters !== false;
  // The rail is session-less: on desktop `plugin_exec` ignores the id and runs
  // on the host; over WS the probe runs in the first session's host. With no
  // sessions, desktop still works (empty id) while web execs reject → hidden.
  const target = sessions.length > 0 ? ptyIdOf(sessions[0]) : '';

  useEffect(() => {
    const exec = backend.exec?.bind(backend);
    if (!exec) return;
    let cancelled = false;
    // `docker stats` can take a couple of seconds — never stack overlapping
    // polls of the same probe.
    let liveInFlight = false;
    let diskInFlight = false;
    const pollLive = async () => {
      if (liveInFlight) return;
      liveInFlight = true;
      try {
        const out = await exec(target, DOCKER_STATS_CMD);
        if (!cancelled) {
          setAvail(parseDockerAvailability(out));
          const parsed = parseDockerLive(out);
          if (parsed?.cpuStat) {
            const prev = prevCpuStat.current;
            prevCpuStat.current = parsed.cpuStat;
            const dTotal = parsed.cpuStat.total - (prev?.total ?? 0);
            const dIdle = parsed.cpuStat.idle - (prev?.idle ?? 0);
            parsed.vmCpuPct =
              prev != null && dTotal > 0 && dIdle >= 0
                ? Math.min(100, Math.round((1 - dIdle / dTotal) * 100))
                : null;
          }
          setLive(parsed);
        }
      } catch {
        // The probe itself could not run (no session/backend) → hide.
        if (!cancelled) {
          setLive(null);
          setAvail('unknown');
        }
      } finally {
        liveInFlight = false;
      }
    };
    // `docker system df` walks every image/container layer (several seconds)
    // while disk usage barely moves — run it on a slower cadence and keep the
    // last good values on failure.
    const pollDisk = async () => {
      if (diskInFlight) return;
      diskInFlight = true;
      try {
        const out = await exec(target, DOCKER_DISK_CMD);
        const parsed = parseDockerDisk(out);
        if (!cancelled && parsed) setDisk(parsed);
      } catch {
        // Keep the last disk values on transient failures.
      } finally {
        diskInFlight = false;
      }
    };
    void pollLive();
    void pollDisk();
    const intervalMs = Math.max(5, intervalSec) * 1000;
    const liveId = setInterval(pollLive, intervalMs);
    const diskId = setInterval(pollDisk, intervalMs * DISK_POLL_EVERY);
    return () => {
      cancelled = true;
      clearInterval(liveId);
      clearInterval(diskId);
    };
  }, [backend, target, intervalSec]);

  const totalBytes =
    disk?.freeBytes != null ? disk.usedBytes + disk.freeBytes : 0;
  const usedPct =
    totalBytes > 0 ? Math.min(100, Math.round(((disk?.usedBytes ?? 0) / totalBytes) * 100)) : 0;
  // Container CPU% sums 100% per core — normalized against the VM's CPUs,
  // it is the fallback for the strip while the VM exec is unavailable or a
  // first CPU sample has no delta yet.
  const containerCpuPct =
    live?.cpuPercent != null && live.cpuCount != null
      ? Math.min(100, Math.round((live.cpuPercent / (live.cpuCount * 100)) * 100))
      : null;
  const containerMemPct =
    live?.memUsedBytes != null && live.memTotalBytes != null
      ? Math.min(100, Math.round((live.memUsedBytes / live.memTotalBytes) * 100))
      : null;
  // Real VM pressure when the ==vm== exec works — includes daemon/kernel/
  // cache overhead the container sums miss.
  const vmMemPct =
    live?.memAvailBytes != null && live.memTotalBytes != null
      ? Math.min(
          100,
          Math.round(((live.memTotalBytes - live.memAvailBytes) / live.memTotalBytes) * 100),
        )
      : null;
  const cpuPct = live?.vmCpuPct ?? containerCpuPct;
  const memPct = vmMemPct ?? containerMemPct;

  useEffect(() => {
    const flags = [
      disk && disk.freeBytes != null ? pressureAttention('disk', usedPct) : null,
      memPct != null ? pressureAttention('memory', memPct) : null,
    ].filter((a): a is SessionAttention => a != null);
    setAppAttention(flags.find((a) => a.level === 'critical') ?? flags[0] ?? null);
  }, [setAppAttention, disk, usedPct, memPct]);

  // Container counts and CPU / memory / disk live in docker's accordion at
  // the bottom of the session panel, not in the rail or its tooltip: they
  // are numbers to read, not something to click. The VM's numbers belong to
  // docker, not to "System" (that is the host).
  const statusGroup: StatusGroup | null = !showMeters
    ? null
    : live
      ? dockerStatusGroup(live, disk, { cpu: cpuPct, mem: memPct, vmMem: vmMemPct, disk: usedPct })
      : avail === 'daemon-down'
        ? {
            title: 'Docker',
            meters: [
              {
                label: 'Daemon',
                value: 'not running',
                detail: 'start colima or Docker Desktop',
                level: 1,
              },
            ],
          }
        : null;
  const statusJson = JSON.stringify(statusGroup);
  useEffect(() => {
    publishPanelStatus(dockerPlugin.id, statusGroup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusJson]);
  useEffect(() => () => publishPanelStatus(dockerPlugin.id, null), []);

  if (!live) {
    // CLI present but the daemon is unreachable — say so instead of
    // vanishing, so a stopped colima/Desktop doesn't look like "no docker".
    if (avail !== 'daemon-down') return null;
    return (
      <RailItem
        title="Docker"
        status="daemon not running"
        onClick={toggleView}
        active={viewActive}
        muted
        pip="warning"
      >
        <PluginIcon plugin={dockerPlugin} />
      </RailItem>
    );
  }
  return (
    // Running containers as the badge; everything else is in docker's accordion.
    <RailItem
      title="Docker"
      onClick={toggleView}
      active={viewActive}
      badge={live.running > 0 ? live.running : undefined}
      badgeTone="success"
    >
      <PluginIcon plugin={dockerPlugin} />
    </RailItem>
  );
}

export const dockerPlugin: SessionViewPlugin = {
  id: 'docker',
  title: 'Docker',
  logo: 'Container',
  version: '0.1.0',
  settings: [
    {
      key: 'refreshIntervalSeconds',
      label: 'Refresh interval (seconds)',
      description: 'How often container and disk stats are polled.',
      type: 'number',
      default: 15,
    },
    {
      key: 'systemMeters',
      label: 'Show in the session panel',
      description:
        'Containers and CPU, memory and disk of the docker VM as a Docker section at the bottom of the session panel.',
      type: 'boolean',
      default: true,
    },
  ],
  renderRail: ({ sessions, pluginSettings, setAppAttention, viewActive, toggleView }) => (
    <DockerRail
      sessions={sessions}
      pluginSettings={pluginSettings}
      setAppAttention={setAppAttention}
      viewActive={viewActive}
      toggleView={toggleView}
    />
  ),
  renderView: ({ close, sessions, pluginSettings, selectSession, sessionApi, appState, updateAppState }) => (
    <DockerView
      close={close}
      sessions={sessions}
      pluginSettings={pluginSettings}
      selectSession={selectSession}
      sessionApi={sessionApi}
      appState={appState}
      updateAppState={updateAppState}
    />
  ),
};
