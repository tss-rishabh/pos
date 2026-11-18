import { execFileSync, spawn } from 'node:child_process';
import { pinnedSourceEnvironment } from '../../tools/pinned-source-env.js';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';
import { cashPriceSnapshotSchema } from '../../src/modules/checkout/offline-cash/contracts.js';
import { nativeSourceCashTemplate } from '../../tools/checkout/offline-source-template-fixture.js';
import { goldenStdout } from '../golden/load.js';

const integration = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!integration)('source offline cash tax projection on native MySQL', () => {
  let connection: mysql.Connection | undefined;
  const schema = 'pos_rewrite_offline_tax_test_' + randomUUID().replaceAll('-', '').slice(0, 12);
  beforeAll(async () => {
    const url = new URL(integration!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_integration' ||
      url.search ||
      url.hash
    )
      throw new Error('Offline pricing tests require the explicit localhost fixture URL.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    const fixture = verifiedMysqlFixture(connection);
    await fixture.create(['tax_categories']);
    await fixture.insert('tax_categories', {
      id: 1,
      tax_slab_platform: 'TA',
      amt_from: 0,
      amt_to: 0.1,
      tax: 5,
    });
    await fixture.insert('tax_categories', {
      id: 2,
      tax_slab_platform: 'TA',
      amt_from: 0.2,
      amt_to: 100,
      tax: 18,
    });
    await fixture.insert('tax_categories', {
      id: 3,
      tax_slab_platform: 'TB',
      amt_from: 100.00001,
      amt_to: 2625,
      tax: 12,
    });
    await fixture.insert('tax_categories', {
      id: 4,
      tax_slab_platform: 'TC',
      amt_from: 2625.01,
      amt_to: 999999.99,
      tax: 28,
    });
  });
  afterAll(async () => {
    if (connection) {
      await connection.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });
  it('matches source numeric literals across FLOAT boundaries and all tax platforms in one read', async () => {
    const script = fileURLToPath(
      new URL(
        '../../compatibility/upstream/offline-cash-pricing/test_source_pricing.py',
        import.meta.url,
      ),
    );
    const plan = z
      .object({
        query: z.string(),
        prices: z.array(
          z.object({
            key: z.number().int(),
            amount: z.string().regex(/^\d+(?:\.\d+)?$/),
            platform: z.enum(['TA', 'TB', 'TC', 'TD']),
          }),
        ),
      })
      .parse(
        JSON.parse(
          execFileSync('python3', [script, '--tax-plan'], {
            encoding: 'utf8',
            env: {
              ...pinnedSourceEnvironment(),
              PATH: process.env.PATH,
              PYTHONDONTWRITEBYTECODE: '1',
            },
            timeout: 10_000,
          }),
        ),
      );
    const rows = z
      .array(
        z.object({
          row_id: z.number(),
          id: z.union([z.string(), z.number()]).nullable(),
          tax: z.number().nullable(),
        }),
      )
      .parse(
        (
          await connection!.execute(plan.query.replace(':prices', '?'), [
            JSON.stringify(plan.prices),
          ])
        )[0],
      );
    expect(rows).toHaveLength(44);
    for (const price of plan.prices) {
      // Both fragments are constrained by the fixture schema above. This is the
      // pinned source literal SQL, evaluated only in the isolated fixture.
      const expected = z
        .array(z.object({ id: z.union([z.string(), z.number()]), tax: z.number() }))
        .parse(
          (
            await connection!.query(
              `select id, tax from tax_categories where ${price.amount} between amt_from and amt_to and (tax_slab_platform='${price.platform}')`,
            )
          )[0],
        );
      const row = rows.find((value) => value.row_id === price.key)!;
      expect(row.id === null ? null : String(row.id)).toBe(
        expected[0] ? String(expected[0].id) : null,
      );
      expect(row.tax).toBe(expected[0]?.tax ?? null);
    }
  });
  it('executes the complete source hydration and price snapshot against verified physical tables', async () => {
    const fixture = verifiedMysqlFixture(connection!);
    await fixture.create([
      'stores',
      'store_counters',
      'products',
      'product_stocks',
      'product_store',
      'users_artists',
      'products_gs1',
      'has_categories',
      'categories',
      'has_options',
      'attributes',
    ]);
    await connection!.query('DELETE FROM tax_categories');
    await fixture.insert('tax_categories', {
      id: 1,
      tax_slab_platform: 'TA',
      amt_from: 0,
      amt_to: 1000000,
      tax: 18,
    });
    await fixture.insert('stores', { id: 1, is_active: 1, location_code: 'FIX1' });
    await fixture.insert('store_counters', { id: 2, store_id: 1, is_active: 1 });
    await fixture.insert('products', {
      id: 100,
      parent_prod_id: 0,
      product: 'Fixture parent',
      prod_type: 3,
      is_avail: 1,
      is_del: 0,
      price: '99.99',
      spl_price: '79.13',
      gst: 18,
      tax_slab_platform: 'TA',
      images: '[]',
      is_printable: 0,
    });
    await fixture.insert('products', {
      id: 101,
      parent_prod_id: 100,
      product: 'Fixture variant',
      prod_type: 2,
      is_avail: 1,
      is_del: 0,
      price: 1,
      spl_price: 0,
      gst: 5,
      tax_slab_platform: 'TB',
    });
    await fixture.insert('products', {
      id: 102,
      parent_prod_id: 0,
      product: 'Fixture standalone',
      prod_type: 1,
      is_avail: 1,
      is_del: 0,
      price: 300,
      spl_price: 400,
      gst: 18,
      tax_slab_platform: 'TA',
      images: '[]',
    });
    for (const productId of [100, 101, 102])
      await fixture.insert('product_stocks', {
        prod_id: productId,
        parent_prod_id: productId === 101 ? 100 : 0,
        stock: 100,
      });
    for (const productId of [101, 102]) {
      await fixture.insert('product_store', {
        product_id: productId,
        store_id: 1,
        stock: 50,
        is_del: 0,
        is_avail: 1,
      });
      await fixture.insert('products_gs1', {
        product_id: productId,
        gtin: String(8900000000000 + productId),
      });
    }
    await fixture.insert('categories', { id: 11, category: 'Fixture first', hsn_code: '61091000' });
    await fixture.insert('categories', { id: 9, category: 'Fixture second', hsn_code: '99999999' });
    await fixture.insert('has_categories', { id: 1, prod_id: 100, cat_id: 9 });
    await fixture.insert('has_categories', { id: 2, prod_id: 100, cat_id: 11 });
    await fixture.insert('has_categories', { id: 3, prod_id: 102, cat_id: 11 });
    await fixture.insert('attributes', { id: 1, attr: 'Size' });
    await fixture.insert('has_options', { prod_id: 101, attr_id: 1, attr_val: 'S' });
    const script = fileURLToPath(
      new URL(
        '../../compatibility/upstream/offline-cash-pricing/test_source_pricing.py',
        import.meta.url,
      ),
    );
    const child = spawn('python3', [script, '--native-snapshot'], {
      env: {
        ...pinnedSourceEnvironment(),
        PATH: process.env.PATH,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONWARNINGS: 'ignore',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    // Drain diagnostic output; never reprint source SQL/data on failure.
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill(), 15_000);
    let snapshot: unknown;
    let count = 0;
    const queryMessage = z.object({
      kind: z.literal('query'),
      query: z.string(),
      limit: z.number().int().max(25001),
      parameters: z.record(
        z.string(),
        z.union([z.string(), z.number(), z.null(), z.array(z.union([z.string(), z.number()]))]),
      ),
    });
    try {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        const message: unknown = JSON.parse(line);
        const result = z
          .object({ kind: z.literal('snapshot'), value: z.unknown() })
          .safeParse(message);
        if (result.success) {
          snapshot = result.data.value;
          continue;
        }
        const query = queryMessage.parse(message);
        expect(query.query.trimStart().startsWith('SELECT')).toBe(true);
        const parameters: (string | number | null)[] = [];
        const statement = query.query.replace(/:(\w+)/g, (_match, name: string) => {
          const value = query.parameters[name];
          if (value === undefined) throw new Error('Fixture parameter missing.');
          if (Array.isArray(value)) {
            parameters.push(...value);
            return '(' + value.map(() => '?').join(',') + ')';
          }
          parameters.push(value);
          return '?';
        });
        const rows = z
          .array(z.record(z.string(), z.unknown()))
          .parse((await connection!.query(statement, parameters))[0]);
        expect(rows.length).toBeLessThan(query.limit);
        count++;
        child.stdin.write(JSON.stringify({ rows }) + '\n');
      }
      expect(await exited).toBe(0);
      const result = cashPriceSnapshotSchema.parse(snapshot);
      expect(count).toBe(7);
      expect(result.products[0]?.name).toBe('Fixture parent');
      expect(result.products[0]?.hsn).toBe('99999999'); // First association ID, not highest category ID.
      expect(result.products[0]?.quantities[2]?.mainSubtotalCents).toBe(23739);
      expect(result.products[1]?.quantities[0]?.unitPrice).toBe('300.0');
      expect(result.products.map((product) => product.cachedStock)).toEqual([50, 50]);
      const url = new URL(integration!);
      url.pathname = '/' + schema;
      const direct = z
        .object({
          kind: z.literal('driver-snapshot'),
          value: cashPriceSnapshotSchema,
          readOnly: z.literal(1),
        })
        .parse(
          JSON.parse(
            goldenStdout(
              'checkout',
              'offline-cash-source-pricing-mysql-integration.native-driver-snapshot',
              JSON.stringify({ url: url.href }) + '\n',
              undefined,
              { placeholders: { '<fixture-database-url>': url.href } },
            ),
          ),
        );
      expect(direct.value).toEqual(result);
      const { template, receipt, receiptHash } = await nativeSourceCashTemplate(
        connection!,
        url,
        result,
      );
      expect(template.receiptHash).toBe(receiptHash);
      expect(template.receiptId).toBe(receipt.id);
      expect(template.lines).toHaveLength(4);
      expect(template.lines[0]?.price).toBe('79.13');
      expect(template.lines[0]?.normal_price).toBe('999.0');
      expect(template.header.pay_amt).toBe(String(receipt.payableCents / 100));
      expect(z.string().parse(template.header.created_at).slice(0, 10)).toBe(receipt.businessDate);
      expect(template.orderStore.is_offline_order).toBe('1');
    } finally {
      clearTimeout(timeout);
      child.kill();
      await exited;
    }
  }, 30_000);
});
