import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';
import App from './app/App';
import { SettingsProvider } from '@axn-term/shell-ui';
import { desktopPlatform, loadUserThemes } from './app/platform';
import { initTitlebar } from './app/titlebar';
import './styles.css';

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
