import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';

if (process.versions.node.split('.')[0] !== '24')
  throw new Error('Playwright fixtures require the installed Node 24 runtime.');
// Use the same installed runtime without an npm registry download at startup.
// Keep the existing PATH spelling on Windows to avoid duplicate environment keys.
const pathVariable =
  Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
const nodeEnvironment = {
  [pathVariable]: [dirname(process.execPath), process.env[pathVariable] ?? ''].join(delimiter),
};

// Isolated loopback MySQL that the e2e stack seeds (schema pos_rewrite_e2e*); never a shared server.
const e2eMysqlUrl = process.env.E2E_MYSQL_URL ?? '';
if (!e2eMysqlUrl) throw new Error('Set E2E_MYSQL_URL to an isolated loopback MySQL server.');

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
      // Real stack (backend/tools/e2e/stack.ts): seeded loopback MySQL schema from the production
      // snapshot, a private loopback redis-server, loopback fake adapters and the real backend.
      command: 'node --import tsx tools/e2e/stack.ts',
      cwd: '../backend',
      url: 'http://127.0.0.1:4410/health/ready',
      timeout: 120000,
      env: {
        ...nodeEnvironment,
        E2E_MYSQL_URL: e2eMysqlUrl,
        E2E_WEB_ORIGIN: 'http://localhost:4173',
      },
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 20000 },
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
