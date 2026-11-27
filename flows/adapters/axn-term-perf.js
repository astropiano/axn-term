// axn-term perf adapter — measures startup, terminal throughput, Ctrl-C
// responsiveness, keystroke echo, memory and bundle sizes of a release
// binary, printing AXN_METRIC lines that `axn-dev flow` collects into the
// report. See flows/PERF.md.
//
// Binary: AXN_TERM_BINARY (default target/release/axn-term).
// Fewer runs: AXN_PERF_QUICK=1, or AXN_PERF_RUNS=<n> for every action.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  REPO, binaryPath, close, cpuByKind, dataDir, fileSize, idleCpu, launch, median, meta, metric,
  now, percentile, readTrace, rssMb, runCount, shellCpu, sleep, sumCpu, waitForOutput, waitIdle, write,
} from "../perf/lib.mjs";

const args = (step) => step.args ?? {};

// ---------- static: bundle and binary sizes ----------

async function staticSizes() {
  const bin = binaryPath();
  const binBytes = fileSize(bin);
  meta({ binary: bin, binarySha256: createHash("sha256").update(readFileSync(bin)).digest("hex").slice(0, 16) });
  metric("static.binary_mb", { value: binBytes / 1048576, unit: "MB", digits: 2, description: "release binary size" });

  // The binary embeds the frontend; apps/desktop/dist is the last build of it.
  const dist = join(REPO, "apps/desktop/dist");
  const html = join(dist, "index.html");
  if (!existsSync(html)) {
    console.log("apps/desktop/dist not built — skipping bundle sizes");
    return "static sizes measured (no dist)";
  }
  const index = readFileSync(html, "utf8");
  const entryJs = index.match(/<script[^>]+src="\/?([^"]+\.js)"/)?.[1];
  const entryCss = [...index.matchAll(/<link[^>]+href="\/?([^"]+\.css)"/g)].map((m) => m[1]);
  const preloads = [...index.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/?([^"]+)"/g)].map((m) => m[1]);
  const kb = (rel) => (fileSize(join(dist, rel)) ?? 0) / 1024;
  const assets = readdirSync(join(dist, "assets"));
  const jsTotal = assets.filter((f) => f.endsWith(".js")).reduce((a, f) => a + kb(join("assets", f)), 0);
  metric("static.entry_js_kb", { value: entryJs ? kb(entryJs) : null, unit: "KB", digits: 0, description: "JS parsed before first render" });
  metric("static.preload_js_kb", { value: preloads.reduce((a, p) => a + kb(p), 0), unit: "KB", digits: 0, description: "modulepreloaded chunks" });
  metric("static.entry_css_kb", { value: entryCss.reduce((a, c) => a + kb(c), 0), unit: "KB", digits: 0 });
  metric("static.js_total_kb", { value: jsTotal, unit: "KB", digits: 0, description: "all JS chunks incl. lazy ones and workers" });
  metric("static.js_chunks", { value: assets.filter((f) => f.endsWith(".js")).length, unit: "files", digits: 0 });
  return "static sizes measured";
}

// ---------- startup ----------

async function startup(step) {
  const a = args(step);
  const restore = Number(a.sessions ?? 0);
  const select = a.select ?? "first";
  const runs = runCount(step, restore ? 5 : 7);
  const key = a.name ?? (restore ? `restore${restore}_${select}` : "fresh");
  const rows = [];
  for (let i = 0; i < runs; i++) {
    const app = await launch({ restore, select });
    try {
      await sleep(2500);
      await waitIdle(app.pid, { win: 500, pct: 3, max: 15000 });
      const row = { ...app.marks, rss: rssMb(app.pid) };
      // Idle after the one-time Monaco warm-up (5 s after start).
      if (i < Number(a.idleRuns ?? 3)) {
        await sleep(Math.max(0, 9000 - (now() - app.t0)));
        row.idle = (await idleCpu(app.pid, 10000)).total;
      }
      rows.push(row);
      process.stderr.write(`  run ${i + 1}/${runs}: prompt ${Math.round(app.marks.prompt)} ms, rss ${Math.round(row.rss)} MB\n`);
    } finally {
      await close(app);
    }
    await sleep(500);
  }
  const col = (k) => rows.map((r) => r[k]);
  const p = `startup.${key}`;
  metric(`${p}.health_ms`, { samples: col("health"), unit: "ms", digits: 0, description: "Rust up: remote-control server answers" });
  metric(`${p}.window_ms`, { samples: col("window"), unit: "ms", digits: 0, description: "webview window created" });
  metric(`${p}.shell_ms`, { samples: col("shell"), unit: "ms", digits: 0, description: "selected session's PTY spawned" });
  metric(`${p}.prompt_ms`, { samples: col("prompt"), unit: "ms", digits: 0, description: "first prompt reached the app" });
  if (restore) metric(`${p}.all_shells_ms`, { samples: col("allShells"), unit: "ms", digits: 0, description: "every restored session spawned" });
  metric(`${p}.rss_mb`, { samples: col("rss"), unit: "MB", digits: 0, description: "app + WebKit resident memory after startup" });
  metric(`${p}.idle_cpu_pct`, { samples: col("idle").filter((x) => x != null), unit: "%", digits: 2, description: "CPU while idle, % of one core" });
  return `startup ${key} measured (${runs} runs)`;
}

