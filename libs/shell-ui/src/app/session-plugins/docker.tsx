import { useEffect, useRef, useState } from 'react';
import type { SessionViewPlugin } from './plugin';
import type { SessionAttention, ShellSession } from '../../types';
import { ptyIdOf } from '../../types';
import { useSessionBackend } from '../../services';
import { pressureColor } from './ram';
import { PluginIcon } from '../SessionPanel';
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
 * consumes. Exits non-zero (→ exec rejects → rail hides) when docker is
 * absent or the daemon unreachable. `docker stats` only lists running
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
command -v docker >/dev/null 2>&1 || exit 1
docker info >/dev/null 2>&1 || exit 1
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

/**
 * One strip of the rail's triple gauge. The percentage is written into the
 * bar itself: the label renders once in track color across the strip and
 * again in inverted color clipped to the fill's width, so glyphs flip color
 * where the fill passes under them.
 */
function BarStrip({ pct, color, tip }: { pct: number; color: string; tip: string }) {
  const text =
    'pointer-events-none absolute inset-y-0 left-0 flex w-7 items-center justify-center text-[8px] font-bold leading-none';
  return (
    <div className="relative h-3 w-7 bg-[var(--surface)]" data-tip={tip}>
      <div
        className="absolute inset-y-0 left-0 transition-all duration-500"
        style={{ width: `${pct}%`, background: color }}
      />
      <span className={`${text} text-[var(--text-secondary)]`}>{pct}%</span>
      <div
        className="absolute inset-y-0 left-0 overflow-hidden transition-all duration-500"
        style={{ width: `${pct}%` }}
      >
        <span className={`${text} text-[var(--text-inverted)]`}>{pct}%</span>
      </div>
    </div>
  );
}

function DockerRail({
  sessions,
  pluginSettings,
  setAppAttention,
}: {
  sessions: ShellSession[];
  pluginSettings: unknown;
  setAppAttention: (attention: SessionAttention | null) => void;
}) {
  const backend = useSessionBackend();
  const [live, setLive] = useState<DockerLiveStats | null>(null);
  const [disk, setDisk] = useState<DockerDiskStats | null>(null);
  // Previous /proc/stat sample — VM CPU% is the delta between polls.
  const prevCpuStat = useRef<DockerLiveStats['cpuStat']>(null);
  const intervalSec =
    (pluginSettings as { refreshIntervalSeconds?: number } | undefined)
      ?.refreshIntervalSeconds ?? 15;
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
        // Docker absent/daemon down or no connected session → hide.
        if (!cancelled) setLive(null);
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

  if (!live) return null;
  const containerCores = live.cpuPercent != null ? (live.cpuPercent / 100).toFixed(1) : null;
  const cpuTip =
    live.vmCpuPct != null
      ? `${live.vmBacked ? 'VM' : 'host'} cpu — ${live.vmCpuPct}% busy${
          containerCores != null ? ` · containers ${containerCores} cores` : ''
        }`
      : `container cpu — ${cpuPct}% of ${live.cpuCount} cores`;
  const memTip =
    vmMemPct != null
      ? `${live.vmBacked ? 'VM' : 'host'} memory — ${formatBytes(live.memTotalBytes! - live.memAvailBytes!)} of ${formatBytes(
          live.memTotalBytes!,
        )} used (${vmMemPct}%)${
          live.memUsedBytes != null ? ` · containers ${formatBytes(live.memUsedBytes)}` : ''
        }`
      : `container memory — ${formatBytes(live.memUsedBytes!)} of ${formatBytes(
          live.memTotalBytes!,
        )} (${memPct}%)`;
  const title = [
    `docker — ${live.running} running, ${live.stopped} stopped`,
    cpuPct != null ? cpuTip : null,
    memPct != null ? memTip : null,
    disk
      ? disk.freeBytes != null
        ? `disk ${formatBytes(disk.usedBytes)} used · ${formatBytes(disk.freeBytes)} free`
        : `disk ${formatBytes(disk.usedBytes)} used`
      : null,
  ]
    .filter((l) => l != null)
    .join('\n');
  return (
    <div data-tip={title} className="flex flex-col items-center gap-0.5">
      <div className="flex items-center gap-0.5">
        <div className="flex flex-col items-center gap-0.5">
          <span
            className={`select-none text-[8px] font-bold leading-none ${
              live.running > 0 ? 'text-[var(--green)]' : 'text-[var(--text-secondary)]'
            }`}
            data-tip="running containers"
          >
            {live.running}
          </span>
          <span
            className="select-none text-[8px] font-bold leading-none text-[var(--text-secondary)]"
            data-tip="stopped containers"
          >
            {live.stopped}
          </span>
        </div>
        <PluginIcon
            plugin={dockerPlugin}
            className="h-3.5 w-3.5 text-[var(--text-secondary)]"
          />
      </div>
      {/* One rounded bar, three strips — CPU / MEM / disk top to bottom. */}
      {(cpuPct != null || memPct != null || disk?.freeBytes != null) && (
        <div className="mt-0.5 flex w-7 flex-col divide-y divide-[var(--border)] overflow-hidden rounded-sm border border-[var(--border)]">
          {cpuPct != null && (
            <BarStrip pct={cpuPct} color={pressureColor(cpuPct, 0)} tip={cpuTip} />
          )}
          {memPct != null && (
            <BarStrip pct={memPct} color={pressureColor(memPct, 0)} tip={memTip} />
          )}
          {disk?.freeBytes != null && (
            <BarStrip
              pct={usedPct}
              color={pressureColor(usedPct, 0)}
              tip={`docker objects — ${formatBytes(disk.usedBytes)} of the backing filesystem (${usedPct}%)`}
            />
          )}
        </div>
      )}
    </div>
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
  ],
  renderRail: ({ sessions, pluginSettings, setAppAttention, toggleView }) => (
    <div onClick={toggleView} className="cursor-pointer">
      <DockerRail
        sessions={sessions}
        pluginSettings={pluginSettings}
        setAppAttention={setAppAttention}
      />
    </div>
  ),
  renderView: ({ close, sessions, pluginSettings, selectSession, sessionApi }) => (
    <DockerView
      close={close}
      sessions={sessions}
      pluginSettings={pluginSettings}
      selectSession={selectSession}
      sessionApi={sessionApi}
    />
  ),
};
