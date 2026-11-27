# axn-term performance flows

`flows/axn-term-perf.xml` measures the desktop app (release binary) and
records numbers in the flow report, so you can see which change moved which
metric.

```sh
# build what you want to measure
(cd apps/desktop && pnpm tauri build --no-bundle)

# measure, label the run
axn-dev flow -f flows/axn-term-perf.xml --label before
# … change code, rebuild …
axn-dev flow -f flows/axn-term-perf.xml --label after

# compare (text, or --format md for an MR description)
axn-dev flow compare -f flows/axn-term-perf.xml before after
# trend over all labelled runs
axn-dev flow history -f flows/axn-term-perf.xml --metric screen_ms
```

The whole file runs in about 15 minutes. Narrower runs:

| What you want | How |
|---|---|
| one area | `-t "perf - throughput"` (flow name filter) |
| fewer repetitions | `AXN_PERF_QUICK=1` (≈⅓ of the runs) or `AXN_PERF_RUNS=2` |
| another binary (e.g. an old build kept aside) | `AXN_TERM_BINARY=/path/to/axn-term` |

Windows open on your desktop while it runs. The machine's other load (a
busy browser, a build) shows up in the numbers: compare medians, keep the
machine quiet, and re-run when a delta is within the min–max spread.

## What each metric means and what moves it

All times are medians over the runs; the report keeps every sample.

### `static.*` — sizes

| Metric | Meaning | Moved by |
|---|---|---|
| `binary_mb` | release binary | Cargo `[profile.release]`, Rust deps, embedded frontend |
| `entry_js_kb` | JS evaluated before the first render | static imports reachable from `apps/desktop/src/main.tsx` — keep Monaco (`lazyViews.tsx`), mermaid, etc. lazy |
| `entry_css_kb` | CSS before first paint | stylesheets of statically imported modules |
| `js_total_kb`, `js_chunks` | everything incl. lazy chunks/workers | new dependencies, lucide `dynamicIconImports` (one chunk per icon) |

Bundle sizes come from `apps/desktop/dist`, i.e. the last frontend build — not
necessarily the one inside `AXN_TERM_BINARY`.

### `startup.<variant>.*` — time to a usable terminal

Variants: `fresh` (empty state), `restore12_first` / `restore12_last`
(12 saved sessions, 200 KB scrollback each, selected one first or last).

| Metric | Meaning | Moved by |
|---|---|---|
| `health_ms` | Rust up, control server listening | Rust init, `setup` hook work, binary size/linking |
| `window_ms` | webview window exists | window creation (WebKit processes) |
| `shell_ms` | selected session's PTY spawned | everything in `phases` up to `pty_spawn` |
| `prompt_ms` | its first prompt reached the app | + shell start (plain bash here — your rc files add to this in real life) |
| `all_shells_ms` | every restored session spawned (restore only) | per-session mount cost (xterm open, spawn, plugins) |
| `rss_mb` | app + WebKit resident memory after start | bundle size, xterm instances, scrollback |
| `idle_cpu_pct` | CPU while idle, % of one core, after the Monaco warm-up | 1 s fg/cwd pollers, config polling, timers |

### `phases.*` — where startup time goes

Needs a binary with `AXN_TERM_PERF_TRACE` support (from this branch on);
older binaries skip the flow.

| Phase | From → to | Moved by |
|---|---|---|
| `exec_ms` | spawn → `run()` | binary size, dynamic linking |
| `rust_init_ms` | `run()` → Tauri `setup` | builder, plugin init |
| `window_create_ms` | `setup` → windows built | WebKit process start (mostly fixed cost) |
| `webview_load_ms` | windows built → page loaded | HTML/CSS load |
| `js_eval_ms` | page loaded → `main.tsx` ran | **entry bundle size** (`static.entry_js_kb`) |
| `app_mount_ms` | → `ShellApp` mounted | first React render, providers, plugin registration |
| `state_load_ms` | → window state loaded | `load_window_state`, state.json size |
| `terminal_open_ms` | → selected terminal's xterm opened | rendering all sessions, xterm `open()` |
| `pty_spawn_ms` | → spawn requested | work in `ShellTerminal`'s mount effect before the spawn |
| `shell_start_ms` | → first PTY output | the shell itself |
| `first_paint_ms` | → that output painted | output transport, xterm parse, main-thread work at that moment (GPU renderer attach) |
| `total_ms` | spawn → first output painted | all of the above |
| `external_requests` | outside hosts the page contacted in its first 3 s | a remote `@import` / `<link>` (the old Google Fonts import) — should stay 0 |
| `startup_resources` | http(s) files the page loaded in its first 3 s (own `tauri://` assets not counted) | remote fonts, CDN scripts |
| `renderer_after_spawn_ms` | GPU renderer attached, relative to spawn | WebGL context creation (deferred past the spawn on purpose) |

