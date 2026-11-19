import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import type { FastifyServerOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { seal } from '../../src/auth/crypto.js';
import { activeAccountReader, redisSessions } from '../../src/auth/sessions.js';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import {
  verifiedMysqlFixture,
  type FixtureValue,
} from '../../tools/operational-reports/verified-mysql-fixture.js';
import { memoryRedisPort } from './memory-redis.js';
import { productionTableNames } from './production-schema.js';

/**
 * `APP_STACK_MYSQL_TEST_URL` enables the whole-application suites that replaced the demo
 * workspace. It must name the isolated loopback server and the `pos_rewrite_app_stack_test`
 * schema; each stack creates and drops its own `pos_rewrite_app_stack_<random>` schema there.
 */
export const appStackMysqlUrl = process.env.APP_STACK_MYSQL_TEST_URL;

export interface AppStackOptions {
  webOrigin?: string;
  logger?: FastifyServerOptions['logger'];
  /** Extra synthetic rows inserted after the base seed (production columns only). */
  seed?: (
    insert: (table: string, values: Record<string, FixtureValue>) => Promise<void>,
  ) => Promise<void>;
}

/**
 * The real application against a disposable loopback MySQL schema built from the production
 * snapshot (every table, production keys and indexes), with a small synthetic seed and an
 * injected in-process auth Redis. No demo services or runtime switches are involved.
 */
export async function appStack(options: AppStackOptions = {}) {
  if (!appStackMysqlUrl) throw new Error('APP_STACK_MYSQL_TEST_URL_REQUIRED');
  const url = new URL(appStackMysqlUrl);
  if (
    url.protocol !== 'mysql:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/pos_rewrite_app_stack_test' ||
    url.search ||
    url.hash
  )
    throw new Error('APP_STACK_REQUIRES_ISOLATED_LOOPBACK_MYSQL');
  const schema = 'pos_rewrite_app_stack_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const admin = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  });
  async function dropSchema() {
    await admin.changeUser({ database: 'mysql' });
    await admin.query('DROP DATABASE IF EXISTS ' + mysql.escapeId(schema));
    await admin.end();
  }
  await admin.query('CREATE DATABASE ' + mysql.escapeId(schema));
  try {
    await admin.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(admin);
    await fixture.create(productionTableNames());
    const insert = (table: string, values: Record<string, FixtureValue>) =>
      fixture.insert(table, values);
    await seedAppStack(insert);
    await options.seed?.(insert);
    url.pathname = '/' + schema;
    const webOrigin = options.webOrigin ?? 'http://localhost:5173';
    const config = readConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: webOrigin,
      SESSION_SECRET: 'synthetic-app-stack-secret-'.repeat(3),
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_DATA_READER_URL: url.href,
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      BUSINESS_TIMEZONE: 'Asia/Kolkata',
    });
    const authRedis = memoryRedisPort(),
      sessionDb = createDatabases(config),
      sessions = redisSessions(config, activeAccountReader(sessionDb), authRedis);
    const app = await buildApp(config, { logger: options.logger ?? false, authRedis });
    return {
      app,
      config,
      origin: webOrigin,
      admin,
      insert,
      /** A signed session cookie for a seeded operator, as the login flow would issue. */
      async cookie(userId: string) {
        const credential = await sessions.create(userId);
        return 'pos_session=' + seal({ id: userId, ...credential }, config.SESSION_SECRET);
      },
      async close() {
        await app.close();
        await sessionDb.close();
        await dropSchema();
      },
    };
  } catch (error) {
    await dropSchema();
    throw error;
  }
}

/** Synthetic operator 900001 (store manager of stores 1 and 2). No real people or contacts. */
export const appStackOperator = { id: '900001', name: 'Synthetic operator' } as const;

async function seedAppStack(
  insert: (table: string, values: Record<string, FixtureValue>) => Promise<void>,
) {
  await insert('pos_user', {
    id: appStackOperator.id,
    username: 'synthetic-operator',
    password: 'pbkdf2_sha256$600000$fixture$fixture',
    first_name: appStackOperator.name,
    email: 'operator@example.test',
    role: 4,
    user_type: 1,
    is_active: 1,
  });
  for (const [id, name, type] of [
    ['1', 'Synthetic Flagship', 'STORE'],
    ['2', 'Synthetic Second Store', 'STORE'],
    ['3', 'Synthetic Warehouse', 'WAREHOUSE'],
    ['4', 'Synthetic Unassigned Store', 'STORE'],
  ] as const)
    await insert('stores', {
      id,
      store_name: name,
      location_code: 'SYN-' + id,
      city_name: 'Synthetic City',
      type,
      category: 'IN_HOUSE',
      is_active: 1,
      phone: '900000000' + id,
    });
  for (const store of ['1', '2', '3'])
    await insert('user_stores', { django_user_id: appStackOperator.id, store_id: store });
  await insert('store_counters', {
    id: '1',
    store_id: '1',
    counter_name: 'Counter 01',
    is_active: 1,
  });
  for (const [id, name, price, stock, barcode] of [
    ['1001', 'Synthetic: Oversized T-shirt', '999.00', 24, '8900000001001'],
    ['1002', 'Synthetic: Utility Cargo', '1899.00', 12, '8900000001002'],
    ['1003', 'Synthetic: Crew Neck', '799.00', 0, '8900000001003'],
  ] as const) {
    await insert('products', {
      id,
      product: name,
      erp_product: 'SYN-' + id,
      parent_prod_id: 0,
      prod_type: 1,
      price,
      spl_price: '0.00',
      gst: 5,
      is_del: 0,
    });
    await insert('product_store', {
      product_id: id,
      store_id: '1',
      stock,
      is_avail: 1,
      is_del: 0,
    });
    await insert('products_gs1', { product_id: id, gtin: barcode });
  }
}
