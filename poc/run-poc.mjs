import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEVIN_SIM = path.join(__dirname, 'devin-sim');

const SESSION_RES = [
  // Older CLI: "Resume this session with `devin -r <name>`" on one line.
  /resume this session[^\n]*?devin\s+(?:-r|resume)\s+([A-Za-z0-9_-]+)/gi,
  // 3000.11+: two-line hint — " devin -r <name>" then " resumes this session …".
  /devin\s+(?:-r|resume)\s+([A-Za-z0-9_-]+)[^\n]*\r?\n[^\n]*?resumes\s+this\s+session/gi,
];
const TASK_LINE_PATTERN = /^\s*[\u2502\u251C\u2514\u2516\u2574]\s*([\u2713\u2714\u2715\u2716\u2717\u2718\u25CB\u25D4\u25D0\u25D5\u25CF\u25CE\u23FA])\s+(\d+)[\.)]\s+(.+)$/gu;
const TASK_UPDATE_MARKER = /updated\s+(?:todo|task)s?\s*list/i;

function parseStatusSymbol(symbol) {
  switch (symbol) {
    case '✓':
    case '✔':
    case '●':
    case '☑':
      return 'completed';
    case '✗':
    case '✘':
    case '✕':
    case '✖':
      return 'blocked';
    case '○':
      return 'pending';
    case '◔':
    case '◐':
    case '◕':
    case '◎':
    case '⏺':
    default:
      return 'running';
  }
}

export function parseDevinSessionName(output) {
  let last;
  let lastEnd = -1;
  for (const re of SESSION_RES) {
    for (const m of output.matchAll(re)) {
      const end = m.index + m[0].length;
      if (end > lastEnd) {
        lastEnd = end;
        last = m[1];
      }
    }
  }
  return last;
}

export function parseDevinTasks(output) {
  const lines = output.split('\n');
  const tasks = [];
  const seen = new Set();

  let i = lines.length - 1;
  while (i >= 0) {
    const rawLine = lines[i];
    const line = rawLine.replace(/\r$/, '');
    TASK_LINE_PATTERN.lastIndex = 0;
    const match = TASK_LINE_PATTERN.exec(line);
    if (!match) {
      if (tasks.length > 0) break;
      i--;
      continue;
    }

    const status = parseStatusSymbol(match[1]);
    const number = match[2];
    const title = match[3].trim();
    const id = `devin-${number}`;
    if (title && !seen.has(id)) {
      seen.add(id);
      tasks.unshift({ id, title, status });
    }
    i--;
  }

  return tasks;
}

export function computeTaskState(tasks) {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const hasBlocked = tasks.some((t) => t.status === 'blocked');
  const hasRunning = tasks.some((t) => t.status === 'running');
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
  let status;
  if (hasBlocked) {
    status = 'blocked';
  } else if (hasRunning) {
    status = 'running';
  } else if (total > 0 && completed === total) {
    status = 'completed';
  } else if (total > 0) {
    status = 'running';
  }
  return { tasks, progress, status, completed };
}

function chunkOutput(output, n = 40) {
  const chunks = [];
  for (let i = 0; i < output.length; i += n) {
    chunks.push(output.slice(i, i + n));
  }
  return chunks;
}

async function run() {
  const child = spawn('bash', [DEVIN_SIM], { cwd: __dirname });
  const collected = [];

  child.stdout.on('data', (data) => collected.push(data.toString()));
  child.stderr.on('data', (data) => collected.push(data.toString()));

  // Simulate the plugin's onClose sending `/exit` to the process.
  setTimeout(() => {
    child.stdin.write('/exit\n');
    child.stdin.end();
  }, 100);

  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  const raw = collected.join('');

  console.log('--- RAW PTY OUTPUT ---');
  console.log(raw);
  console.log(`exit code: ${exitCode}`);

  // Simulate the real frontend path: the PTY stream is delivered in chunks.
  // Each chunk goes through onOutput; the plugin only parses tasks for 4
  // chunks after seeing "Updated todo list".
  let parsePending = 0;
  let parsedName;
  let parsedTasks = [];

  for (const chunk of chunkOutput(raw, 42)) {
    parsedName = parseDevinSessionName(raw) ?? parsedName;
    if (TASK_UPDATE_MARKER.test(chunk)) {
      parsePending = 4;
    }
    if (parsePending > 0) {
      parsedTasks = parseDevinTasks(raw);
      parsePending--;
    }
  }

  const state = computeTaskState(parsedTasks);

  console.log('\n--- PARSED RESULT ---');
  console.log('session name:', parsedName);
  console.log('tasks:', parsedTasks);
  console.log('computed:', state);

  if (!parsedName) throw new Error('session name was not parsed');
  if (parsedName !== 'green-aurora') throw new Error(`unexpected session name: ${parsedName}`);
  if (parsedTasks.length !== 3) throw new Error(`expected 3 tasks, got ${parsedTasks.length}`);
  if (state.progress !== 33) throw new Error(`expected 33%, got ${state.progress}%`);

  console.log('\n✅ PoC passed');
}

run().catch((err) => {
  console.error('\n❌ PoC failed:', err.message);
  process.exit(1);
});