Trace marks: Rust `perf_trace::mark`, frontend `perfMark()` (`libs/shell-ui/src/perf.ts`).
Add a mark and a row in `PHASES` (`flows/adapters/axn-term-perf.js`) to split a phase further.

### `throughput.<workload>.*` — heavy output

Workloads: `cat_plain_32mb`, `cat_ansi_16mb` (coloured), `seq_2m_lines`.

| Metric | Meaning | Moved by |
|---|---|---|
| `pty_ms` | until the shell finished (output reached Rust) — informational, no verdict in `compare` | flow control holds the producer back to what the UI can show — so this follows `screen_ms` |
| `screen_ms` | until the app went idle — everything rendered | output transport (`attach_output` channel, batching), React work per chunk (`ShellApp` output batching), xterm |
| `cpu_s` | CPU time, app + WebKit | all of the above |
| `cpu_web_s` | CPU in the WebKit content process | JS: frame parsing, plugin `onOutput`, xterm parse/render |
| `cpu_main_s` | CPU in the app process | Rust reader/emitter, IPC delivery |
| `throughput.rss_growth_mb` | memory left behind by the workloads | scrollback, buffers that aren't released |

### `interrupt.*` — Ctrl-C during an output flood

| Metric | Meaning | Moved by |
|---|---|---|
| `prompt_ms` | Ctrl-C → next command's output reached the app | backlog queued between PTY and frontend |
| `screen_ms` | Ctrl-C → app caught up and idle | **flow control**: transport credit (`ack_output`), xterm watermarks (`flowControl.ts`), `FlowGate` |

### `echo.*` — keystrokes

| Metric | Meaning | Moved by |
|---|---|---|
| `pty_roundtrip_ms` / `_p95_ms` | key written → echo back in Rust | writer thread (`write_session`), reader/emitter threads |

This path skips the UI (the harness can't type into the webview); input
latency through xterm is not covered.

### `output.*` — correctness guard

`output.frontend_saved_ms`: 3 MB of output plus a marker must reach the
frontend's session output (saved to state.json, 2 s debounce). Fails the flow
when the output pipeline drops data.

### `restore.<N>x<banner>kb_rc<ms>[_c<k>].*` — restoring many sessions

Action `restoreStorm`: N restored sessions whose shells print `banner` KB and
burn `rc` ms of CPU before their first prompt (a heavy `.zshrc`), optionally
with `restoreConcurrency: k`. Run it with `AXN_TERM_BINARY` pointing at each
build you want to compare (copy the `.app` aside per build).

| Metric | Meaning | Moved by |
|---|---|---|
| `first_prompt_ms` | selected session's first prompt, from spawn | the restore queue (`app/restoreQueue.ts`) — the visible shell no longer competes with all the others |
| `last_shell_ms` | the last restored session's first output | the price of starting in steps (`restoreConcurrency`) |
| `shell_cpu_s` | CPU the hosted shells burnt starting up | informational: the work is the same, only when it happens changes |
| `cpu_s`, `cpu_web_s`, `cpu_main_s` | app + WebKit / content process / app process CPU for the restore | per-session mount cost, polls, output handling |
| `lag_*`, `headless_ms`, `visible_ms`, `flush_ms`, `queue_peak_kb` | main-thread stall time (hidden pages ignored — the engine throttles their timers to 1 Hz), time in the output handlers, peak output waiting in the headless-buffer queues | `app/outputScheduler.ts` |

Action `restoreSwitch` (`restore_switch.*.select_to_prompt_ms`): right after the
first prompt, select the session restored last and time its first output — a
session still waiting must start on the spot, not behind the queue.

On macOS the lib samples with `ps` and attributes the WebKit helpers that
appeared after the app started to it — keep other WebKit apps quiet during a
run, and keep the machine otherwise idle (shell CPU is competing for cores).
