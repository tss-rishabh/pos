// Synthetic isolated local benchmark only; never connect this tool to a shared database.
import mysql from 'mysql2/promise';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { verifiedMysqlFixture } from './verified-mysql-fixture.ts';
const value = process.env.MYSQL_INTEGRATION_URL;
if (!value) throw new Error('MYSQL_INTEGRATION_URL is required for local synthetic fixtures.');
const url = new URL(value);
if (!['127.0.0.1', 'localhost'].includes(url.hostname))
  throw new Error('This benchmark requires local MySQL.');
const schema = 'pos_rewrite_flag_benchmark_' + randomUUID().replaceAll('-', '').slice(0, 12),
  connection = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
let created = false;
try {
  await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
  created = true;
  await connection.changeUser({ database: schema });
  await verifiedMysqlFixture(connection).create(['flag_history']);
  const metadata = z
      .object({
        indexes: z.record(
          z.string(),
          z.array(
            z.object({
              name: z.string().regex(/^\w+$/),
              column: z.string().regex(/^\w+$/),
              position: z.number().int().positive(),
              unique: z.boolean(),
            }),
          ),
        ),
      })
      .parse(JSON.parse(await readFile('evidence/mysql-extra-schema.json', 'utf8'))),
    groups = new Map();
  for (const entry of metadata.indexes.flag_history || []) {
    if (entry.name === 'PRIMARY') continue;
    const rows = groups.get(entry.name) || [];
    rows.push(entry);
    groups.set(entry.name, rows);
  }
  for (const [name, rows] of groups) {
    rows.sort((a, b) => a.position - b.position);
    await connection.query(
      `CREATE ${rows[0].unique ? 'UNIQUE ' : ''}INDEX ${mysql.escapeId(name)} ON flag_history (${rows.map((row) => mysql.escapeId(row.column)).join(',')})`,
    );
  }
  for (let batch = 0; batch < 20; batch++) {
    const values = [];
    for (let index = batch * 1000; index < (batch + 1) * 1000; index++) {
      const order = Math.floor(index / 20) + 1,
        flag = index % 20;
      values.push([
        order,
        order % 7 === 0 && flag === 18 ? 19 : flag,
        '',
        0,
        '2026-11-16 00:00:00',
        '2026-11-16 00:00:00',
      ]);
    }
    await connection.query(
      'INSERT INTO flag_history(order_id,flag_id,f_comment,user_id,created_at,updated_at) VALUES ?',
      [values],
    );
  }
  await connection.query('CREATE TABLE fixture_orders(id BIGINT PRIMARY KEY)');
  await connection.query('INSERT INTO fixture_orders(id) VALUES ?', [
    Array.from({ length: 50 }, (_, index) => [index + 1]),
  ]);
  await connection.query('ANALYZE TABLE flag_history');
  const before =
      'SELECT o.id,(SELECT COUNT(*) FROM flag_history f WHERE f.order_id=o.id AND f.flag_id=18)>0 AS is_app FROM fixture_orders o ORDER BY o.id',
    after =
      'SELECT o.id,EXISTS(SELECT 1 FROM flag_history f WHERE f.order_id=o.id AND f.flag_id=18) AS is_app FROM fixture_orders o ORDER BY o.id',
    baseline = (await connection.query(before))[0],
    baselinePlan = (await connection.query('EXPLAIN ANALYZE ' + before))[0];
  await connection.query(
    'CREATE INDEX ix_flag_history_order_flag ON flag_history(order_id,flag_id)',
  );
  await connection.query('ANALYZE TABLE flag_history');
  const fixed = (await connection.query(after))[0],
    fixedPlan = (await connection.query('EXPLAIN ANALYZE ' + after))[0],
    hash = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  if (hash(baseline) !== hash(fixed)) throw new Error('Synthetic flag-query response mismatch.');
  const result = {
    scope: 'isolated-local-synthetic',
    inputFlags: 20000,
    selectedOrders: 50,
    existingIndexes: [...groups.keys()],
    addedIndex: 'ix_flag_history_order_flag(order_id,flag_id)',
    matchingResponseHash: hash(fixed),
    responsesEqual: true,
    appOrders: fixed.filter((row) => row.is_app === 1).length,
    beforePlan: baselinePlan.map((row) => Object.values(row)[0]),
    afterPlan: fixedPlan.map((row) => Object.values(row)[0]),
    liveDatabaseReads: false,
    liveDatabaseWrites: false,
  };
  await mkdir('parity/evidence/operational-reports', { recursive: true });
  await writeFile(
    'parity/evidence/operational-reports/flag-query.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  process.stdout.write(
    JSON.stringify({
      responsesEqual: true,
      inputFlags: 20000,
      selectedOrders: 50,
      appOrders: result.appOrders,
    }) + '\n',
  );
} finally {
  if (created) {
    await connection.changeUser({ database: 'mysql' });
    await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
  }
  await connection.end();
}
