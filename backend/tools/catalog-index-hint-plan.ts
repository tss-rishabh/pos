// W26: EXPLAIN the counter's in-stock page on the production-shaped loopback volume fixture
// (tools/live-readonly/seed-loopback.ts + tests/live-readonly/volume-fixture.ts), comparing the
// INDEX optimizer hint (current) with the former FORCE INDEX form, then with the index dropped.
// Loopback only. Usage: node --import tsx tools/catalog-index-hint-plan.ts mysql://root@127.0.0.1:<port>/<schema>
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { catalogService } from '../src/modules/catalog.js';
import type { Databases } from '../src/db/pools.js';
import type { Principal } from '../src/domain/access.js';

const url = new URL(process.argv[2] ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Loopback MySQL only.');
const INDEX = 'idx_store_id_stock_is_avail_is_del';
const pool = mysql.createPool({
  uri: url.href,
  supportBigNumbers: true,
  bigNumberStrings: true,
  dateStrings: true,
  timezone: 'Z',
});
const statements: { sql: string; params: unknown[] }[] = [];
const db = drizzle(pool, {
  logger: { logQuery: (sql, params) => statements.push({ sql, params }) },
});
const databases = { get: () => db, close: async () => undefined } as unknown as Databases;
const [stores] = (await pool.query(
  'SELECT store_id AS id, COUNT(*) AS n FROM product_store GROUP BY store_id ORDER BY n DESC LIMIT 1',
)) as [{ id: string; n: string }[], unknown];
const store = String(stores[0]!.id);
const user: Principal = {
  id: '1',
  name: 'Loopback',
  email: 'loopback@example.test',
  role: 1,
  userType: 1,
  storeIds: [store],
};
const service = catalogService(databases);
async function run() {
  statements.length = 0;
  const started = performance.now();
  const page = await service.products(user, store, '', '0', 20, false);
  return {
    page,
    ms: Math.round(performance.now() - started),
    statement: statements.find((s) => s.sql.includes(`INDEX(product_store ${INDEX}`))!,
  };
}
type Node = Record<string, unknown>;
function tables(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => tables(n, out));
  else if (node && typeof node === 'object') {
    const r = node as Node;
    if (r['table'] && typeof r['table'] === 'object') {
      const t = r['table'] as Node;
      out.push(
        `${t['table_name']}:${t['access_type']}:${t['key'] ?? '-'}:rows=${t['rows_examined_per_scan'] ?? '?'}`,
      );
    }
    for (const [k, v] of Object.entries(r)) if (k !== 'table') tables(v, out);
    if (r['table']) tables(r['table'], out);
  }
  return out;
}
async function explain(sql: string, params: unknown[]) {
  const [rows] = (await pool.query('EXPLAIN FORMAT=JSON ' + sql, params)) as [
    { EXPLAIN: string }[],
    unknown,
  ];
  const [warnings] = (await pool.query('SHOW WARNINGS')) as [
    { Level: string; Code: number }[],
    unknown,
  ];
  return {
    plan: tables(JSON.parse(rows[0]!.EXPLAIN)),
    warnings: warnings.map((w) => `${w.Level}:${w.Code}`),
  };
}
const forced = (sql: string) =>
  sql
    .replace(
      ` INDEX(product_store ${INDEX}) NO_INDEX_MERGE(product_store store_id, is_avail, is_del)`,
      '',
    )
    .replace(
      /(\/\*\+ JOIN_ORDER\(product_store, products\) \*\/[\s\S]*?from `product_store`)/,
      `$1 force index (${INDEX})`,
    );
const [{ n }] = (
  await pool.query(`SELECT COUNT(*) AS n FROM product_store WHERE store_id = ?`, [store])
)[0] as { n: string }[];
const a = await run();
const hinted = await explain(a.statement.sql, a.statement.params);
const before = await explain(forced(a.statement.sql), a.statement.params);
let t = performance.now();
await pool.query(forced(a.statement.sql), a.statement.params);
const forcedMs = Math.round(performance.now() - t);
await pool.query(`ALTER TABLE product_store DROP INDEX ${INDEX}`);
let dropped;
try {
  const b = await run();
  dropped = {
    ms: b.ms,
    identicalPage: JSON.stringify(b.page) === JSON.stringify(a.page),
    explain: await explain(b.statement.sql, b.statement.params),
    forceIndexError: await pool.query(forced(b.statement.sql), b.statement.params).then(
      () => 'none',
      (e: { code?: string }) => e.code,
    ),
  };
} finally {
  t = performance.now();
  await pool.query(
    `ALTER TABLE product_store ADD INDEX ${INDEX} (store_id, stock, is_avail, is_del)`,
  );
  void t;
}
console.log(
  JSON.stringify(
    {
      store,
      productStoreRowsInStore: Number(n),
      rowsOnPage: a.page.data.length,
      withIndex: {
        hintedPlan: hinted.plan,
        forceIndexPlan: before.plan,
        samePlan: JSON.stringify(hinted.plan) === JSON.stringify(before.plan),
        hintedWarnings: hinted.warnings,
        serviceMs: a.ms,
        forceIndexStatementMs: forcedMs,
      },
      withoutIndex: dropped,
    },
    null,
    1,
  ),
);
await pool.end();
