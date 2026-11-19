import { defineConfig } from '@playwright/test';
import { delimiter, dirname } from 'node:path';
import { desktopControl, desktopPorts, desktopWorkspace } from './e2e-desktop/ports';

if (process.versions.node.split('.')[0] !== '24')
  throw new Error('Playwright fixtures require the installed Node 24 runtime.');
const pathVariable =
  Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
const nodeEnvironment = {
  [pathVariable]: [dirname(process.execPath), process.env[pathVariable] ?? ''].join(delimiter),
};
// Isolated loopback MySQL; the stack seeds and drops its own pos_rewrite_e2e_offline schema.
const e2eMysqlUrl = process.env.E2E_MYSQL_URL ?? '';
if (!e2eMysqlUrl) throw new Error('Set E2E_MYSQL_URL to an isolated loopback MySQL server.');

/**
 * Desktop (Electron) offline-billing e2e on the real stack (W17). The stack
 * (backend/tools/e2e/offline-billing-stack.ts) runs the real backend and the web origin behind TCP
 * gates, so a spec can cut and restore the device's network (the renderer then runs from its
 * service-worker shell, as on a store device without internet), and exposes a loopback control API (4499 by default; see e2e-desktop/ports.ts). Build first: `npm run build`.
 */
export default defineConfig({
  testDir: 'e2e-desktop',
  fullyParallel: false,
  workers: 1,
  timeout: 300000,
  expect: { timeout: 15000 },
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    {
      command: 'node --import tsx tools/e2e/offline-billing-stack.ts',
      cwd: '../backend',
      url: `${desktopControl}/ready`,
      timeout: 180000,
      env: {
        ...nodeEnvironment,
        E2E_MYSQL_URL: e2eMysqlUrl,
        E2E_WEB_ORIGIN: desktopWorkspace,
        E2E_WEB_PORT: String(desktopPorts.web),
        E2E_WEB_PRIVATE_PORT: String(desktopPorts.webPrivate),
        E2E_BACKEND_PORT: String(desktopPorts.backend),
        E2E_BACKEND_PRIVATE_PORT: String(desktopPorts.backendPrivate),
        E2E_CONTROL_PORT: String(desktopPorts.control),
      },
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 20000 },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // On a private port: the stack gates the public web origin in front of it.
      command: `node node_modules/vite/bin/vite.js preview --config e2e-desktop/vite.preview.config.ts --host 127.0.0.1 --port ${desktopPorts.webPrivate} --strictPort`,
      url: `http://127.0.0.1:${desktopPorts.webPrivate}`,
      env: nodeEnvironment,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
