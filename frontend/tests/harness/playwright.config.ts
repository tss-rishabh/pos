import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';
import { harnessPorts } from './ports';
import { harnessDatabaseUrl } from './support';

/**
 * verify-project browser harnesses (order search, order history, daily reports) on the real e2e
 * stack (backend/tools/e2e/stack.ts): seeded loopback MySQL schema, private redis-server, fake
 * adapters, the real backend, and the built web app served by `vite preview`, on their own ports
 * (ports.ts) so the Playwright suite or a parallel stack on 4410/4173 cannot collide (run
 * `npm run build` first; verify-project builds before its browser checks). Each harness adds its
 * own synthetic rows with backend/tools/e2e/harness-fixtures.ts. Unlike the Playwright suite, the
 * stack keeps the production day-close rollout default (COCO) so daily reporting runs for real.
 *
 * Run one harness: `npx playwright test -c tests/harness/playwright.config.ts order-search/`.
 */
if (process.versions.node.split('.')[0] !== '24')
  throw new Error('Playwright fixtures require the installed Node 24 runtime.');
// One harness per invocation: each owns its stack, and the fixture sets are mutually exclusive
// (the report rows would change the order-search counts). Workers re-load this file; skip there.
const harnessDirectories = ['order-search/', 'order-history/', 'reports/'];
if (
  process.env.TEST_WORKER_INDEX === undefined &&
  process.argv.filter((value) => harnessDirectories.includes(value)).length !== 1
)
  throw new Error(`Run exactly one harness: ${harnessDirectories.join(', ')}.`);
const pathVariable =
  Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
const nodeEnvironment = {
  [pathVariable]: [dirname(process.execPath), process.env[pathVariable] ?? ''].join(delimiter),
};
const localMacChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chromiumExecutable =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (process.platform === 'darwin' && existsSync(localMacChrome) ? localMacChrome : undefined);

export default defineConfig({
  testDir: '..',
  testMatch: ['order-search/*.harness.ts', 'order-history/*.harness.ts', 'reports/*.harness.ts'],
  // Outside the verifier's checksummed inputs (frontend/tests is one of them).
  outputDir: '../../test-results/harness',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${harnessPorts.web}`,
    ...devices['Desktop Chrome'],
    launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : {},
    // These harnesses own their API traffic; offline shell behaviour has separate worker tests.
    serviceWorkers: 'block',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node --import tsx tools/e2e/stack.ts',
      cwd: '../../../backend',
      url: `http://127.0.0.1:${harnessPorts.backend}/health/ready`,
      timeout: 120000,
      env: {
        ...nodeEnvironment,
        E2E_MYSQL_URL: harnessDatabaseUrl(),
        E2E_WEB_ORIGIN: `http://localhost:${harnessPorts.web}`,
        E2E_BACKEND_PORT: String(harnessPorts.backend),
        E2E_DAY_CLOSE_ENABLED_STORE_IDS: 'COCO',
      },
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 20000 },
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node node_modules/vite/bin/vite.js preview --config tests/harness/vite.config.ts',
      cwd: '../..',
      url: `http://127.0.0.1:${harnessPorts.web}`,
      env: nodeEnvironment,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
