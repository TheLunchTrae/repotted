import { defineConfig } from '@playwright/test';

// Each project is a touch screen the web app must fit. Chromium comes from
// `playwright install chromium`, or from the path in CHROMIUM_PATH, for a
// machine that has its own.
const screens = {
  phone: { width: 375, height: 667 },
  'large-phone': { width: 390, height: 844 },
  'phone-landscape': { width: 667, height: 375 },
  tablet: { width: 768, height: 1024 },
};
const executablePath = process.env['CHROMIUM_PATH'];

// eslint-disable-next-line standards/no-default-export -- Playwright reads the config from the module's default export
export default defineConfig({
  outputDir: '../../../../artifacts/web-layout',
  forbidOnly: process.env['CI'] !== undefined,
  use: {
    // layout.spec.ts serves the app at this address from memory; nothing reaches the network.
    baseURL: 'https://repotted.test',
    isMobile: true,
    hasTouch: true,
    screenshot: 'only-on-failure',
    ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
  },
  projects: Object.entries(screens).map(([name, viewport]) => ({ name, use: { viewport } })),
});
