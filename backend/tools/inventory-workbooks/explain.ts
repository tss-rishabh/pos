import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import {
  inventoryCandidateQuery,
  inventoryRowsQuery,
  readInventoryWorkbookPage,
} from '../../src/modules/inventory-workbooks/queries.js';
import { inventoryWorkbookFixture } from './fixture.js';

const value = process.env.INVENTORY_WORKBOOK_MYSQL_TEST_URL;
if (!value) throw new Error('Set the isolated local workbook fixture URL.');
const fixture = await inventoryWorkbookFixture(value);
try {
  await fixture.reset();
  await fixture.product('100000');
  await fixture.stock('100000');
  const metadata = z
    .object({
      tables: z.record(z.string(), z.array(z.object({ name: z.string().regex(/^[a-z0-9_]+$/) }))),
    })
    .parse(
      JSON.parse(readFileSync('evidence/mysql-inventory-workbooks-schema.json', 'utf8')) as unknown,
    );
  const columns = metadata.tables.products!.map((column) => column.name);
  await fixture.admin.query('SET SESSION cte_max_recursion_depth=6000');
  await fixture.admin.query(
    `INSERT INTO products (${columns.map((name) => mysql.escapeId(name)).join(',')}) WITH RECURSIVE sequence AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM sequence WHERE n<5000) SELECT ${columns.map((name) => (name === 'id' ? 'seed.id+sequence.n' : 'seed.' + mysql.escapeId(name))).join(',')} FROM products seed JOIN sequence WHERE seed.id=100000`,
  );
  await fixture.admin.query(
    'INSERT INTO product_store(product_id,store_id,stock,is_del,is_avail) SELECT id,CASE WHEN MOD(id,5)=0 THEN 1 ELSE 2 END,3,0,1 FROM products WHERE id>100000',
  );
  const dialect = new MySqlDialect(),
    read = () =>
      fixture.db
        .get('data')
        .transaction(
          (tx) => readInventoryWorkbookPage(tx, '1', '100000', 250, new AbortController().signal),
          { accessMode: 'read only', isolationLevel: 'repeatable read' },
        ),
    beforeRows = await read();
  async function explain() {
    const output: Record<string, unknown> = {};
    for (const [kind, statement] of [
      ['candidate', inventoryCandidateQuery('1', '100000', 250)],
      ['rows', inventoryRowsQuery('1', beforeRows.candidateIds)],
    ] as const) {
      const query = dialect.sqlToQuery(statement),
        [plan] = await fixture.admin.query<mysql.RowDataPacket[]>(
          'EXPLAIN FORMAT=JSON ' + query.sql,
          query.params,
        ),
        raw = String(plan[0]?.EXPLAIN || '');
      output[kind] = {
        sql: query.sql,
        parameterCount: query.params.length,
        sha256: createHash('sha256').update(query.sql).digest('hex'),
        plan: JSON.parse(raw) as unknown,
      };
    }
    return output;
  }
  const before = await explain();
  // Candidate only, in this fresh localhost schema. No production DDL is sent.
  await fixture.admin.query(
    'CREATE INDEX idx_workbook_store_deleted_product ON product_store(store_id,is_del,product_id)',
  );
  await fixture.admin.query('ANALYZE TABLE products,product_store');
  const after = await explain(),
    afterRows = await read();
  if (JSON.stringify(beforeRows) !== JSON.stringify(afterRows))
    throw new Error('The candidate index changed the workbook response.');
  const [version] = await fixture.admin.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version');
  const result = {
    fixtureOnly: true,
    sourceMetadata: 'evidence/mysql-inventory-workbooks-schema.json',
    metadataSha256: createHash('sha256')
      .update(readFileSync('evidence/mysql-inventory-workbooks-schema.json'))
      .digest('hex'),
    mysqlVersion: version[0]?.version,
    products: 5001,
    targetStoreCandidateRows: beforeRows.candidateIds.length,
    responseIdentical: true,
    candidate:
      'CREATE INDEX idx_workbook_store_deleted_product ON product_store(store_id,is_del,product_id)',
    before,
    after,
  };
  await writeFile(
    'parity/inventory-workbooks-query-plans.json',
    JSON.stringify(result, null, 2) + '\n',
    { mode: 0o600 },
  );
  process.stdout.write('Saved isolated workbook query plans; before/after page responses match.\n');
} finally {
  await fixture.close();
}
