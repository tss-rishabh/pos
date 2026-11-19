import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import {
  MUser,
  PosTerminalPaymentModes,
  SalesPerson,
  StoreSalesPerson,
} from '../../src/db/legacy-schema.js';
import { privateRedisFixture } from '../../tests/helpers/private-redis.js';
import { startFakeAdapters } from './fakes.js';
import { startOrderApiFake } from './order-api.js';
import { createE2eDatabase, e2eOperator } from './seed.js';

/**
 * Real local stack for Playwright e2e (replaces the former demo backend):
 *   - a freshly seeded synthetic schema on the loopback MySQL named by E2E_MYSQL_URL
 *     (e.g. mysql://root@127.0.0.1:33710/pos_rewrite_e2e), built from the production snapshot;
 *   - a private loopback `redis-server` on its own port and temp directory;
 *   - loopback fake HTTP endpoints for the payment adapters, and the stateful API-v2 cart/order
 *     stand-in (order-api.ts, shared with the offline-billing stack) so a web checkout creates a
 *     real order row;
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
// The verify-project browser harnesses (frontend/tests/harness) run daily reporting for real, so
// they select the production rollout default (COCO); the Playwright suite keeps the unseeded '0'.
const dayCloseRollout = process.env.E2E_DAY_CLOSE_ENABLED_STORE_IDS ?? '0';
if (!/^(?:COCO|FOFO|0|[1-9]\d{0,9}(?:,[1-9]\d{0,9}){0,20})$/.test(dayCloseRollout))
  throw new Error('E2E_DAY_CLOSE_ENABLED_STORE_IDS must be COCO, FOFO, 0 or store ids.');

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
  const connection = await mysql.createConnection({
    uri: database.url,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  cleanups.push(() => connection.end());
  await connection.query("SET SESSION sql_mode = ''");
  const db = drizzle(connection),
    seededAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  // Checkout prerequisites (as the offline-billing stack seeds them): the operator's checkout
  // account (legacy user_type 8 linked by pos_admin_id), active salespeople for both stores
  // (legacy requires one on every order) and the operator-recorded "Others" terminal mode.
  await db.insert(MUser).values({
    id: 700100n,
    firstname: 'Synthetic',
    lastname: 'operator account',
    company_name: '',
    email: 'operator-account@example.test',
    telephone: '9000000150',
    password: '',
    plain_password: '',
    birthdate: '2000-01-01',
    gender: '',
    salt: '',
    ip: '',
    status: 1,
    approved: 1,
    user_type: '8',
    pos_admin_id: BigInt(e2eOperator.id),
    profile_pic: '',
    cover_pic: '',
    mobile_cover_pic: '',
    size_chart: '',
    logo: '',
    url_key: 'synthetic-operator-account',
  });
  await db.insert(SalesPerson).values(
    (
      [
        [810001n, 'SYN-SP-1', 'Riya'],
        [810002n, 'SYN-SP-2', 'Kabir'],
      ] as const
    ).map(([id, employee, first]) => ({
      id,
      employee_id: employee,
      first_name: first,
      last_name: 'Synthetic',
      email: '',
      phone: '',
      is_active: 1,
      user_type: 1,
      created_at: seededAt,
      updated_at: seededAt,
    })),
  );
  await db
    .insert(StoreSalesPerson)
    .values(
      [1n, 2n].flatMap((store) =>
        [810001n, 810002n].map((salesperson) => ({ salesperson, store, is_active: 1 })),
      ),
    );
  await db
    .insert(PosTerminalPaymentModes)
    .values({ name: 'Others', mode_id: 1001, is_active: 1, platform: 'OTHERS' });
  const orders = await startOrderApiFake(connection, timeZone);
  cleanups.push(() => orders.close());
  log(`order API stand-in at ${orders.apiBase}`);
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
    DAY_CLOSE_ENABLED_STORE_IDS: dayCloseRollout,
    // Every spec drives the backend from one loopback client IP; the default per-IP budget
    // (240/min) is sized for one counter, not a whole suite back to back.
    API_RATE_LIMIT_PER_MINUTE: '20000',
    LOGIN_OTP_DELIVERY: 'sandbox',
    LOGIN_FIXED_OTP_ENABLED: '1',
    LOGIN_FIXED_OTP: e2eOperator.otp,
    LOGIN_FIXED_OTP_USER_IDS: e2eOperator.id,
    TSS_API_BASE_URL: orders.apiBase,
    TSS_PAYMENT_ORDER_URL: orders.paymentOrderUrl,
    TSS_JWT_HS256_KEY: randomBytes(32).toString('hex'),
    TSS_JWT_HS512_KEY: randomBytes(32).toString('hex'),
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