// ---------- phases: where startup time goes (needs AXN_TERM_PERF_TRACE support) ----------

const PHASES = [
  // [metric, from, to, description]
  ["exec", "spawn", "run_start", "process exec + dynamic linking until run()"],
  ["rust_init", "run_start", "setup_begin", "Tauri builder, plugins"],
  ["window_create", "setup_begin", "windows_created", "webview windows built (WebKit processes)"],
  ["webview_load", "windows_created", "page_finished", "until the page has loaded"],
  ["js_eval", "page_finished", "main_eval", "entry bundle parse + evaluate"],
  ["app_mount", "main_eval", "app_mounted", "first React render of the app"],
  ["state_load", "app_mounted", "state_loaded", "window state loaded"],
  ["terminal_open", "state_loaded", "term_open_done", "render sessions, xterm open"],
  ["pty_spawn", "term_open_done", "pty_spawn", "fit, listeners, until the spawn request"],
  ["shell_start", "pty_spawn", "pty_first_output", "shell started and printed"],
  ["first_paint", "pty_first_output", "first_output_painted", "output delivered, parsed, painted"],
];

async function phases(step) {
  const runs = runCount(step, 7);
  const rows = [];
  for (let i = 0; i < runs; i++) {
    const app = await launch({ trace: true });
    let events;
    try {
      // Let the first output be painted, the renderer attach, and the
      // frontend report its loaded resources (3 s after start).
      await sleep(4000);
      events = readTrace(app);
    } finally {
      await close(app);
    }
    if (events.length === 0) {
      console.log("this binary has no AXN_TERM_PERF_TRACE support — phases skipped");
      return "phases unsupported";
    }
    const at = { spawn: app.spawnEpoch };
    const sessionMarks = new Set(["term_open_done", "pty_spawn", "pty_first_output", "first_output_painted", "renderer_attached"]);
    for (const e of events) {
      if (sessionMarks.has(e.name) && e.detail && e.detail !== app.sid) continue;
      if (at[e.name] === undefined) at[e.name] = e.epochMs;
    }
    const res = events.find((e) => e.name === "resources");
    if (res?.detail) {
      try {
        const r = JSON.parse(res.detail);
        at.resources = r.count;
        at.external = r.external.length;
        at.externalHosts = r.external;
      } catch { /* malformed */ }
    }
    rows.push(at);
    await sleep(500);
  }
  for (const [name, from, to, description] of PHASES) {
    metric(`phases.${name}_ms`, {
      samples: rows.map((r) => (r[from] != null && r[to] != null ? r[to] - r[from] : null)),
      unit: "ms", digits: 0, description,
    });
  }
  metric("phases.total_ms", { samples: rows.map((r) => (r.first_output_painted != null ? r.first_output_painted - r.spawn : null)), unit: "ms", digits: 0, description: "spawn → first output painted" });
  metric("phases.external_requests", { samples: rows.map((r) => r.external), unit: "hosts", digits: 0, description: "outside hosts contacted during startup (fonts, CDNs) — should be 0" });
  metric("phases.startup_resources", { samples: rows.map((r) => r.resources), unit: "files", digits: 0, description: "http(s) resources loaded in the first 3 s (the app's own tauri:// assets are not counted)" });
  const hosts = [...new Set(rows.flatMap((r) => r.externalHosts ?? []))];
  if (hosts.length) meta({ externalHosts: hosts });
  metric("phases.renderer_after_spawn_ms", { samples: rows.map((r) => (r.renderer_attached != null && r.pty_spawn != null ? r.renderer_attached - r.pty_spawn : null)), unit: "ms", digits: 0, description: "GPU renderer attached, relative to the PTY spawn" });
  return `startup phases measured (${runs} runs)`;
}

