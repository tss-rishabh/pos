import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateRedisFixture } from '../../tests/helpers/private-redis.js';
import { startFakeAdapters } from './fakes.js';
import { createE2eDatabase, e2eOperator } from './seed.js';

/**
 * Real local stack for Playwright e2e (replaces the former demo backend):
 *   - a freshly seeded synthetic schema on the loopback MySQL named by E2E_MYSQL_URL
 *     (e.g. mysql://root@127.0.0.1:33710/pos_rewrite_e2e), built from the production snapshot;
 *   - a private loopback `redis-server` on its own port and temp directory;
 *   - loopback fake HTTP endpoints for the API-v2 and payment adapters;
 *   - the real backend (`src/server.ts`) with NODE_ENV=test.
 * Login OTP SMS/email and login Slack alerts use the in-process sandbox transport
 * (LOGIN_OTP_DELIVERY=sandbox) because their live adapters only accept HTTPS endpoints; the
 * synthetic operator signs in with the legacy fixed-OTP setting (LOGIN_FIXED_OTP_*).
 * SIGTERM/SIGINT stop the backend, Redis and fakes and drop the seeded schema.
 */
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = process.env.E2E_BACKEND_PORT ?? '4410',
  webOrigin = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:4173',
  timeZone = 'Asia/Kolkata';

const log = (message: string) => process.stdout.write(`[e2e-stack] ${message}\n`);
const cleanups: (() => Promise<void>)[] = [];
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => log('cleanup step failed'));
  process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const)
  process.on(signal, () => void stop(0));

try {
  const database = await createE2eDatabase(process.env.E2E_MYSQL_URL, timeZone);
  cleanups.push(() => database.drop());
  log(`seeded ${new URL(database.url).pathname.slice(1)}`);
  const redis = await privateRedisFixture();
  cleanups.push(() => redis.close());
  log('redis-server ready');
  const fakes = await startFakeAdapters();
  cleanups.push(() => fakes.close());
  log(`fake adapters at ${fakes.origin}`);

  // Built from scratch: never inherit a developer .env or live credentials.
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    TZ: process.env.TZ ?? 'UTC',
    HOST: '127.0.0.1',
    PORT: port,
    WEB_ORIGIN: webOrigin,
    SESSION_SECRET: randomBytes(32).toString('base64'),
    BUSINESS_TIMEZONE: timeZone,
    MYSQL_WRITER_URL: database.url,
    MYSQL_PRIMARY_READER_URL: database.url,
    MYSQL_DATA_READER_URL: database.url,
    MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
    REDIS_URL: redis.url,
    // Legacy day-close rollout limited to a store id that is not seeded: the blocking
    // "Day close pending" reminder is not under test here and would cover the workspace.
    // The same rollout also gates daily reporting, so that resource answers 403 here.
    DAY_CLOSE_ENABLED_STORE_IDS: '0',
    LOGIN_OTP_DELIVERY: 'sandbox',
    LOGIN_FIXED_OTP_ENABLED: '1',
    LOGIN_FIXED_OTP: e2eOperator.otp,
    LOGIN_FIXED_OTP_USER_IDS: e2eOperator.id,
    TSS_API_BASE_URL: fakes.url('api-v2'),
    TSS_PAYMENT_ORDER_URL: fakes.url('payments') + 'order',
    TSS_PINELABS_BASE_URL: fakes.url('payments') + 'pinelabs/',
    TSS_PAYTM_BASE_URL: fakes.url('payments') + 'paytm/',
  };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT'])
    if (process.env[name]) environment[name] = process.env[name];
  const server: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', resolve(backend, 'src/server.ts')],
    { cwd: backend, env: environment, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  cleanups.push(async () => {
    if (server.exitCode !== null) return;
    const exited = new Promise<void>((done) => server.once('exit', () => done()));
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 8000);
    await exited;
    clearTimeout(timer);
  });
  server.once('exit', (code) => {
    if (!stopping) {
      log(`backend exited (${code ?? 'signal'})`);
      void stop(1);
    }
  });
  log(`backend starting on 127.0.0.1:${port}`);
} catch (error) {
  log(`startup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  await stop(1);
}
