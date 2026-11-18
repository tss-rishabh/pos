import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';

if (process.versions.node.split('.')[0] !== '24')
  throw new Error('Playwright fixtures require the installed Node 24 runtime.');
// Use the same installed runtime without an npm registry download at startup.
// Keep the existing PATH spelling on Windows to avoid duplicate environment keys.
const pathVariable = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
const nodeEnvironment = {
  [pathVariable]: [dirname(process.execPath), process.env[pathVariable] ?? ''].join(delimiter),
};

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
      command: 'node ../backend/node_modules/tsx/dist/cli.mjs ../backend/src/server.ts',
      url: 'http://127.0.0.1:4410/health/live',
      env: {
        ...nodeEnvironment,
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: randomBytes(32).toString('base64'),
        WEB_ORIGIN: 'http://localhost:4173',
      },
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      env: nodeEnvironment,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