// ---------- throughput ----------

function ensureData() {
  const dir = dataDir();
  const plain = join(dir, "plain-32mb.txt");
  const ansi = join(dir, "ansi-16mb.txt");
  // Deterministic content (seeded LCG) so every run cats the same bytes.
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const words = "the quick brown fox jumps over lazy dog build compile link test pass fail warn info debug trace".split(" ");
  const pick = () => words[Math.floor(rand() * words.length)];
  if (!existsSync(plain)) {
    const parts = [];
    let n = 0;
    while (n < 32 * 1048576) {
      const l = `${String(n).padStart(10, "0")} ${Array.from({ length: 14 }, pick).join(" ")}\n`;
      parts.push(l);
      n += l.length;
    }
    writeFileSync(plain, parts.join(""));
  }
  if (!existsSync(ansi)) {
    const cols = [31, 32, 33, 34, 35, 36, 90, 1];
    const parts = [];
    let n = 0;
    while (n < 16 * 1048576) {
      const words10 = Array.from({ length: 10 }, () => `\x1b[${cols[Math.floor(rand() * cols.length)]}m${pick()}\x1b[0m`);
      const l = `\x1b[2m[${String(n).padStart(8, "0")}]\x1b[0m ${words10.join(" ")}\n`;
      parts.push(l);
      n += l.length;
    }
    writeFileSync(ansi, parts.join(""));
  }
  return { plain, ansi };
}

const WORKLOADS = {
  cat_plain_32mb: (d) => `cat ${d.plain}`,
  cat_ansi_16mb: (d) => `cat ${d.ansi}`,
  seq_2m_lines: () => "seq 1 2000000",
};

async function throughput(step) {
  const a = args(step);
  const names = (a.workloads ?? Object.keys(WORKLOADS).join(",")).split(",").map((s) => s.trim());
  const runs = runCount(step, 3);
  const data = ensureData();
  const app = await launch();
  let n = 0;
  try {
    await sleep(2000);
    await waitIdle(app.pid, { win: 500, pct: 3, max: 15000 });
    const rssBefore = rssMb(app.pid);
    for (const w of names) {
      if (!WORKLOADS[w]) throw new Error(`unknown workload '${w}' (have ${Object.keys(WORKLOADS).join(", ")})`);
      const rows = [];
      for (let i = 0; i < runs; i++) {
        const mark = `BENCHEND${++n}X`;
        const cpu0 = cpuByKind(app.pid);
        const t0 = now();
        // The marker only appears once the command has run — the typed
        // echo shows `BENCHEND <n>X` with a space.
        await write(app, `${WORKLOADS[w](data)}; printf '%s%s\\n' BENCHEND ${n}X\r`);
        const pty = await waitForOutput(app, mark);
        const idleAt = await waitIdle(app.pid, { win: 300, pct: 6, max: 180000 });
        const settled = now() - t0;
        const cpu1 = cpuByKind(app.pid);
        rows.push({
          pty,
          screen: idleAt == null ? null : Math.max(pty ?? 0, settled - 300),
          cpu: sumCpu(cpu1) - sumCpu(cpu0),
          web: cpu1.web - cpu0.web,
          main: cpu1.main - cpu0.main,
        });
        process.stderr.write(`  ${w} ${i + 1}/${runs}: pty ${Math.round(pty)} ms, screen ${Math.round(rows.at(-1).screen)} ms\n`);
        await write(app, "clear\r");
        await sleep(800);
      }
      const p = `throughput.${w}`;
      // Informational: flow control holds the shell back to what the screen
      // can show, so a lower value is not better on its own.
      metric(`${p}.pty_ms`, { samples: rows.map((r) => r.pty), unit: "ms", digits: 0, better: "none", description: "until the shell finished (output reached Rust; paced by flow control)" });
      metric(`${p}.screen_ms`, { samples: rows.map((r) => r.screen), unit: "ms", digits: 0, description: "until the app went idle — everything rendered" });
      metric(`${p}.cpu_s`, { samples: rows.map((r) => r.cpu), unit: "s", digits: 2, description: "CPU time, app + WebKit" });
      metric(`${p}.cpu_web_s`, { samples: rows.map((r) => r.web), unit: "s", digits: 2, description: "CPU time in the WebKit content process" });
      metric(`${p}.cpu_main_s`, { samples: rows.map((r) => r.main), unit: "s", digits: 2, description: "CPU time in the app process" });
    }
    await sleep(2000);
    metric("throughput.rss_growth_mb", { value: rssMb(app.pid) - rssBefore, unit: "MB", digits: 0, description: "resident memory added by the workloads" });
  } finally {
    await close(app);
  }
  return `throughput measured (${names.join(", ")})`;
}

