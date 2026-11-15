import '../src/styles.css';
import './web-sources.css';
import { useEffect } from 'react';
import type { Preview } from '@storybook/react-vite';
import {
  applyTheme,
  defaultThemeId,
  getTheme,
  themeDefinitions,
} from '../../../libs/shell-ui/src/themes';

const preview: Preview = {
  parameters: {
    layout: 'padded',
  },
  globalTypes: {
    theme: {
      name: 'Theme',
      description: 'Application theme',
      defaultValue: defaultThemeId,
      toolbar: {
        icon: 'paintbrush',
        items: themeDefinitions.map((t) => ({ value: t.id, title: t.name })),
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      const themeId = (context.globals.theme as string | undefined) ?? defaultThemeId;
      useEffect(() => {
        applyTheme(getTheme(themeId));
      }, [themeId]);
      return (
        <div
          style={{
            background: 'var(--bg)',
            color: 'var(--text-primary)',
            minHeight: '100vh',
            padding: '16px',
            margin: '-16px',
          }}
        >
          <Story />
        </div>
      );
    },
  ],
};

export default preview;
