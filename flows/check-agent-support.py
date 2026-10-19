#!/usr/bin/env python3
"""Native contract checks using fixture CLIs and real piped command hooks.

Run from the repo root after a desktop build. No credentials or existing
agent settings are read or modified; all fixtures/state/logs remain in a
new temporary directory for inspection. This does not claim live-model proof.
"""
import json
import os
import secrets
from pathlib import Path
import socket
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

test_root = Path.home() / '.local/state/axn-term-tests'
test_root.mkdir(parents=True, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='agents-', dir=test_root))
state, config, bins = [root / name for name in ('state', 'config', 'bin')]
for path in (state, config, bins):
    path.mkdir()
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
base = f'http://127.0.0.1:{port}'
token = secrets.token_hex(32)
real_clis = {a: shutil.which(a) for a in ('claude', 'codex')}

for agent in ('claude', 'codex'):
    script = bins / agent
    script.write_text('''#!/bin/sh
agent=AGENT
echo "FIXTURE $agent $*"
hook="CONFIG_ROOT/.axn-term/agent-hook.sh"
while IFS= read -r line; do
  case "$line" in
    running) event=UserPromptSubmit ;;
    blocked) event=PermissionRequest ;;
    done) event=Stop ;;
    idle) event=SessionStart ;;
    tasks) printf 'Update Todos\\n  ☒ completed task\\n  ▶ running task\\n'; continue ;;
    exit|/exit) exit 0 ;;
    *) continue ;;
  esac
  printf '{"hook_event_name":"%s","tool_name":"Bash","sequence":"%s"}' "$event" "$line" | "$hook" "$agent"
done
'''.replace('AGENT', agent).replace('CONFIG_ROOT', str(config)))
    script.chmod(0o700)
(state / 'plugins.yaml').write_text('''claude:
  enabled: true
  install-hooks: true
codex:
  enabled: true
  install-hooks: true
docker:
  enabled: false
glab-mr:
  enabled: false
''')
(state / 'state.json').write_text(json.dumps({'windows': [{
    'id': 'main', 'workspaces': [{'id': 'agents', 'name': 'Agent support test', 'collapsed': False}],
    'sessions': [dict(id=f'{a}-test', workspaceId='agents', name=a, cwd=str(root),
                      topic='', summary='', tasks=[], progress=0, output='') for a in ('claude', 'codex')],
    'selectedWorkspaceId': 'agents', 'selectedSessionId': 'claude-test',
}]}))
log = (root / 'app.log').open('w')
app = subprocess.Popen([str(Path(os.environ.get('AXN_TERM_BINARY', 'target/debug/axn-term')).resolve())],
    env={**os.environ, 'AXN_TERM_STATE_DIR': str(state), 'AXN_TERM_AGENT_CONFIG_ROOT': str(config),
         'AXN_TERM_REMOTE_CONTROL_PORT': str(port),
         'AXN_TERM_REMOTE_CONTROL_TOKEN': token, 'LOG_LEVEL': 'debug'}, stdin=subprocess.DEVNULL, stdout=log, stderr=log)

def request(path, body=None):
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'})
    with urllib.request.urlopen(req, timeout=3) as response:
        text = response.read().decode()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text