// ---------- interrupt: Ctrl-C during an output flood ----------

async function interrupt(step) {
  const runs = runCount(step, 3);
  const floodMs = Number(args(step).floodMs ?? 1500);
  const app = await launch();
  const rows = [];
  try {
    await sleep(2000);
    for (let i = 0; i < runs; i++) {
      const mark = `INTDONE${i}X`;
      await write(app, "seq 1 1000000000\r");
      await sleep(floodMs);
      const t0 = now();
      await write(app, "\x03");
      await write(app, `printf '%s%s\\n' INTDONE ${i}X\r`);
      const prompt = await waitForOutput(app, mark, 120000);
      const idleAt = await waitIdle(app.pid, { win: 300, pct: 6, max: 120000 });
      rows.push({ prompt, screen: idleAt == null ? null : Math.max(prompt ?? 0, now() - t0 - 300) });
      process.stderr.write(`  ctrl-c ${i + 1}/${runs}: screen settled after ${Math.round(rows.at(-1).screen)} ms\n`);
      await write(app, "clear\r");
      await sleep(800);
    }
  } finally {
    await close(app);
  }
  metric("interrupt.prompt_ms", { samples: rows.map((r) => r.prompt), unit: "ms", digits: 0, description: "Ctrl-C → next command's output reached the app" });
  metric("interrupt.screen_ms", { samples: rows.map((r) => r.screen), unit: "ms", digits: 0, description: "Ctrl-C → app caught up and idle" });
  return `interrupt measured (${runs} runs)`;
}

// ---------- echo: keystroke round trip through the PTY ----------

async function echo(step) {
  const count = Number(args(step).keys ?? 100);
  const app = await launch();
  const lat = [];
  try {
    await sleep(1500);
    for (let i = 0; i < count; i++) {
      const ch = "abcdefghij"[i % 10];
      const before = (await app.output()).length;
      const t0 = now();
      await write(app, ch);
      while (now() - t0 < 2000) {
        const out = await app.output();
        if (out.length > before && out.endsWith(ch)) break;
      }
      lat.push(now() - t0);
      if (i % 20 === 19) await write(app, "\x15"); // Ctrl-U: clear the line
    }
  } finally {
    await close(app);
  }
  metric("echo.pty_roundtrip_ms", { value: median(lat), unit: "ms", digits: 1, description: "key written → echo back in Rust (median; no UI path)" });
  metric("echo.pty_roundtrip_p95_ms", { value: percentile(lat, 95), unit: "ms", digits: 1 });
  return `echo measured (${count} keys)`;
}

// ---------- output: correctness — output reaches the frontend ----------

async function output() {
  const app = await launch();
  try {
    await sleep(1500);
    const t0 = now();
    await write(app, `head -c ${3 * 1048576} /dev/zero | tr '\\0' 'a' | fold -w 100; printf '%s%s\\n' FRONT END-$(echo ok)\r`);
    // ShellApp saves the frontend's session output to state.json (2 s debounce).
    while (now() - t0 < 30000) {
      await sleep(250);
      const st = await (await app.rc("/state")).json();
      const out = st.windows?.[0]?.sessions?.find((s) => s.id === app.sid)?.output ?? "";
      if (out.includes("FRONTEND-ok")) {
        metric("output.frontend_saved_ms", { value: now() - t0, unit: "ms", digits: 0, description: "3 MB + marker visible in the frontend's saved session output (includes 2 s save debounce)" });
        return "frontend received the output";
      }
    }
  } finally {
    await close(app);
  }
  throw new Error("marker never reached the frontend's session output");
}

