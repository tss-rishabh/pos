import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

const localMacChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chromiumExecutable =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (process.platform === 'darwin' && existsSync(localMacChrome) ? localMacChrome : undefined);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://localhost:4173',
    ...devices['Desktop Chrome'],
    launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command:
        'npx -y node@24.22.3 ../backend/node_modules/tsx/dist/cli.mjs ../backend/src/server.ts',
      url: 'http://127.0.0.1:4410/health/live',
      env: {
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: randomBytes(32).toString('base64'),
        WEB_ORIGIN: 'http://localhost:4173',
      },
      reuseExistingServer: false,
    },
    {
      command: 'npx -y node@24.22.3 node_modules/vite/bin/vite.js preview --host 127.0.0.1',
      url: 'http://localhost:4173',
      reuseExistingServer: false,
    },
  ],
});