def until(label, check, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and app.poll() is None:
        try:
            if check():
                return
        except (OSError, ValueError, KeyError, TypeError):
            pass
        time.sleep(.2)
    raise AssertionError(f'Timed out: {label}; evidence: {root}')

def write(agent, text):
    request(f'/sessions/{agent}-test/write', {'text': text})

def session(agent):
    return next(s for w in request('/state')['windows'] for s in w['sessions'] if s['id'] == agent + '-test')

def status(agent, expected):
    until(f'{agent} {expected}', lambda: session(agent).get('status') == expected)
    time.sleep(3.2)  # Cross foreground polling ticks and persisted-state flushes.
    assert session(agent).get('status') == expected, f'{agent} lost {expected}'

def passed(message):
    print('PASS ' + message, flush=True)

try:
    until('two PTYs', lambda: len(request('/sessions')) == 2, 30)
    for agent in ('claude', 'codex'):
        write(agent, f'{bins / agent}\r')
        until(f'{agent} detection', lambda: session(agent).get('process') == agent)
        file = config / ('.' + agent) / ('settings.json' if agent == 'claude' else 'hooks.json')
        until(f'{agent} hooks', lambda: bool(json.loads(file.read_text())['hooks']['Stop']))
        passed(f'{agent}: native process detection and isolated hook installation')
    for agent in ('claude', 'codex'):
        for command, expected in (('running', 'running'), ('blocked', 'blocked'), ('done', 'completed')):
            write(agent, command + '\r')
            status(agent, expected)
            attention = session(agent).get('pluginState', {}).get(agent, {}).get('attention')
            if expected == 'blocked':
                assert attention and attention['level'] == 'critical'
            if expected == 'completed':
                assert not attention
            passed(f'{agent}: {expected} survives foreground polling')
    write('claude', 'blocked\r')
    status('claude', 'blocked')
    assert session('codex')['status'] == 'completed'
    passed('simultaneous agents: hook events stay in their own session')
    write('claude', 'running\r')
    status('claude', 'running')
    write('claude', 'tasks\r')
    until('Claude tasks', lambda: len(session('claude')['tasks']) == 2 and session('claude')['progress'] == 50)
    passed('Claude: rendered task list and 50% progress')
    for agent in ('claude', 'codex'):
        write(agent, 'done\r')
        status(agent, 'completed')
        write(agent, 'exit\r')
        until(f'{agent} exits', lambda: not session(agent).get('process'))
        write(agent, f'export PATH="{bins}:$PATH"\r')
        request(f'/sessions/{agent}-test/command', {'line': f'axn-{agent}-resume'})
        expected = 'FIXTURE claude -c' if agent == 'claude' else 'FIXTURE codex resume --last'
        until(f'{agent} resume', lambda: expected in request(f'/sessions/{agent}-test')['output'])
        passed(f'{agent}: resume command routes to the correct CLI')
        write(agent, 'exit\r')
    passed(f'native agent contract checks. Evidence: {root}')
    if '--live' in sys.argv:
        # Explicit opt-in: uses the installed CLIs and their existing login.
        # No model override, permission bypass, or global hook install.
        # Codex hook trust is NOT bypassed; fixture proof above is separate
        # from this real-model launch/resume check.
        for agent in ('claude', 'codex'):
            cli = real_clis[agent]
            if not cli:
                raise RuntimeError(f'{agent} is not installed')
            until(f'{agent} shell before live check', lambda: not session(agent).get('process'))
            token = 'AXN' + agent.upper() + root.name.replace('-', '').replace('_', '')[-8:]
            first = f'Remember token {token}. Reply with that token followed by -FIRST, and nothing else. Do not use tools.'
            second = 'Reply with the token from the preceding message followed by -SECOND, and nothing else. Do not use tools.'
            if agent == 'claude':
                common = [cli, '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', str(config / '.claude/settings.json')]
                commands = [common + ['-p', first], common + ['-c', '-p', second]]
            else:
                commands = [[cli, '--no-daemon', 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', first],
                            [cli, '--no-daemon', 'exec', 'resume', '--last', '--skip-git-repo-check', second]]
            for index, command in enumerate(commands):
                write(agent, shlex.join(command) + '\r')
                expected = token + ('-FIRST' if index == 0 else '-SECOND')
                until(f'live {agent} {expected}', lambda: expected in request(f'/sessions/{agent}-test')['output'], 120)
                until(f'live {agent} returns to shell', lambda: not session(agent).get('process'), 30)
                if agent == 'claude':
                    status(agent, 'completed')
                passed(f'live {agent}: ' + ('model response through native PTY' if index == 0 else 'resumed conversation recalls its token'))
finally:
    if app.poll() is None:
        try:
            request('/close', {})
        except OSError:
            pass
        try:
            app.wait(timeout=10)
        except subprocess.TimeoutExpired:
            app.terminate()
            app.wait(timeout=5)
    log.close()