// ---------- switch: session-to-session remount cost ----------
//
// Only the selected session mounts a terminal view, so every switch
// serializes the old terminal's scrollback, disposes xterm + the renderer,
// mounts a fresh xterm for the new session and replays its stash. This
// measures select-command → remount done, cycling through all sessions
// (each restored with ~200 KB of scrollback, like `startup restore`).

async function sessionSwitch(step) {
  const a = args(step);
  const sessions = Number(a.sessions ?? 4);
  const runs = runCount(step, 8);
  const app = await launch({ restore: sessions, select: "first", trace: true });
  try {
    await waitIdle(app.pid, { win: 400, pct: 3, max: 20000 });
    const ids = await (await app.rc("/sessions")).json();
    if (ids.length < 2) throw new Error(`switch needs ≥2 sessions, got ${ids.length}`);
    const openSamples = [];
    const rendererSamples = [];
    const rssSamples = [];
    let current = app.sid;
    for (let i = 0; i < runs; i++) {
      const next = ids[(ids.indexOf(current) + 1) % ids.length];
      const t0 = Date.now();
      await app.rc(`/sessions/${current}/command`, {
        method: "POST",
        body: JSON.stringify({ line: `axn-session select ${next}` }),
      });
      // The select is dispatched async in the frontend; the remount marks
      // term_open_done / renderer_attached land in the trace with the new
      // session's id as detail.
      const deadline = t0 + 30000;
      let openMs;
      let rendererMs;
      while (Date.now() < deadline && (openMs === undefined || rendererMs === undefined)) {
        const evs = readTrace(app).filter((e) => e.detail === next && e.epochMs >= t0 - 5);
        if (openMs === undefined) {
          const ev = evs.find((e) => e.name === "term_open_done");
          if (ev) openMs = ev.epochMs - t0;
        }
        if (rendererMs === undefined) {
          const ev = evs.find((e) => e.name === "renderer_attached");
          if (ev) rendererMs = ev.epochMs - t0;
        }
        if (openMs === undefined) await sleep(5);
        else if (rendererMs === undefined) await sleep(50);
      }
      if (openMs === undefined) throw new Error(`no term_open_done for ${next} within 30 s`);
      openSamples.push(Math.round(openMs * 10) / 10);
      if (rendererMs !== undefined) rendererSamples.push(Math.round(rendererMs * 10) / 10);
      rssSamples.push(rssMb(app.pid));
      current = next;
      app.sid = next;
      await sleep(300);
    }
    metric("switch.term_open_ms", {
      value: median(openSamples), samples: openSamples, unit: "ms",
      description: "select command → terminal remounted (term_open_done) for the switched-to session",
    });
    metric("switch.renderer_ms", {
      value: rendererSamples.length ? median(rendererSamples) : null, samples: rendererSamples, unit: "ms",
      description: "select command → renderer attached on the remounted terminal",
    });
    metric("switch.rss_end_mb", {
      value: rssSamples[rssSamples.length - 1], unit: "MB", digits: 0,
      description: "app RSS after the switch run — grows monotonically if switching leaks",
    });
    metric("switch.rss_delta_mb", {
      value: Math.round((rssSamples[rssSamples.length - 1] - rssSamples[0]) * 10) / 10, unit: "MB", digits: 1,
      better: "lower", description: "RSS growth across the switch run",
    });
    meta({ sessions, runs, openSamples, rendererSamples, rssSamples });
    return `switch measured (${sessions} sessions × ${runs} switches)`;
  } finally {
    await close(app);
  }
}

// ---------- restore + switch: selecting a session that is still waiting ----------
//
// Right after the first prompt, select the session that is restored last and
// time how long until its shell prints. With everything started at once it is
// already up (or racing the others); with the restore queue it must start on
// the spot, ahead of the sessions still waiting their turn.

