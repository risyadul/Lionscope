import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: `${root}test-results/ui`,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  timeout: 30_000,
  reporter: [['list'], ['html', { outputFolder: `${root}playwright-report`, open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4178',
    browserName: 'chromium',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'mouse-light', use: { viewport: { width: 1440, height: 900 }, colorScheme: 'light' } },
    { name: 'mouse-dark', use: { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' } },
    {
      name: 'phone-light',
      use: { viewport: { width: 430, height: 932 }, colorScheme: 'light', hasTouch: true, isMobile: true },
    },
    {
      name: 'phone-dark',
      use: { viewport: { width: 320, height: 740 }, colorScheme: 'dark', hasTouch: true, isMobile: true },
    },
    {
      name: 'tablet-touch',
      use: { viewport: { width: 768, height: 1024 }, colorScheme: 'light', hasTouch: true, isMobile: true },
    },
    {
      name: 'wide-touch',
      use: { viewport: { width: 1440, height: 900 }, colorScheme: 'dark', hasTouch: true },
    },
  ],
  webServer: {
    command: 'npx vite --config dashboard/browser/vite.config.ts',
    cwd: root,
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
  },
});
