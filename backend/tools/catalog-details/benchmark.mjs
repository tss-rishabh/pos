// Creates/drops a fresh localhost-only synthetic schema. No shared database or live DDL is allowed.
import mysql from 'mysql2/promise';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import { verifiedMysqlFixture } from '../operational-reports/verified-mysql-fixture.ts';
import { catalogCountQuery, catalogPageQuery } from '../../src/modules/catalog-details/queries.ts';
import { productSearchInput } from '../../src/modules/catalog-details/contracts.ts';

const value = process.env.MYSQL_INTEGRATION_URL;
if (!value) throw new Error('MYSQL_INTEGRATION_URL is required for isolated local benchmarks.');
const url = new URL(value);
if (!['127.0.0.1', 'localhost'].includes(url.hostname))
  throw new Error('Catalog benchmark requires localhost.');
const schema = 'pos_rewrite_catalog_benchmark_' + randomUUID().replaceAll('-', '').slice(0, 12);
const connection = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  supportBigNumbers: true,
  bigNumberStrings: true,
  dateStrings: true,
});
let created = false;
try {
  await connection.query(
    `CREATE DATABASE ${mysql.escapeId(schema)} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
  );
  created = true;
  await connection.changeUser({ database: schema });
  await connection.query("SET SESSION sql_mode=REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY','')");
  await connection.query('SET SESSION cte_max_recursion_depth=50000');
  await connection.query('SET SESSION MAX_EXECUTION_TIME=15000');
  const metadata = z
    .object({
      tables: z.record(z.string(), z.array(z.object({ name: z.string().regex(/^\w+$/) }))),
      indexes: z.record(
        z.string(),
        z.array(
          z.object({
            name: z.string().regex(/^\w+$/),
            column: z.string().regex(/^\w+$/),
            position: z.number().int(),
            unique: z.boolean(),
          }),
        ),
      ),
    })
    .parse(JSON.parse(await readFile('evidence/mysql-extra-schema.json', 'utf8')));
  const tables = [
    'products',
    'product_store',
    'product_types',
    'pricelist',
    'products_gs1',
    'has_categories',
    'categories',
    'stores',
    'pos_product_inventory_logs',
  ];
  const fixture = verifiedMysqlFixture(connection);
  await fixture.create(tables);
  const restored = {};
  for (const table of tables) {
    const groups = new Map();
    for (const index of metadata.indexes[table] || []) {
      if (index.name === 'PRIMARY') continue;
      const rows = groups.get(index.name) || [];
      rows.push(index);
      groups.set(index.name, rows);
    }
    for (const [name, rows] of groups) {
      rows.sort((a, b) => a.position - b.position);
      await connection.query(
        `CREATE ${rows[0].unique ? 'UNIQUE ' : ''}INDEX ${mysql.escapeId(name)} ON ${mysql.escapeId(table)} (${rows.map((row) => mysql.escapeId(row.column)).join(',')})`,
      );
    }
    restored[table] = [...groups.keys()];
  }
  for (let id = 1; id <= 8; id++)
    await fixture.insert('stores', {
      id,
      store_name: 'Fixture store ' + id,
      type: 'STORE',
      is_active: 1,
    });
  await fixture.insert('product_types', { id: 1, type: 'Simple' });
  await fixture.insert('products', {
    id: 1,
    product: 'Fixture product 00001',
    erp_product: 'ERP 00001',
    prod_type: 1,
    parent_prod_id: 0,
    is_del: 0,
    price: '100.00',
    spl_price: '90.00',
  });
  const productColumns = metadata.tables.products.map((value) => value.name);
  await connection.query(
    `INSERT INTO products(${productColumns.map(mysql.escapeId).join(',')}) WITH RECURSIVE fixture_seq(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM fixture_seq WHERE n<2000) SELECT ${productColumns.map((name) => (name === 'id' ? 'seq.n' : name === 'product' ? "concat('Fixture product ',lpad(seq.n,5,'0'))" : name === 'erp_product' ? "concat('ERP ',lpad(seq.n,5,'0'))" : 'seed.' + mysql.escapeId(name))).join(',')} FROM products seed JOIN fixture_seq seq WHERE seed.id=1`,
  );
  await connection.query(
    'INSERT INTO product_store(product_id,store_id,stock,is_avail,is_del) SELECT p.id,s.id,3,1,0 FROM products p CROSS JOIN stores s',
  );
  await connection.query(
    'INSERT INTO pricelist(product_id,pricelist_id,location_id,price) SELECT p.id,2,s.id,80.25 FROM products p JOIN stores s ON s.id<=2',
  );
  for (let id = 1; id <= 24; id++)
    await fixture.insert('categories', {
      id,
      category: 'Fixture category ' + String(id).padStart(2, '0'),
    });
  await connection.query(
    'INSERT INTO has_categories(prod_id,cat_id) SELECT p.id,c.id FROM products p CROSS JOIN categories c',
  );
  for (const table of tables) await connection.query(`ANALYZE TABLE ${mysql.escapeId(table)}`);
  const parameters = {
    'selected_stores[]': [1, 2, 3, 4, 5, 6, 7, 8],
    'search[value]': '',
    'order[0][column]': '0',
    'order[0][dir]': 'asc',
    'columns[0][data]': 'id',
    start: 0,
    draw: 0,
    length: 25,
  };
  const source = z.object({ queries: z.array(z.string()) }).parse(
    JSON.parse(
      execFileSync('python3', ['tools/catalog-details/source-oracle.py'], {
        input: JSON.stringify({ kind: 'catalog', parameters }),
        encoding: 'utf8',
      }),
    ),
  ).queries[0];
  const input = productSearchInput.parse({
      storeIds: parameters['selected_stores[]'].map(String),
      length: 25,
    }),
    dialect = new MySqlDialect(),
    count = dialect.sqlToQuery(catalogCountQuery(input)),
    page = dialect.sqlToQuery(catalogPageQuery(input, 0));
  const baseline = (await connection.query(source))[0],
    counts = (await connection.query(count.sql, count.params))[0],
    fixed = (await connection.query(page.sql, page.params))[0];
  const fields = [
    'id',
    'product',
    'erp_product',
    'price',
    'spl_price',
    'exclusive_price',
    'prod_type',
    'categories',
    'store_names',
  ];
  const canonical = (rows) =>
    rows.map((row) =>
      Object.fromEntries(fields.map((key) => [key, key === 'id' ? String(row[key]) : row[key]])),
    );
  const hash = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  if (hash(canonical(baseline.slice(0, 25))) !== hash(canonical(fixed)))
    throw new Error('Catalog source response mismatch.');
  const sourcePlan = (await connection.query('EXPLAIN ANALYZE ' + source))[0],
    countPlan = (await connection.query('EXPLAIN ANALYZE ' + count.sql, count.params))[0],
    pagePlan = (await connection.query('EXPLAIN ANALYZE ' + page.sql, page.params))[0];
  const timings = [];
  for (let index = 0; index < 3; index++) {
    let start = performance.now();
    await connection.query(source);
    const before = performance.now() - start;
    start = performance.now();
    await connection.query(count.sql, count.params);
    await connection.query(page.sql, page.params);
    timings.push({ sourceMs: before, optimizedCountAndPageMs: performance.now() - start });
  }
  await connection.query(
    "INSERT INTO pos_product_inventory_logs(product_id,store_id,stock_before,stock_after,type,user_id,pos_user_id,comment,created_at,updated_at) WITH RECURSIVE fixture_seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture_seq WHERE n<40000) SELECT 1,mod(n,8)+1,'3','4',1,0,0,'Fixture',timestampadd(DAY,-mod(n,30),'2026-11-16 12:00:00'),'2026-11-16 12:00:00' FROM fixture_seq",
  );
  await connection.query('ANALYZE TABLE pos_product_inventory_logs');
  const audit =
    "SELECT id,stock_before,stock_after FROM pos_product_inventory_logs WHERE product_id=1 AND store_id=1 AND created_at>='2026-11-16 00:00:00' AND created_at<='2026-11-16 23:59:59' ORDER BY id ASC LIMIT 25";
  const auditCount = audit
    .replace('SELECT id,stock_before,stock_after', 'SELECT COUNT(*) as count')
    .replace(' ORDER BY id ASC LIMIT 25', '');
  const auditBefore = (await connection.query(audit))[0],
    auditBeforePlan = (await connection.query('EXPLAIN ANALYZE ' + audit))[0],
    auditCountBefore = (await connection.query(auditCount))[0],
    auditCountBeforePlan = (await connection.query('EXPLAIN ANALYZE ' + auditCount))[0];
  await connection.query(
    'CREATE INDEX ix_product_inventory_scope_date ON pos_product_inventory_logs(product_id,store_id,created_at,id)',
  );
  await connection.query('ANALYZE TABLE pos_product_inventory_logs');
  const auditAfter = (await connection.query(audit))[0],
    auditAfterPlan = (await connection.query('EXPLAIN ANALYZE ' + audit))[0],
    auditCountAfter = (await connection.query(auditCount))[0],
    auditCountAfterPlan = (await connection.query('EXPLAIN ANALYZE ' + auditCount))[0];
  if (hash(auditBefore) !== hash(auditAfter)) throw new Error('Inventory index response mismatch.');
  if (hash(auditCountBefore) !== hash(auditCountAfter))
    throw new Error('Inventory index count mismatch.');
  const output = {
    scope: 'isolated-local-synthetic',
    sourceBaseline: '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
    productCount: 2000,
    selectedStores: 8,
    categoriesPerProduct: 24,
    membershipLocationRows: 2,
    restoredIndexes: restored,
    recordsTotal: Number(counts[0].filtered_count),
    sourceDriverRows: baseline.length,
    optimizedDriverRows: fixed.length + counts.length,
    matchingResponseHash: hash(canonical(fixed)),
    responsesEqual: true,
    sourcePlan: sourcePlan.map((row) => Object.values(row)[0]),
    countPlan: countPlan.map((row) => Object.values(row)[0]),
    pagePlan: pagePlan.map((row) => Object.values(row)[0]),
    localTimings: timings,
    audit: {
      inputLogs: 40000,
      addedIndex: 'ix_product_inventory_scope_date(product_id,store_id,created_at,id)',
      matchingResponseHash: hash(auditAfter),
      responsesEqual: true,
      beforePlan: auditBeforePlan.map((row) => Object.values(row)[0]),
      afterPlan: auditAfterPlan.map((row) => Object.values(row)[0]),
      count: Number(auditCountAfter[0].count),
      countBeforePlan: auditCountBeforePlan.map((row) => Object.values(row)[0]),
      countAfterPlan: auditCountAfterPlan.map((row) => Object.values(row)[0]),
    },
    liveDatabaseReads: false,
    liveDatabaseWrites: false,
  };
  await mkdir('parity/evidence/catalog-details', { recursive: true });
  await writeFile(
    'parity/evidence/catalog-details/query-benchmark.json',
    JSON.stringify(output, null, 2) + '\n',
  );
  process.stdout.write(
    JSON.stringify({
      responsesEqual: true,
      productCount: 2000,
      sourceDriverRows: baseline.length,
      optimizedDriverRows: fixed.length + counts.length,
      auditResponsesEqual: true,
    }) + '\n',
  );
} finally {
  if (created) {
    await connection.changeUser({ database: 'mysql' });
    await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
  }
  await connection.end();
}