async function restoreSwitch(step) {
  const a = args(step);
  const sessions = Number(a.sessions ?? 24);
  const rcMs = Number(a.rc ?? 400);
  const runs = runCount(step, 3);
  const upIn = [];
  const waited = [];
  for (let i = 0; i < runs; i++) {
    const app = await launch({ restore: sessions, select: "first", trace: true, rcCpuMs: rcMs });
    try {
      const state = JSON.parse(readFileSync(join(app.stateDir, "state.json"), "utf8"));
      const ids = state.windows[0].sessions.map((s) => s.id);
      const target = ids[ids.length - 1];
      const first = (id) => readTrace(app).find((e) => e.name === "pty_first_output" && e.detail === id);
      const tSelect = Date.now();
      const alreadyUp = !!first(target) && first(target).epochMs <= tSelect;
      await app.rc(`/sessions/${app.sid}/command`, {
        method: "POST",
        body: JSON.stringify({ line: `axn-session select ${target}` }),
      });
      const deadline = tSelect + 60000;
      let up;
      while (Date.now() < deadline && up === undefined) {
        const ev = first(target);
        if (ev) up = Math.max(0, ev.epochMs - tSelect);
        else await sleep(20);
      }
      if (up === undefined) throw new Error(`the last session never printed within 60 s`);
      upIn.push(Math.round(up));
      waited.push(alreadyUp ? 0 : 1);
    } finally {
      await close(app);
    }
  }
  const p = `restore_switch.${sessions}_rc${rcMs}`;
  metric(`${p}.select_to_prompt_ms`, { samples: upIn, unit: "ms", digits: 0, description: "select the last-restored session right after the first prompt → its shell printed (0 = it was already up)" });
  metric(`${p}.was_waiting`, { samples: waited, unit: "runs", digits: 0, better: "none", description: "1 when the session had not started yet at the select (the case this measures)" });
  meta({ sessions, rcMs, runs, upIn, waited });
  return `restore switch measured (${sessions} sessions, rc ${rcMs} ms)`;
}

// ---------- restore storm: what a restore costs the system ----------
//
// Restores `sessions` sessions whose shells each print `banner` KB before
// their first prompt, and measures until the app is quiet again: wall time,
// CPU (app + WebKit), peak memory, and — from the app's own `output_stats`
// trace mark — the main-thread time spent in the output handlers and how late
// a 20 ms timer fired (the freeze a user feels).

