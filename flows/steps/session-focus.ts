import type { ElementHandle, Page } from 'playwright-core';

// SessionPanel marks the selected session's title row (the draggable div)
// with this accent fill; unselected rows only carry a hover variant.
const SELECTED_SESSION_CLS = 'bg-[var(--fill-accent)]';
// WorkspaceHeader's data-tip is `<name> (drag to reorder, right-click for options)`.
const WORKSPACE_TIP_SUFFIX = ' (drag to reorder, right-click for options)';

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
            .filter((handle) => {
              const row = handle.parentElement!;
              return row !== block && row.classList.contains('cursor-pointer');
            })
            .map((handle) => ({
              name: handle.querySelector('span.font-semibold')?.textContent?.trim() ?? '',
              selected: handle.classList.contains(selectedCls),
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

/** `document.activeElement` sits inside a visible xterm — the nav handoff landed. */
function focusInTerminal(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const xterm = el?.closest('.xterm') as HTMLElement | null;
    return !!xterm && xterm.checkVisibility();
  });
}

/** What has DOM focus right now — for failure diagnostics. */
function describeFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return 'nothing';
    const xterm = el.closest('.xterm') as HTMLElement | null;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 4).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} (in xterm: ${!!xterm}, xterm visible: ${xterm ? xterm.checkVisibility() : false})`;
  });
}

/**
 * After a navigation shortcut, the destination terminal must hold DOM focus:
 * type a unique marker with no further clicks and require it to show up in
 * the visible shell — focus left behind (panel/body/old terminal) drops or
 * misroutes every keystroke.
 */
async function expectFocusThenType(page: Page, label: string, mark: string) {
  // The handoff is part of the selection commit; a short window covers the
  // remounting view. Whether it landed decides how we report a missing echo.
  const focusOk = await waitFor(page, `focus to reach the terminal after ${label}`, () =>
    focusInTerminal(page), 4000,
  ).then(() => true, () => false);

  await page.keyboard.type(`echo ${mark}`);
  await page.keyboard.press('Enter');
  try {
    await waitFor(page, `"${mark}" in the selected session's terminal`, async () =>
      (await terminalText(page)).includes(mark), 8000);
  } catch (e) {
    const focus = await describeFocus(page);
    const text = await terminalText(page);
    throw new Error(
      `${label}: typed input never reached the selected session's shell ` +
        `(focus reached a terminal: ${focusOk}, focus now on: ${focus}). ` +
        `${e instanceof Error ? e.message : e}\nVisible terminal:\n${text.slice(-800)}`,
    );
  }
  if (!focusOk) {
    throw new Error(
      `${label}: "${mark}" echoed, but DOM focus never sat in the terminal ` +
        `(on: ${await describeFocus(page)}) — the nav handoff did not happen`,
    );
  }
}

/** The draggable handle of session `index` in workspace `wsIndex` — real click. */
async function sessionRowHandle(
  page: Page,
  wsIndex: number,
  index: number,
): Promise<ElementHandle> {
  const handle = await page.evaluateHandle(
    ([suffix, w, s]) => {
      const headers = Array.from(document.querySelectorAll<HTMLElement>('[data-tip]'))
        .filter((el) => el.dataset.tip?.endsWith(suffix as string));
      const block = headers[w as number]?.parentElement;
      if (!block) return null;
      return Array.from(block.querySelectorAll<HTMLElement>('div[draggable="true"]'))
        .map((h) => h.parentElement!)
        .filter((r) => r !== block && r.classList.contains('cursor-pointer'))[s as number] ?? null;
    },
    [WORKSPACE_TIP_SUFFIX, wsIndex, index] as const,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no session row ${index} in workspace ${wsIndex}`);
  return el;
}

export default async function sessionFocus(page: Page, _baseUrl: string) {
  // The login step leaves one selected session at a prompt.
  const initial = await waitFor(page, 'a selected session', async () => {
    const panel = await readPanel(page);
    return selectedPos(panel) ? panel : null;
  });
  const [w] = selectedPos(initial)!;
  const wsName = initial[w].name;
  const count = initial[w].sessions.length;
  const stamp = Date.now().toString(36);

  // A second session in the same workspace, via its header's "+" — it lands
  // at the end of the session list and becomes the selected one.
  await page
    .locator(`[data-tip="${wsName}${WORKSPACE_TIP_SUFFIX}"]`)
    .locator('[aria-label="New session in workspace"]')
    .click();
  await expectSelected(page, 'the new session', w, count);
  await waitFor(page, 'the new session prompt', async () => (await terminalText(page)).includes('~$'), 60000);

  // Sanity: with a clicked-in terminal, typed input reaches the shell.
  const m0 = `sanity-${stamp}`;
  await page.locator('.xterm-screen:visible').first().click();
  await page.keyboard.type(`echo ${m0}`);
  await page.keyboard.press('Enter');
  await waitFor(page, `sanity echo "${m0}"`, async () => (await terminalText(page)).includes(m0));

  // Case 1 — the terminal holds focus: Ctrl+Alt+ArrowUp must move the
  // selection *and* hand DOM focus to the previous session's shell, so the
  // next keystrokes land there.
  await page.keyboard.press('Control+Alt+ArrowUp');
  await expectSelected(page, 'Ctrl+Alt+ArrowUp', w, count - 1);
  await expectFocusThenType(page, 'Ctrl+Alt+ArrowUp with the terminal focused', `up-${stamp}`);

  // Case 2 — same, cycling back down to the second session.
  await page.keyboard.press('Control+Alt+ArrowDown');
  await expectSelected(page, 'Ctrl+Alt+ArrowDown', w, count);
  await expectFocusThenType(page, 'Ctrl+Alt+ArrowDown with the terminal focused', `down-${stamp}`);

  // Case 3 — focus sits in the session panel (a real row click leaves it
  // there or drops it to <body>): the shortcut must still focus the shell.
  const firstRow = await sessionRowHandle(page, w, 0);
  await firstRow.click();
  await expectSelected(page, 'the session row click', w, 0);
  await page.keyboard.press('Control+Alt+ArrowDown');
  await expectSelected(page, 'Ctrl+Alt+ArrowDown after a panel click', w, 1);
  await expectFocusThenType(page, 'Ctrl+Alt+ArrowDown with focus in the panel', `panel-${stamp}`);

  return 'Focus follows session navigation verified';
}
