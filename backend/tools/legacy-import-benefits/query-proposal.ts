import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { and, eq, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  importCouponUsers,
  importCouponLogs,
} from '../../src/modules/legacy-order-imports/benefit-profile/schema.js';
import {
  couponUserHashSql,
  couponLogHashSql,
} from '../../src/modules/legacy-order-imports/benefit-profile/native.js';

/** Review evidence only. Narrow query columns/indexes match saved metadata;
 * every table/row/DDL below belongs to a new disposable localhost schema. */
export async function explainBenefitQueryProposal(template: string) {
  const url = new URL(template);
  if (
    url.protocol !== 'mysql:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !['/pos_rewrite_checkout_test', '/pos_rewrite_integration'].includes(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error('BENEFIT_QUERY_FIXTURE_REQUIRED');
  const connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
    }),
    schema = 'pos_benefit_query_' + randomUUID().replaceAll('-', ''),
    table = mysql.escapeId(schema);
  let created = false;
  try {
    await connection.query('CREATE DATABASE ' + table);
    created = true;
    await connection.changeUser({ database: schema });
    await connection.query(
      'CREATE TABLE coupons_users(id BIGINT NOT NULL PRIMARY KEY,c_id BIGINT NOT NULL,user_id BIGINT NOT NULL,coupon_allowed_count BIGINT NOT NULL,coupon_used_count BIGINT NOT NULL,coupon_month_allowed_count BIGINT NOT NULL,INDEX user_id(user_id),INDEX c_id(c_id)) ENGINE=InnoDB',
    );
    await connection.query(
      'CREATE TABLE order_coupon_log(id INT NOT NULL PRIMARY KEY,user_id BIGINT NOT NULL,order_id BIGINT NOT NULL,coupon_id BIGINT NOT NULL,status INT NOT NULL,created_at DATETIME,updated_at DATETIME) ENGINE=InnoDB',
    );
    for (let offset = 0; offset < 20000; offset += 1000) {
      const users: (string | number)[][] = [],
        logs: (string | number)[][] = [];
      for (let n = offset + 1; n <= offset + 1000; n++) {
        users.push([
          String(9007199254740992n + BigInt(n)),
          n % 3 === 0 ? 222 : 223,
          n % 100,
          5,
          0,
          5,
        ]);
        logs.push([
          n,
          77,
          n >= 19999 ? 5001 : n === 12345 ? 5002 : 100000 + n,
          222,
          1,
          '2026-06-15 12:00:00',
          '2026-06-15 12:00:00',
        ]);
      }
      await connection.query('INSERT INTO coupons_users VALUES ?', [users]);
      await connection.query('INSERT INTO order_coupon_log VALUES ?', [logs]);
    }
    await connection.query('ANALYZE TABLE coupons_users,order_coupon_log');
    const db = drizzle(connection),
      user = db
        .select({
          id: importCouponUsers.id,
          used: importCouponUsers.used,
          allowed: importCouponUsers.allowed,
          monthlyAllowed: importCouponUsers.monthlyAllowed,
          inputHash: sql<string>`${sql.raw(couponUserHashSql)}`,
        })
        .from(importCouponUsers)
        .where(and(eq(importCouponUsers.customerId, 77n), eq(importCouponUsers.couponId, 222n)))
        .orderBy(asc(importCouponUsers.id))
        .limit(1001)
        .for('update')
        .toSQL(),
      logs = (order: string) =>
        db
          .select({
            id: importCouponLogs.id,
            customerId: importCouponLogs.customerId,
            couponId: importCouponLogs.couponId,
            status: importCouponLogs.status,
            hash: sql<string>`${sql.raw(couponLogHashSql)}`,
          })
          .from(importCouponLogs)
          .where(eq(importCouponLogs.orderId, BigInt(order)))
          .orderBy(asc(importCouponLogs.id))
          .limit(2)
          .for('update')
          .toSQL();
    async function run(statement: typeof user) {
      const [rows] = await connection.query(statement.sql, statement.params);
      return rows;
    }
    async function plan(statement: typeof user) {
      const [rows] = await connection.query('EXPLAIN ' + statement.sql, statement.params),
        value = z
          .array(
            z.object({
              type: z.string(),
              key: z.string().nullable(),
              rows: z.union([z.number(), z.string()]),
            }),
          )
          .parse(rows)[0];
      if (!value) throw new Error('BENEFIT_QUERY_PLAN_INVALID');
      const [execution] = await connection.query(
          'EXPLAIN ANALYZE ' + statement.sql,
          statement.params,
        ),
        text = z
          .array(z.object({ EXPLAIN: z.string() }))
          .parse(execution)
          .map((row) => row.EXPLAIN)
          .join('\n'),
        scanned = [...text.matchAll(/\(actual time=[^)]*? rows=([\d.e+-]+) loops=\d+\)/g)].map(
          (match) => Number(match[1]),
        );
      if (!scanned.length || scanned.some((value) => !Number.isFinite(value) || value < 0))
        throw new Error('BENEFIT_QUERY_PLAN_INVALID');
      return {
        access: value.type,
        index: value.key,
        estimatedRows: Number(value.rows),
        maximumPlanRows: Math.max(...scanned),
      };
    }
    const beforeRows = [await run(user), await run(logs('5002')), await run(logs('5001'))],
      before = { assignments: await plan(user), logs: await plan(logs('5002')) };
    await connection.query(
      'CREATE INDEX ix_coupons_users_user_coupon_id ON coupons_users(user_id,c_id,id)',
    );
    await connection.query(
      'CREATE INDEX ix_order_coupon_log_order_id ON order_coupon_log(order_id,id)',
    );
    await connection.query('ANALYZE TABLE coupons_users,order_coupon_log');
    const afterRows = [await run(user), await run(logs('5002')), await run(logs('5001'))],
      after = { assignments: await plan(user), logs: await plan(logs('5002')) },
      responsesEqual = JSON.stringify(beforeRows) === JSON.stringify(afterRows);
    if (!responsesEqual) throw new Error('BENEFIT_QUERY_RESPONSE_CHANGED');
    const counts = z
      .array(z.array(z.unknown()))
      .parse(afterRows)
      .map((rows) => rows.length);
    return {
      fixtureRowsPerTable: 20000,
      responsesEqual,
      matchedRows: { assignments: counts[0]!, singleLog: counts[1]!, duplicateLogs: counts[2]! },
      responseHash: createHash('sha256').update(JSON.stringify(afterRows)).digest('hex'),
      before,
      after,
    };
  } finally {
    if (created) await connection.query('DROP DATABASE ' + table);
    await connection.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requestId = randomUUID(),
    event = {
      module: 'legacy-order-imports',
      resource: 'benefit-query-proposal',
      requestId,
      userId: null,
      eventInstanceId: randomUUID(),
    };
  try {
    const input = process.env.CHECKOUT_MYSQL_TEST_URL;
    if (!input) throw new Error('BENEFIT_QUERY_FIXTURE_REQUIRED');
    process.stdout.write(
      JSON.stringify({
        ...event,
        eventId: 'legacy-order-imports.benefit-query-proposal.completed',
        result: await explainBenefitQueryProposal(input),
      }) + '\n',
    );
  } catch {
    process.stderr.write(
      JSON.stringify({
        ...event,
        eventId: 'legacy-order-imports.benefit-query-proposal.failed',
        code: 'BENEFIT_QUERY_PROPOSAL_FAILED',
      }) + '\n',
    );
    process.exitCode = 1;
  }
}
