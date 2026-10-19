import type { LinguiConfig } from '@lingui/conf';

const config: LinguiConfig = {
  sourceLocale: 'en',
  locales: ['en', 'ko'],
  catalogs: [
    {
      path: '<rootDir>/libs/shell-ui/src/locales/{locale}/messages',
      include: ['<rootDir>/libs/shell-ui/src', '<rootDir>/apps/desktop/src', '<rootDir>/apps/web/src'],
    },
  ],
};

export default config;
