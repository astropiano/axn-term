import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';
import App from './app/App';
import { SettingsProvider, perfMark } from '@axn-term/shell-ui';
import { desktopPlatform, loadUserThemes } from './app/platform';
import { initTitlebar } from './app/titlebar';
import './styles.css';

perfMark('main_eval');
// Perf trace only: what the page loaded during startup — any request to an
// outside host (fonts, CDNs) delays first paint and fails offline.
if ((globalThis as { __AXN_PERF__?: unknown }).__AXN_PERF__) {
  setTimeout(() => {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const external = [
      ...new Set(
        entries
          .map((e) => new URL(e.name, location.href))
          .filter((u) => /^https?:$/.test(u.protocol) && u.hostname !== location.hostname)
          .map((u) => u.origin),
      ),
    ];
    perfMark('resources', JSON.stringify({ count: entries.length, external }));
  }, 3000);
}

initTitlebar();

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);

root.render(
  <StrictMode>
    <SettingsProvider configStore={desktopPlatform.configStore} loadUserThemes={loadUserThemes}>
      <App />
    </SettingsProvider>
  </StrictMode>,
);
