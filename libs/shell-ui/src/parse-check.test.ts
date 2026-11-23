import { it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDevinTasks } from './app/session-plugins/devinTasks';

const STATE_FILE =
  process.env.AXN_STATE_FILE ?? join(homedir(), '.axn-term/state.json');

it.skipIf(!existsSync(STATE_FILE))('parse real retained output', () => {
  const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const found: any[] = [];
  const walk = (o: any) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (o.output && o.id) found.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(s);
  for (const sess of found) {
    const tasks = parseDevinTasks(sess.output);
    console.log(sess.id.slice(0, 8), sess.name?.slice(0, 40), '→', tasks.length, 'tasks',
      tasks[0] ? JSON.stringify(tasks[0]).slice(0, 90) : '');
  }
});
