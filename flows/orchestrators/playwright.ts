import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function findChromium(): string | undefined {
  // Cache root differs per OS: Linux uses ~/.cache/ms-playwright, macOS uses
  // ~/Library/Caches/ms-playwright. Try every root × executable layout.
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter((p): p is string => !!p && existsSync(p));

  // Newest build first: playwright-core only drives the browser revision it
  // ships with (or newer), and a lexical sort picked the oldest cached build —
  // with several builds cached the app never finished loading
  // (net::ERR_INSUFFICIENT_RESOURCES on Vite's dep chunks).
  const build = (name: string) => Number(name.slice('chromium-'.length)) || 0;
  const layouts = [
    join('chrome-linux64', 'chrome'),
    join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    join('chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    join('chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  ];

  for (const cache of caches) {
    const versions = readdirSync(cache)
      .filter((name) => name.startsWith('chromium-') && !name.includes('headless'))
      .sort((a, b) => build(b) - build(a));
    for (const v of versions) {
      for (const layout of layouts) {
        const exe = join(cache, v, layout);
        if (existsSync(exe)) return exe;
      }
    }
  }

  return undefined;
}

export class PlaywrightOrchestrator {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private baseUrl: string = '';

  async start(baseUrl: string, env: Record<string, string>): Promise<void> {
    this.baseUrl = baseUrl;

    const executablePath = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || findChromium();
    if (!executablePath) {
      throw new Error(
        'Could not find a Playwright Chromium executable. ' +
          'Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or ensure the default cache exists.'
      );
    }

    this.browser = await chromium.launch({ executablePath, headless: true });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });
    this.page = await this.context.newPage();
    await this.page.goto(baseUrl, { waitUntil: 'networkidle' });
  }

  async run(steps: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (!this.page) throw new Error('Orchestrator has not been started');

    const outputs: string[] = [];
    for (const stepPath of steps) {
      const mod = await import(stepPath);
      const step = mod.default;
      if (typeof step !== 'function') {
        throw new Error(`Step at ${stepPath} does not export a default function`);
      }
      const out = await step(this.page, this.baseUrl);
      if (out) outputs.push(String(out));
    }

    return { exitCode: 0, stdout: outputs.join('\n'), stderr: '' };
  }

  async stop(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }
}

export default new PlaywrightOrchestrator();
