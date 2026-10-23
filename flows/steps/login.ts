import type { Page } from 'playwright-core';

const TEST_USER = process.env.TEST_USER ?? 'demo';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'changeme';

const SETTINGS_KEY = 'axn-term:settings';

/**
 * Text of the visible terminal. xterm's default WebGL/canvas renderers paint
 * into a <canvas>, so the DOM renderer (forced below) is what makes the rows
 * readable here.
 */
function terminalText(page: Page): Promise<string> {
  return page
    .locator('.xterm-rows')
    .first()
    .innerText()
    .catch(() => '');
}

export default async function login(page: Page, baseUrl: string) {
  const appHost = new URL(baseUrl).host;

  // Force xterm's DOM renderer before the app loads: merge
  // `terminalRenderer: 'dom'` into the stored settings on the app origin only
  // (the init script also runs on the Keycloak pages).
  await page.context().addInitScript(
    ([host, key]) => {
      if (location.host !== host) return;
      let stored: Record<string, unknown> = {};
      try {
        stored = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
      } catch {
        // corrupt blob — overwrite
      }
      localStorage.setItem(key, JSON.stringify({ ...stored, terminalRenderer: 'dom' }));
    },
    [appHost, SETTINGS_KEY] as const,
  );

  await page.goto(baseUrl, { waitUntil: 'networkidle' });

  const loginButton = page.locator('button:has-text("Log in with Keycloak")');
  const needsLogin = await loginButton.isVisible().catch(() => false);

  if (needsLogin) {
    await loginButton.click();

    await page.waitForURL(/keycloak/, { timeout: 15000 });

    await page.locator('input[name="username"]').fill(TEST_USER);
    await page.locator('input[name="password"]').fill(TEST_PASSWORD);
    // Keycloak 26: <button id="kc-login" type="submit">Sign In</button>
    await page.locator('#kc-login').click();

    await page.waitForURL((url) => url.host === appHost, { timeout: 15000 });
  }

  // The shell UI: a workspace in the sidebar and a session row named after the
  // shell title (e.g. "demo@axn-machine: ~").
  try {
    await page.locator('[data-tip="New workspace"]').waitFor({ state: 'visible', timeout: 15000 });
  } catch (e) {
    await page.screenshot({ path: '/tmp/login-debug.png', fullPage: true });
    console.log('DEBUG landed at:', page.url());
    console.log('DEBUG title:', await page.title());
    console.log('DEBUG body:', (await page.locator('body').innerText()).slice(0, 500));
    throw e;
  }
  await page
    .locator(`[data-tip^="workspace-"]`)
    .first()
    .waitFor({ state: 'visible', timeout: 15000 });

  // The session host is spawned on first connect — allow for a cold start.
  const deadline = Date.now() + 60000;
  let text = '';
  while (Date.now() < deadline) {
    text = await terminalText(page);
    if (text.includes('~$')) break;
    await page.waitForTimeout(250);
  }
  if (!text.includes('~$')) {
    throw new Error(`Shell prompt was not rendered. Terminal text:\n${text.slice(0, 500)}`);
  }

  return 'Shell login and WebSocket connection verified';
}