async function restoreStorm(step) {
  const a = args(step);
  const sessions = Number(a.sessions ?? 12);
  const banner = Number(a.banner ?? 256);
  const rcMs = Number(a.rc ?? 0);
  const runs = runCount(step, 3);
  const col = { shells: [], lastShell: [], queue: [], idle: [], cpu: [], web: [], main: [], rss: [], lagMax: [], lagOver50: [], lagSum: [], headless: [], visible: [], flush: [], bytes: [], first: [] };
  for (let i = 0; i < runs; i++) {
    const app = await launch({ restore: sessions, select: "first", trace: true, bannerKb: banner, rcCpuMs: rcMs });
    try {
      let peak = rssMb(app.pid);
      const t0 = app.t0;
      let prev = sumCpu(cpuByKind(app.pid));
      let prevT = now();
      let quiet = 0;
      let idleAt = null;
      while (now() - t0 < 120000) {
        await sleep(250);
        peak = Math.max(peak, rssMb(app.pid));
        const c = sumCpu(cpuByKind(app.pid));
        const ct = now();
        const pct = ((c - prev) / ((ct - prevT) / 1000)) * 100;
        prev = c;
        prevT = ct;
        quiet = pct < 5 ? quiet + 1 : 0;
        if (quiet >= 4) { idleAt = ct - t0 - 1000; break; }
      }
      const cpu = cpuByKind(app.pid);
      if (process.env.AXN_PERF_TIMELINE) {
        // what the app was doing when each stall hit: every mark, relative to spawn
        const lines = readTrace(app)
          .filter((e) => e.name !== "output_stats")
          .map((e) => `t+${String(Math.round(e.epochMs - app.spawnEpoch)).padStart(6)} ms  ${e.name.padEnd(22)} ${e.detail ?? ""}`);
        writeFileSync(process.env.AXN_PERF_TIMELINE, lines.join("\n") + "\n");
      }
      const stats = readTrace(app).filter((e) => e.name === "output_stats").pop();
      const o = stats?.detail ? JSON.parse(stats.detail) : {};
      const firsts = readTrace(app).filter((e) => e.name === "pty_first_output").map((e) => e.epochMs - app.spawnEpoch);
      col.lastShell.push(firsts.length >= sessions ? Math.max(...firsts) : null);
      col.shells.push(shellCpu(app.pid));
      col.queue.push(o.queuePeakKb);
      col.idle.push(idleAt);
      col.cpu.push(sumCpu(cpu));
      col.web.push(cpu.web);
      col.main.push(cpu.main);
      col.rss.push(peak);
      col.first.push(app.marks.prompt);
      col.lagMax.push(o.lagMaxMs);
      col.lagOver50.push(o.lagOver50);
      col.lagSum.push(o.lagSumMs);
      col.headless.push(o.headlessMs);
      col.visible.push(o.visibleMs);
      col.flush.push(o.flushMs);
      col.bytes.push(o.bytes != null ? o.bytes / 1048576 : null);
    } finally {
      await close(app);
    }
  }
  const p = `restore.${sessions}x${banner}kb${rcMs ? `_rc${rcMs}` : ""}`;
  metric(`${p}.first_prompt_ms`, { samples: col.first, unit: "ms", digits: 0, description: "selected session's first prompt, from spawn" });
  metric(`${p}.last_shell_ms`, { samples: col.lastShell, unit: "ms", digits: 0, description: "spawn → the last restored session's first output (all shells up)" });
  metric(`${p}.shell_cpu_s`, { samples: col.shells, unit: "s", digits: 1, better: "none", description: "CPU the hosted shells burnt starting up" });
  metric(`${p}.idle_ms`, { samples: col.idle, unit: "ms", digits: 0, description: "spawn → the app is quiet again (CPU < 5 % for 1 s)" });
  metric(`${p}.cpu_s`, { samples: col.cpu, unit: "s", digits: 1, description: "CPU seconds, app + WebKit, for the whole restore" });
  metric(`${p}.cpu_web_s`, { samples: col.web, unit: "s", digits: 1, description: "CPU in the WebKit content process (xterm, plugins, React)" });
  metric(`${p}.cpu_main_s`, { samples: col.main, unit: "s", digits: 1, description: "CPU in the app process (Rust readers, IPC)" });
  metric(`${p}.rss_peak_mb`, { samples: col.rss, unit: "MB", digits: 0, description: "peak resident memory, app + WebKit" });
  metric(`${p}.lag_max_ms`, { samples: col.lagMax, unit: "ms", digits: 0, description: "longest main-thread stall (20 ms timer fired this late)" });
  metric(`${p}.lag_sum_ms`, { samples: col.lagSum, unit: "ms", digits: 0, description: "total main-thread stall time" });
  metric(`${p}.lag_over50`, { samples: col.lagOver50, unit: "stalls", digits: 0, description: "stalls longer than 50 ms" });
  metric(`${p}.headless_ms`, { samples: col.headless, unit: "ms", digits: 0, description: "sync time in the headless-buffer chunk handlers" });
  metric(`${p}.visible_ms`, { samples: col.visible, unit: "ms", digits: 0, description: "sync time in the mounted terminal's chunk handler" });
  metric(`${p}.flush_ms`, { samples: col.flush, unit: "ms", digits: 0, description: "batched plugin/state flush time" });
  metric(`${p}.queue_peak_kb`, { samples: col.queue, unit: "KB", digits: 0, better: "none", description: "most output waiting in the headless-buffer queues at once" });
  metric(`${p}.output_mb`, { samples: col.bytes, unit: "MB", digits: 1, better: "none", description: "bytes the frontend received" });
  meta({ sessions, banner, runs });
  return `restore storm measured (${sessions} sessions × ${banner} KB)`;
}

export async function run(step) {
  const action = args(step).action ?? "help";
  switch (action) {
    case "static": return staticSizes(step);
    case "startup": return startup(step);
    case "phases": return phases(step);
    case "throughput": return throughput(step);
    case "interrupt": return interrupt(step);
    case "echo": return echo(step);
    case "output": return output(step);
    case "switch": return sessionSwitch(step);
    case "restoreStorm": return restoreStorm(step);
    case "restoreSwitch": return restoreSwitch(step);
    default:
      throw new Error(`unknown action '${action}' — static | startup | phases | throughput | interrupt | echo | output | switch | restoreStorm | restoreSwitch`);
  }
}

if (process.env.AXN_STEP) {
  run(JSON.parse(process.env.AXN_STEP))
    .then((result) => {
      if (result) console.log(result);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exit(1);
    });
}
