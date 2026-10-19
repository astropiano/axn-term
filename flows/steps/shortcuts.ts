import type { Page } from 'playwright-core';

// SessionPanel marks the selected session row with this accent inset shadow.
const SELECTED_SESSION_CLS = 'shadow-[inset_2px_0_0_var(--accent)]';
// WorkspaceHeader's data-tip is `<name> (drag to reorder, right-click for options)`.
const WORKSPACE_TIP_SUFFIX = ' (drag to reorder, right-click for options)';

// Stand-in devin: comm "devin" matches the devin plugin's process pattern; on
// exit it prints the resume hint the plugin remembers, and `devin -r <name>`
// (what axn-devin-resume expands to) just reports the resumed name.
const FAKE_BIN = '/tmp/axn-flow-bin';
const FAKE_DEVIN = [
  '#!/bin/sh',
  'if [ "$1" = -r ]; then echo "fake devin resumed $2"; exit 0; fi',
  'sleep 4',
  'echo "Resume this session with devin -r flow-resume"',
  'sleep 1',
];

interface PanelSession {
  name: string;
  selected: boolean;
}
interface PanelWorkspace {
  name: string;
  sessions: PanelSession[];
}

/** Workspaces in sidebar order, each with its session rows. */
function readPanel(page: Page): Promise<PanelWorkspace[]> {
  return page.evaluate(
    ([suffix, selectedCls]) =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-tip]'))
        .filter((el) => el.dataset.tip?.endsWith(suffix))
        .map((header) => {
          const block = header.parentElement!;
          const sessions = Array.from(block.querySelectorAll<HTMLElement>('div[draggable="true"]'))
            .map((handle) => handle.parentElement!)
            .filter((row) => row !== block && row.classList.contains('cursor-pointer'))
            .map((row) => ({
              name: row.querySelector('span.font-semibold')?.textContent?.trim() ?? '',
              selected: row.classList.contains(selectedCls),
            }));
          return { name: header.dataset.tip!.slice(0, -suffix.length), sessions };
        }),
    [WORKSPACE_TIP_SUFFIX, SELECTED_SESSION_CLS] as const,
  );
}

/** [workspace index, session index] of the selected session row. */
function selectedPos(panel: PanelWorkspace[]): [number, number] | null {
  for (let w = 0; w < panel.length; w++) {
    const s = panel[w].sessions.findIndex((x) => x.selected);
    if (s >= 0) return [w, s];
  }
  return null;
}

async function waitFor<T>(
  page: Page,
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await page.waitForTimeout(100);
  }
}

/** Visible terminal text (DOM renderer — forced by the login step). */
function terminalText(page: Page): Promise<string> {
  return page
    .locator('.xterm-rows:visible')
    .first()
    .innerText()
    .catch(() => '');
}

async function runInTerminal(page: Page, line: string) {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

async function expectSelected(page: Page, label: string, w: number, s: number) {
  try {
    await waitFor(page, `${label} to select workspace ${w + 1} / session ${s + 1}`, async () => {
      const pos = selectedPos(await readPanel(page));
      return pos?.[0] === w && pos[1] === s;
    });
  } catch (e) {
    const panel = JSON.stringify(await readPanel(page));
    throw new Error(`${e instanceof Error ? e.message : e}; sidebar: ${panel}`);
  }
}

export default async function shortcuts(page: Page, _baseUrl: string) {
  // The login step leaves us on a shell with at least one selected session.
  const initial = await waitFor(page, 'a selected session', async () => {
    const panel = await readPanel(page);
    return selectedPos(panel) ? panel : null;
  });

  // 1. Add a workspace (IconButton renders its title as data-tip).
  await page.locator('[data-tip="New workspace"]').click();
  const withWorkspace = await waitFor(page, 'the new workspace', async () => {
    const panel = await readPanel(page);
    return panel.length === initial.length + 1 ? panel : null;
  });
  const newWs = withWorkspace.length - 1;
  const newWsName = withWorkspace[newWs].name;

  // 2. Add a session to it via its header's "+" — it becomes the selected one.
  await page
    .locator(`[data-tip="${newWsName}${WORKSPACE_TIP_SUFFIX}"]`)
    .locator('[aria-label="New session in workspace"]')
    .click();
  await expectSelected(page, 'the new session', newWs, 0);
  // Wait for its shell so the shortcuts below act on a live terminal.
  await waitFor(page, 'the new session prompt', async () => (await terminalText(page)).includes('~$'), 60000);
  // ShellApp listens on window (bubble phase); xterm stops propagation of
  // Ctrl+Alt+Arrow (it encodes them as escape sequences), so the shortcuts
  // only fire while focus is outside the terminal.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // 3. Ctrl+Alt+Up/Down cycle sessions across workspaces in sidebar order.
  const prevWs = newWs - 1;
  const prevWsLast = initial[prevWs].sessions.length - 1;
  await page.keyboard.press('Control+Alt+ArrowUp');
  await expectSelected(page, 'Ctrl+Alt+ArrowUp', prevWs, prevWsLast);
  await page.keyboard.press('Control+Alt+ArrowDown');
  await expectSelected(page, 'Ctrl+Alt+ArrowDown', newWs, 0);

  // 4. Ctrl+Alt+Shift+Up/Down switch workspaces, landing on their first session.
  await page.keyboard.press('Control+Alt+Shift+ArrowUp');
  await expectSelected(page, 'Ctrl+Alt+Shift+ArrowUp', prevWs, 0);
  await page.keyboard.press('Control+Alt+Shift+ArrowDown');
  await expectSelected(page, 'Ctrl+Alt+Shift+ArrowDown', newWs, 0);

  // 5. Run a fake devin that exits with a resume hint; the devin plugin
  //    remembers the session name from it.
  await page.locator('.xterm-screen:visible').first().click();
  const script = FAKE_DEVIN.map((l) => `'${l.replace(/'/g, `'\\''`)}'`).join(' ');
  await runInTerminal(
    page,
    `mkdir -p ${FAKE_BIN} && printf '%s\\n' ${script} > ${FAKE_BIN}/devin && chmod +x ${FAKE_BIN}/devin && export PATH=${FAKE_BIN}:$PATH && clear`,
  );
  await page.waitForTimeout(500);
  await runInTerminal(page, 'devin');
  await waitFor(
    page,
    'the fake devin to exit',
    async () => {
      const text = await terminalText(page);
      const hint = text.lastIndexOf('Resume this session with devin -r flow-resume');
      return hint >= 0 && text.slice(hint).includes('~$');
    },
    20000,
  );
  // onProcessEnd fires on the next foreground-process poll.
  await page.waitForTimeout(3000);

  // 6. The hidden command is rewritten to `cd <cwd> && devin -r <name>`
  //    before it reaches the shell.
  await runInTerminal(page, 'axn-devin-resume');
  const termText = await waitFor(
    page,
    'the rewritten devin resume command',
    async () => {
      const text = await terminalText(page);
      return text.includes('fake devin resumed flow-resume') || /not found|no remembered/.test(text)
        ? text
        : null;
    },
    10000,
  );
  if (!termText.includes('fake devin resumed flow-resume')) {
    throw new Error(`axn-devin-resume was not rewritten to devin -r flow-resume:\n${termText}`);
  }
  if (/axn-devin-resume: (command )?not found/.test(termText)) {
    throw new Error('the hidden axn-devin-resume command leaked to the shell');
  }

  await runInTerminal(page, `rm -rf ${FAKE_BIN}`);

  return 'Workspace and session switching verified\nDevin resume command verified';
}
