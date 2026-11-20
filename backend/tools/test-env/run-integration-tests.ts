/**
 * Runs the full backend Vitest suite with every MySQL integration variable set
 * (`npm run test:integration -- [vitest args]`). Cross-platform: no shell, the same command in
 * bash, zsh and pwsh.
 *
 * - MySQL: loopback only, root without a password, from `--mysql host:port`, else
 *   `POS_TEST_MYSQL_ADDRESS`, else 127.0.0.1:33710 (the server the CI workflow starts). Every
 *   test creates and drops its own random-suffixed schema on it.
 * - Redis: Redis-backed tests start private loopback servers from `E2E_REDIS_SERVER` (Memurai on
 *   Windows) or `redis-server` on PATH; nothing shared is needed.
 * - Live services: production read-only and cloud credential variables are removed from the
 *   child environment, so no test can reach a live system from this entry point.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import {
  defaultMysqlAddress,
  fixedTestEnv,
  mysqlTestEnv,
  parseMysqlAddress,
} from './mysql-test-env.js';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
let address = process.env.POS_TEST_MYSQL_ADDRESS || defaultMysqlAddress;
const mysqlFlag = args.indexOf('--mysql');
if (mysqlFlag >= 0) {
  const value = args[mysqlFlag + 1];
  if (!value) throw new Error('--mysql needs host:port.');
  address = value;
  args.splice(mysqlFlag, 2);
}
const { host, port } = parseMysqlAddress(address);

/** Fails fast with a clear message instead of ~70 identical connection errors. */
async function checkMysql() {
  let connection: mysql.Connection | undefined;
  try {
    connection = await mysql.createConnection({ host, port, user: 'root', connectTimeout: 5000 });
    const [rows] = await connection.query('SELECT VERSION() AS version, @@GLOBAL.sql_mode AS mode');
    const [row] = rows as { version: string; mode: string }[];
    process.stdout.write(
      `Test MySQL ${host}:${port}: version ${row?.version ?? '?'}, sql_mode '${row?.mode ?? '?'}'\n`,
    );
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
    process.stderr.write(
      `Test MySQL ${host}:${port} is unreachable (${code}). Start a loopback MySQL 8.4 with ` +
        `--sql-mode='' and passwordless root, or pass --mysql host:port.\n`,
    );
    process.exit(1);
  } finally {
    await connection?.end();
  }
}

const removed = [
  /^POS_PROD_RO_/,
  /^GOOGLE_APPLICATION_CREDENTIALS$/,
  /^BQ_/,
  /^BIGQUERY_/,
  /^ORDER_SEARCH_SOURCE_ROOT$/,
  /^LEGACY_SOURCE_ROOT$/,
];

await checkMysql();
const env: NodeJS.ProcessEnv = {};
for (const [name, value] of Object.entries(process.env))
  if (!removed.some((pattern) => pattern.test(name))) env[name] = value;
Object.assign(env, mysqlTestEnv(`${host}:${port}`), fixedTestEnv);

const vitest = join(backend, 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitest)) throw new Error('Run npm ci in backend first.');
const child = spawn(process.execPath, [vitest, 'run', ...args], {
  cwd: backend,
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
