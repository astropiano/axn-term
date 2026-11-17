import { spawn } from 'node:child_process';
import net from 'node:net';

// `storybook dev -p <port>` blocks on an interactive "port in use, use
// another?" prompt when the port is taken, which hangs pnpm/non-TTY runs.
// Probe for a free port up front (6006 first, then incrementing) so the
// command always just starts.
const tryPort = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(port, () => srv.close(() => resolve(port)));
  });

let port = null;
for (let candidate = 6006; candidate < 6020 && port === null; candidate += 1) {
  port = await tryPort(candidate);
}
if (port === null) {
  console.error('No free port in 6006-6019 for storybook');
  process.exit(1);
}

const extra = process.argv.slice(2);
const explicitPort = extra.includes('-p') || extra.includes('--port');
const args = explicitPort ? ['dev', ...extra] : ['dev', '-p', String(port), ...extra];
const child = spawn('storybook', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (code) => process.exit(code ?? 0));
