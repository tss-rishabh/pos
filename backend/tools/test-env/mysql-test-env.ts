/**
 * The single source of truth for the backend integration-test environment.
 *
 * Every MySQL-backed backend test is gated on one environment variable and guards on an exact
 * template database name; it then creates its own random-suffixed schema on that server, so the
 * template databases themselves never need to exist. This map names every variable and its
 * required database. Loopback root without a password only: never put real credentials here.
 *
 * Usage:
 *   node --import tsx tools/test-env/mysql-test-env.ts [--mysql 127.0.0.1:33710] [--format json|dotenv]
 * `tools/test-env/run-integration-tests.ts` (npm run test:integration) applies the same map.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Variable -> template database the test (or its fixture helper) requires. */
export const mysqlTestDatabases = {
  MYSQL_INTEGRATION_URL: 'pos_rewrite_integration',
  AUTH_MYSQL_TEST_URL: 'pos_rewrite_auth_test',
  ADMINISTRATION_MYSQL_TEST_URL: 'pos_rewrite_administration_test',
  ADMINISTRATION_CREATOR_MYSQL_URL: 'pos_rewrite_creator_authority_test',
  ADMINISTRATION_HISTORY_MYSQL_TEST_URL: 'pos_rewrite_administration_history_test',
  APPLICATION_LINK_MYSQL_TEST_URL: 'pos_rewrite_application_links_test',
  APP_STACK_MYSQL_TEST_URL: 'pos_rewrite_app_stack_test',
  BARCODE_ASSIGNMENTS_MYSQL_TEST_URL: 'pos_rewrite_barcodes_test',
  CHECKOUT_MYSQL_TEST_URL: 'pos_rewrite_checkout_test',
  CUSTOMER_OTP_MYSQL_TEST_URL: 'pos_rewrite_customer_otp_test',
  CUSTOMER_PROFILE_MYSQL_TEST_URL: 'pos_rewrite_customer_profile_test',
  DASHBOARD_MYSQL_TEST_URL: 'pos_rewrite_dashboard_test',
  GIFT_CARD_BATCH_MYSQL_TEST_URL: 'pos_rewrite_gift_card_batches_test',
  GLOBAL_VOUCHERS_MYSQL_TEST_URL: 'pos_rewrite_global_vouchers_test',
  INVENTORY_JOBS_MYSQL_TEST_URL: 'pos_rewrite_inventory_jobs_test',
  MODEL_ACCOUNTS_MYSQL_TEST_URL: 'pos_rewrite_model_accounts_test',
  OFFLINE_SYNC_MYSQL_TEST_URL: 'pos_rewrite_offline_sync_test',
  ORDER_HISTORY_MYSQL_TEST_URL: 'pos_rewrite_order_history_test',
  ORDER_SEARCH_MYSQL_TEST_URL: 'pos_rewrite_order_search_test',
  SPECIAL_PERMISSION_MYSQL_TEST_URL: 'pos_rewrite_activity_history_test',
  STORE_DEFAULT_OPERATORS_MYSQL_URL: 'pos_rewrite_store_defaults_test',
  WHOLE_ORDER_STATUS_MYSQL_TEST_URL: 'pos_rewrite_whole_status_test',
} as const;

export type MysqlTestVariable = keyof typeof mysqlTestDatabases;

/** The CI default: the loopback MySQL 8.4 that `.github/workflows/desktop-platforms.yml` starts. */
export const defaultMysqlAddress = '127.0.0.1:33710';

export function parseMysqlAddress(address: string): { host: string; port: number } {
  const match = /^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(address.trim());
  const port = match ? Number(match[2]) : NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('The test MySQL address must be loopback host:port, e.g. 127.0.0.1:33710.');
  // Several fixtures require 127.0.0.1 with an explicit port (TCP, never the default socket).
  return { host: '127.0.0.1', port };
}

/** Every integration variable for the loopback server at `address` (root, no password). */
export function mysqlTestEnv(address: string = defaultMysqlAddress): Record<string, string> {
  const { host, port } = parseMysqlAddress(address);
  const env: Record<string, string> = {};
  for (const [name, database] of Object.entries(mysqlTestDatabases))
    env[name] = `mysql://root@${host}:${port}/${database}`;
  return env;
}

/** Fixed process settings the suite is verified under on every platform. */
export const fixedTestEnv = { NODE_ENV: 'test', TZ: 'UTC' } as const;

function main(argv: string[]) {
  let address = process.env.POS_TEST_MYSQL_ADDRESS || defaultMysqlAddress;
  let format = 'dotenv';
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--mysql' && value) address = value;
    else if (flag === '--format' && (value === 'json' || value === 'dotenv')) format = value;
    else throw new Error('Usage: mysql-test-env.ts [--mysql host:port] [--format json|dotenv]');
    index++;
  }
  const env = { ...mysqlTestEnv(address), ...fixedTestEnv };
  process.stdout.write(
    format === 'json'
      ? JSON.stringify(env, null, 2) + '\n'
      : Object.entries(env)
          .map(([name, value]) => `${name}=${value}`)
          .join('\n') + '\n',
  );
}

/** True when this module is the process entry point (case-insensitive paths on Windows). */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const [self, invoked] = [fileURLToPath(moduleUrl), resolve(entry)];
  return process.platform === 'win32'
    ? self.toLowerCase() === invoked.toLowerCase()
    : self === invoked;
}

if (isEntryPoint(import.meta.url)) main(process.argv.slice(2));
