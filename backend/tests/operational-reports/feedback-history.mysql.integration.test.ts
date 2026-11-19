import { randomUUID } from 'node:crypto';
import { goldenStdout } from '../golden/load.js';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { Temporal } from '@js-temporal/polyfill';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { currentFeedbackDimensions } from '../../src/modules/operational-reports/feedback-dimensions.js';
import { feedbackFact } from '../../src/modules/operational-reports/feedback-history-contracts.js';
import {
  customerFeedbackService,
  feedbackOptions,
  type FeedbackInput,
} from '../../src/modules/operational-reports/feedback.js';
import {
  feedbackHistoryCases,
  feedbackHistoryFixture,
} from '../../tools/operational-reports/feedback-history-fixtures.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

/** Replays the pinned CPython 3.10 source oracles captured for this test (tests/golden). */
function executePosSourceOracle(args: readonly string[], options: { input?: string }): string {
  return goldenStdout('operational-reports', 'feedback-history-mysql-integration', options.input, [
    '-B',
    ...args,
  ]);
}

describe.skipIf(!process.env.MYSQL_INTEGRATION_URL)(
  'NPS history facts and current source dimensions',
  () => {
    let source: mysql.Connection | undefined,
      primary: mysql.Connection | undefined,
      authority: mysql.Connection | undefined,
      databases: Databases | undefined,
      config: ReturnType<typeof readConfig>;
    const schemas: string[] = [],
      user: Principal = {
        id: '44',
        role: 1,
        userType: 1,
        storeIds: ['1', '2', '3'],
        name: 'Fixture operator',
        email: 'operator@example.test',
      },
      clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z'),
      initial: FeedbackInput = {
        from: '2026-11-01T00:00:00',
        to: '2026-11-01T23:59:00',
        page: 1,
        pageSize: 500,
      },
      evidence: {
        name: string;
        params: Record<string, unknown>;
        expected: Record<string, unknown>;
      }[] = [],
      sourceQueries = z.object({ queries: z.array(z.string()) }).parse(
        JSON.parse(
          executePosSourceOracle(['tools/operational-reports/feedback-query-oracle.py'], {
            input: JSON.stringify(feedbackHistoryCases.map(([, input]) => input)),
            encoding: 'utf8',
            timeout: 20000,
          }),
        ) as unknown,
      ).queries;
    const db = () => {
      if (!databases) throw new Error('Fixture unavailable.');
      return databases;
    };
    beforeAll(async () => {
      const url = new URL(process.env.MYSQL_INTEGRATION_URL!);
      if (
        !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/pos_rewrite_integration'
      )
        throw new Error('GUARDED_LOCAL_NPS_DATABASE_REQUIRED');
      const connect = async (suffix: string) => {
        const connection = await mysql.createConnection({
            host: url.hostname,
            port: Number(url.port || 3306),
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            dateStrings: true,
            supportBigNumbers: true,
            bigNumberStrings: true,
          }),
          schema =
            'pos_rewrite_feedback_history_' +
            suffix +
            '_test_' +
            randomUUID().replaceAll('-', '').slice(0, 10);
        await connection.query('CREATE DATABASE ' + mysql.escapeId(schema));
        schemas.push(schema);
        await connection.changeUser({ database: schema });
        return connection;
      };
      source = await connect('facts');
      primary = await connect('primary');
      authority = await connect('authority');
      await verifiedMysqlFixture(source).create([
        'orders',
        'order_stores',
        'nps_feedback',
        'users',
        'stores',
        'nps_questions',
      ]);
      await verifiedMysqlFixture(primary).create(['users', 'stores', 'nps_questions']);
      // Production users DDL already carries the source email index (KEY `email`).
      await verifiedMysqlFixture(authority).create(['pos_user', 'user_stores', 'stores']);
      for (const connection of [source, primary]) {
        const fixture = verifiedMysqlFixture(connection);
        for (const row of feedbackHistoryFixture.users) await fixture.insert('users', { ...row });
        for (const row of feedbackHistoryFixture.stores)
          await fixture.insert('stores', { ...row, type: 'STORE' });
        for (const row of feedbackHistoryFixture.nps_questions)
          await fixture.insert('nps_questions', { ...row });
      }
      const fixture = verifiedMysqlFixture(source);
      for (const row of feedbackHistoryFixture.orders) await fixture.insert('orders', { ...row });
      for (const row of feedbackHistoryFixture.order_stores)
        await fixture.insert('order_stores', { ...row });
      for (const row of feedbackHistoryFixture.nps_feedback)
        await fixture.insert('nps_feedback', { ...row });
      const auth = verifiedMysqlFixture(authority);
      await auth.insert('pos_user', {
        id: 44,
        role: 1,
        user_type: 1,
        is_active: 1,
        username: 'fixture-operator',
      });
      for (const row of feedbackHistoryFixture.stores)
        await auth.insert('stores', { ...row, type: 'STORE' });
      const writerUrl = new URL(url);
      writerUrl.pathname = '/' + schemas[2];
      const primaryUrl = new URL(url);
      primaryUrl.pathname = '/' + schemas[1];
      config = readConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'native-feedback-history-'.repeat(4),
        MYSQL_WRITER_URL: writerUrl.href,
        MYSQL_PRIMARY_READER_URL: primaryUrl.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      });
      databases = createDatabases(config);
    }, 20000);
    beforeEach(async () => {
      await authority!.query('UPDATE pos_user SET role=1,user_type=1,is_active=1 WHERE id=44');
      await authority!.query('DELETE FROM user_stores');
      await verifiedMysqlFixture(authority!).insert('user_stores', {
        django_user_id: 44,
        store_id: 1,
      });
    });
    afterAll(async () => {
      await databases?.close();
      for (const [index, connection] of [source, primary, authority].entries()) {
        if (connection) {
          await connection.changeUser({ database: 'mysql' });
          if (schemas[index])
            await connection.query('DROP DATABASE ' + mysql.escapeId(schemas[index]!));
          await connection.end();
        }
      }
    });
    async function sourceFactResponse(params: Record<string, unknown>) {
      const args: unknown[] = [params.start, params.end],
        conditions = ['o.id>0', 'o.created_at>=?', 'o.created_at<=?'];
      for (const [all, key, column] of [
        ['allStores', 'stores', 'os.store_id'],
        ['allOrders', 'orders', 'o.id'],
        ['allCustomers', 'customers', 'o.user_id'],
      ] as const) {
        if (params[all] === false) {
          const values = z.array(z.string()).parse(params[key]);
          conditions.push(
            values.length ? column + ' IN (' + values.map(() => '?').join(',') + ')' : 'FALSE',
          );
          args.push(...values);
        }
      }
      const [rows] = await source!.query<mysql.RowDataPacket[]>(
          `SELECT CAST(o.id AS CHAR) AS orderId,CAST(o.user_id AS CHAR) AS customerId,CAST(os.store_id AS CHAR) AS associatedStoreId,CAST(nf.question_id AS CHAR) AS questionId,nf.feedback_answer AS feedback,DATE_FORMAT(nf.created_at,'%Y-%m-%d %H:%i:%s') AS feedbackDate,DATE_FORMAT(o.created_at,'%Y-%m-%d %H:%i:%s') AS orderDate FROM nps_feedback nf LEFT JOIN orders o ON o.id=nf.order_id LEFT JOIN order_stores os ON os.order_id=o.id WHERE ${conditions.join(' AND ')} ORDER BY o.id DESC,nf.id DESC,os.id DESC`,
          args,
        ),
        facts = z.array(feedbackFact).parse(rows),
        pageSize = z.number().parse(params.pageSize),
        requested = z.number().parse(params.page),
        page = requested > Math.ceil(facts.length / pageSize) ? 1 : requested;
      return {
        total: String(facts.length),
        page,
        items: facts.slice((page - 1) * pageSize, page * pageSize),
      };
    }
    function service(onQuery?: (params: Record<string, unknown>) => Promise<void>) {
      return customerFeedbackService(
        config,
        db(),
        feedbackOptions({}),
        {
          queryReport: async (_statement, params) => {
            const response = await sourceFactResponse(params);
            await onQuery?.(params);
            return [response];
          },
        },
        clock,
        { estimate: async () => 0n },
      );
    }
    for (const [index, [name, changes]] of feedbackHistoryCases.entries())
      it('matches pinned source SQL with current dimensions: ' + name, async () => {
        const input = { ...initial, ...changes },
          query = sourceQueries[index]!.replace(
            /order by o.id desc\s*$/i,
            'ORDER BY o.id DESC,nf.id DESC,os.id DESC',
          ),
          [rows] = await source!.query<mysql.RowDataPacket[]>(query),
          total = rows.length,
          page = input.page > Math.ceil(total / input.pageSize) ? 1 : input.page,
          expected = rows.slice((page - 1) * input.pageSize, page * input.pageSize).map((row) => ({
            order_id: String(row.id),
            name: row.first_name ?? null,
            email: row.email ?? null,
            telephone: row.telephone ?? null,
            feedback: row.feedback,
            question: row.question,
            store_name: row.store_name || 'Online Orders',
            feedback_date: row.feedback_date,
            order_date: row.order_date,
          }));
        let captured: Record<string, unknown> | undefined;
        const result = await service(async (params) => {
          captured = params;
        }).search(user, input);
        expect(result.total).toBe(total);
        expect(result.page).toBe(page);
        expect(result.totalPages).toBe(Math.ceil(total / input.pageSize));
        expect(result.data.map(({ storeId: _, ...row }) => row)).toEqual(expected);
        if (name === 'all-current-dimensions') {
          expect(result.total).toBe(11);
          expect(result.data.some((row) => row.question === 'Inactive question still shown')).toBe(
            true,
          );
          expect(result.data.some((row) => row.question === 'Edited current question')).toBe(true);
          expect(
            result.data.some(
              (row) =>
                row.name === null && row.email === null && row.store_name === 'Online Orders',
            ),
          ).toBe(true);
        }
        if (name === 'selected-store-multiplicity') expect(result.total).toBe(6);
        if (name === 'email-case-accent-and-padding') expect(result.total).toBe(9);
        if (captured)
          evidence.push({ name, params: captured, expected: await sourceFactResponse(captured) });
        else {
          expect(total).toBe(0);
          const dimensions = currentFeedbackDimensions(db());
          evidence.push({
            name,
            params: {
              start: '2026-11-01 00:00:00',
              end: '2026-11-01 23:59:00',
              allStores: !input.storeIds?.length,
              stores: input.storeIds?.length ? await dimensions.knownStores(input.storeIds) : [],
              allOrders: !input.orderIds?.length,
              orders: input.orderIds || [],
              allCustomers: !input.email,
              customers: input.email ? await dimensions.emailCustomers(input.email) : [],
              page: input.page,
              pageSize: input.pageSize,
            },
            expected: { total: '0', page: 1, items: [] },
          });
        }
      });
    it('uses native accent/PAD SPACE equality and leaves blocked/inactive customer dimensions visible to an authorized historical report', async () => {
      const dimensions = currentFeedbackDimensions(db());
      expect((await dimensions.emailCustomers('CAFE@example.test')).sort()).toEqual(['7', '8']);
      const [incorrectLower] = await primary!.query<mysql.RowDataPacket[]>(
        "SELECT id FROM users WHERE BINARY LOWER(email)=BINARY LOWER('cafe@example.test')",
      );
      expect(incorrectLower).toHaveLength(0);
      const rows = await dimensions.enrich([
        {
          orderId: '9007199254740993',
          customerId: '7',
          associatedStoreId: '1',
          questionId: '2',
          feedback: '9',
          feedbackDate: null,
          orderDate: '2026-11-01 00:00:00',
        },
      ]);
      expect(rows[0]).toMatchObject({
        firstName: 'Fixture Café',
        question: 'Inactive question still shown',
      });
      expect(await dimensions.emailCustomers("cafe@example.test' OR 1=1 --")).toEqual([]);
    });
    it('fails explicitly rather than truncating an email dimension wider than500 rows', async () => {
      const fixture = verifiedMysqlFixture(primary!);
      for (let index = 0; index < 501; index++)
        await fixture.insert('users', { id: 10000 + index, email: 'wide@example.test' });
      try {
        await expect(
          currentFeedbackDimensions(db()).emailCustomers('wide@example.test'),
        ).rejects.toMatchObject({ code: 'CUSTOMER_FEEDBACK_DIMENSION_TOO_WIDE' });
        await primary!.query('ANALYZE TABLE users');
        const [equality] = await primary!.query<mysql.RowDataPacket[]>(
            'EXPLAIN SELECT id FROM users WHERE email=? LIMIT 501',
            ['CAFE@example.test'],
          ),
          [functional] = await primary!.query<mysql.RowDataPacket[]>(
            'EXPLAIN SELECT id FROM users WHERE LOWER(email)=LOWER(?) LIMIT 501',
            ['CAFE@example.test'],
          ),
          plan = z.object({
            type: z.string(),
            key: z.string().nullable(),
            rows: z.coerce.number().int().nonnegative(),
          }),
          exact = plan.parse(equality[0]),
          normalized = plan.parse(functional[0]);
        expect(exact.key).toBe('email');
        expect(exact.type).toBe('ref');
        expect(exact.rows).toBeLessThan(normalized.rows);
        await mkdir('parity/evidence/feedback-history', { recursive: true });
        const file = 'parity/evidence/feedback-history/query-plan.json',
          temporary = file + '.' + randomUUID() + '.tmp';
        await writeFile(
          temporary,
          JSON.stringify(
            {
              scope: 'generated-local-fixtures-only',
              fixtureRows: 504,
              indexEvidence: 'evidence/mysql-extra-schema.json:indexes.users.email',
              nativeEquality: exact,
              functionalNormalization: normalized,
              liveDdlApplied: false,
              limitations: [
                'Optimizer row estimates from isolated local fixtures, not observed live latency.',
                'The email index already exists in verified source metadata; do not deploy duplicate DDL.',
              ],
            },
            null,
            2,
          ) + '\n',
          { mode: 0o600 },
        );
        await rename(temporary, file);
      } finally {
        await primary!.query('DELETE FROM users WHERE id>=10000');
      }
    }, 15000);
    it('rechecks writer-current assignments and role/type after external work with no fact tables on primary/authority databases', async () => {
      await authority!.query('UPDATE pos_user SET role=4 WHERE id=44');
      const operator = { ...user, role: 4 as const, storeIds: ['1'] };
      await expect(
        service(async () => {
          await authority!.query('DELETE FROM user_stores WHERE django_user_id=44');
        }).search(operator, { ...initial, storeIds: ['1'] }),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
      await authority!.query('UPDATE pos_user SET role=1,user_type=2 WHERE id=44');
      await expect(
        service().search(
          { ...user, userType: 2, storeIds: ['2'] },
          { ...initial, storeIds: ['2'] },
        ),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
      await expect(service().search(user, initial)).rejects.toMatchObject({
        code: 'OPERATOR_CHANGED',
      });
      for (const connection of [primary!, authority!]) {
        const [tables] = await connection.query<mysql.RowDataPacket[]>('SHOW TABLES');
        expect(tables.map((row) => Object.values(row)[0])).not.toContain('nps_feedback');
        expect(tables.map((row) => Object.values(row)[0])).not.toContain('orders');
      }
    });
    it('retains franchise selected-store intersection, empty selection, masks and source joined counts', async () => {
      await authority!.query('UPDATE pos_user SET role=1,user_type=2 WHERE id=44');
      const franchise = { ...user, userType: 2 as const, storeIds: ['1'] },
        result = await service().search(franchise, { ...initial, storeIds: ['1'] });
      expect(result.total).toBe(6);
      expect(
        result.data.every(
          (row) => row.order_id === '9007199254740993' || row.order_id === '9007199254740994',
        ),
      ).toBe(true);
      expect(result.data.every((row) => row.email?.includes('*'))).toBe(true);
      expect((await service().search(franchise, initial)).total).toBe(0);
    });
    it('atomically publishes only generated fixture cases for actual BigQuery SELECT comparison', async () => {
      expect(evidence).toHaveLength(feedbackHistoryCases.length);
      await mkdir('parity/evidence/feedback-history', { recursive: true });
      const file = 'parity/evidence/feedback-history/native-fixtures.json',
        temporary = file + '.' + randomUUID() + '.tmp';
      await writeFile(
        temporary,
        JSON.stringify(
          {
            source: '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
            scope: 'generated-local-fixtures-only',
            dataset: feedbackHistoryFixture,
            cases: evidence,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
      await rename(temporary, file);
    });
  },
);
