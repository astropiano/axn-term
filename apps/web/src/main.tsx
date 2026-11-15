import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';
import { SettingsProvider } from '@axn-term/shell-ui';
import { loadServerConfig } from './app/serverConfig';
import './styles.css';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement,
);

// Server addresses are resolved before the app module loads: App and the
// Keycloak client read serverConfig() at module level.
void loadServerConfig().then(async () => {
  const { default: App } = await import('./app/App');
  root.render(
    <StrictMode>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </StrictMode>,
  );
});
