import { Temporal } from '@js-temporal/polyfill';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import Fastify from 'fastify';
import { AppError } from '../../src/domain/errors.js';
import type { Principal } from '../../src/domain/access.js';
import { dashboardService, registerDashboard } from '../../src/modules/dashboard/index.js';
import { dashboardAuthority } from '../../src/modules/dashboard/authority.js';
import { currentDashboardQuery, dailyDashboardQuery } from '../../src/modules/dashboard/queries.js';
import { readDashboardOptions } from '../../src/modules/dashboard/options.js';
import { dashboardFixture } from '../../tools/dashboard/fixture.js';
import { goldenSpawnResult } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

const connection = process.env.DASHBOARD_MYSQL_TEST_URL;
const now = Temporal.Instant.from('2026-06-15T06:30:00Z');
const user: Principal = {
  id: '900001',
  name: 'Synthetic operator',
  email: 'fixture@example.invalid',
  role: 4,
  userType: 1,
  storeIds: ['1', '2', '9007199254740993'],
};
const oracleSchema = z.object({
  djangoVersion: z.literal('4.2.5'),
  sourceHash: z.string(),
  queries: z.array(z.string()),
  decoratorHash: z.string(),
  permissions: z.record(z.string(), z.string()),
  monthProjections: z.array(z.array(z.string()).length(12)),
  cases: z.array(
    z.object({
      store_count: z.string(),
      user_count: z.string(),
      store_product_count: z.string(),
      order_count: z.string(),
      graph_data: z.object({
        months: z.array(z.string()),
        dataset_list: z.array(
          z.object({ name: z.string().nullable(), data: z.array(z.string()).length(12) }),
        ),
      }),
    }),
  ),
});

describe.skipIf(!connection)('source dashboard on isolated verified MySQL', () => {
  let fixture: Awaited<ReturnType<typeof dashboardFixture>>;
  beforeAll(async () => {
    fixture = await dashboardFixture(connection!);
  }, 20000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    await fixture.reset();
  });

  async function source(
    golden: 'source-counts' | 'orphan-association' | 'zero-date-association' | 'month-overwrite',
    cases: { operatorId: string; role: number }[],
    groupCases: { year: number; month: number; count: string }[][] = [],
  ) {
    const result = goldenSpawnResult(
      'dashboard',
      'service-mysql.' + golden,
      JSON.stringify({ database: fixture.url, now: now.toString(), cases, groupCases }),
      undefined,
      fixturePlaceholders(fixture.url),
    );
    if (result.status !== 0)
      throw new Error('Pinned dashboard oracle failed: ' + result.stdout.slice(0, 500));
    return oracleSchema.parse(JSON.parse(result.stdout) as unknown);
  }

  async function seedOrders() {
    for (const [id, date, status] of [
      ['101', '2024-02-01 00:00:00', 1],
      ['102', '2026-01-02 00:00:00', 1],
      ['103', '2026-06-15 00:00:00', 1],
      ['104', '2026-06-15 23:59:59', 0],
      ['105', '2026-06-15 12:00:00', 3],
      ['106', '2027-02-01 00:00:00', 2],
      ['107', '2026-06-16 00:00:00', 1],
      ['108', '2026-01-03 00:00:00', 1],
      ['109', '2026-03-01 00:00:00', 99],
    ] as const)
      await fixture.order(id, date, status);
    for (const [id, order, store] of [
      ['1', '101', '1'],
      ['2', '102', '1'],
      ['3', '102', '1'],
      ['4', '103', '1'],
      ['5', '104', '1'],
      ['6', '105', '2'],
      ['7', '106', '1'],
      ['8', '107', '1'],
      ['9', '108', '3'],
      ['10', '109', '1'],
      ['9007199254740993', '103', '9007199254740993'],
    ])
      await fixture.association(id!, order!, store!);
  }

  it('matches the actual pinned source counts and scoped monthly groups without filtering parent-association flags', async () => {
    for (const id of ['11', '12', '13', '15', '9007199254740993'])
      await fixture.product(id, id === '15' ? { prod_type: 2, is_avail: 0, is_del: 1 } : {});
    await fixture.product('14', { parent_prod_id: '11' });
    await fixture.stock('11');
    await fixture.stock('11', '2');
    await fixture.stock('12', '2', { is_del: 1, is_avail: 0, stock: -2 });
    await fixture.stock('14');
    await fixture.stock('15');
    await fixture.stock('9007199254740993');
    await fixture.stock('999');
    await seedOrders();
    const oracle = await source('source-counts', [
      { operatorId: user.id, role: 4 },
      { operatorId: '900002', role: 1 },
    ]);
    const current = await dashboardService(fixture.config, fixture.db, readDashboardOptions({}), {
      clock: () => now,
    }).overview(user);
    const sourceCurrent = oracle.cases[0]!;
    expect(oracle.permissions).toEqual({ '1': 'allowed', '2': 'blocked:shortcut_dashboard' });
    expect([current.activeStores, current.activeOperators, current.parentProducts]).toEqual([
      sourceCurrent.store_count,
      sourceCurrent.user_count,
      sourceCurrent.store_product_count,
    ]);
    expect(current.parentProducts).toBe('4');
    expect(current.stores.map((row) => row.id)).toEqual(['1', '9007199254740993']);
    expect(sourceCurrent.order_count).toBe('9');
    const scope = await dashboardAuthority(fixture.db, user);
    const query = sql`SELECT CAST(store_id AS CHAR) AS store_id,YEAR(created_at) AS year,MONTH(created_at) AS month,CAST(COUNT(*) AS CHAR) AS order_count FROM order_stores JOIN orders ON orders.id=order_stores.order_id WHERE store_id IN (1,9007199254740993) AND order_status<>0 AND created_at>='2026-01-01 00:00:00' GROUP BY store_id,YEAR(created_at),MONTH(created_at)`;
    const [rows] = await fixture.db.get('data').execute(query);
    const { monthlyRow, monthlySeries } = await import('../../src/modules/dashboard/domain.js');
    const projected = monthlySeries(scope.graphStores, z.array(monthlyRow).parse(rows), 2026);
    expect(projected.map((row) => ({ name: row.name, data: row.counts }))).toEqual(
      sourceCurrent.graph_data.dataset_list,
    );
    expect(oracle.cases[1]!.order_count).toBe('9');
    expect(oracle.cases[1]!.graph_data.dataset_list.map((row) => row.name)).toEqual([
      'Store 1',
      'Store 3',
      'Store 9007199254740993',
    ]);
    expect(
      oracle.queries.some((query) => query.includes('COUNT') && query.includes('order_stores')),
    ).toBe(true);
  }, 30000);

  it('routes current counts to primary and only the explicit current-day association slice to data', async () => {
    await seedOrders();
    const readers: string[] = [],
      db = {
        ...fixture.db,
        get: (name: Parameters<typeof fixture.db.get>[0]) => {
          readers.push(name);
          return fixture.db.get(name);
        },
      };
    const service = dashboardService(fixture.config, db, readDashboardOptions({}), {
      clock: () => now,
    });
    expect((await service.overview(user)).reader).toBe('primary');
    expect(readers).toEqual(['writer', 'primary', 'writer']);
    readers.length = 0;
    const today = await service.today(user);
    expect(today).toMatchObject({
      reader: 'data',
      businessDate: '2026-06-15',
      orderAssociations: '3',
    });
    expect(readers).toEqual(['writer', 'data', 'writer']);
    const dialect = new MySqlDialect(),
      query = dialect.sqlToQuery(
        dailyDashboardQuery(['9007199254740993'], '2026-06-15 00:00:00', '2026-06-16 00:00:00'),
      );
    expect(query.params[0]).toBe(9007199254740993n);
    expect(query.sql).not.toContain('9007199254740993');
  });

  it('pins the source handling of a physically possible orphan association', async () => {
    await fixture.association('1', '999999', '1');
    const original = await source('orphan-association', [{ operatorId: user.id, role: 4 }]);
    expect(original.cases[0]!.order_count).toBe('0');
  }, 30000);

  it('keeps source zero-date associations in all-history totals while excluding them from month/day series', async () => {
    await fixture.order('201', '0000-00-00 00:00:00');
    await fixture.association('1', '201');
    const original = await source('zero-date-association', [{ operatorId: user.id, role: 4 }]);
    expect(original.cases[0]!.order_count).toBe('1');
    expect(
      original.cases[0]!.graph_data.dataset_list.every((store) =>
        store.data.every((count) => count === '0'),
      ),
    ).toBe(true);
    expect(
      (
        await dashboardService(fixture.config, fixture.db, readDashboardOptions({}), {
          clock: () => now,
        }).today(user)
      ).orderAssociations,
    ).toBe('0');
  }, 30000);

  it('executes the literal source month overwrite in both row orders and refuses its non-unique output', async () => {
    const current = { year: 2026, month: 1, count: '2' },
      future = { year: 2027, month: 1, count: '3' };
    const original = await source(
      'month-overwrite',
      [],
      [
        [current, future],
        [future, current],
      ],
    );
    expect(original.monthProjections.map((row) => row[0])).toEqual(['3', '2']);
    const { monthlySeries } = await import('../../src/modules/dashboard/domain.js');
    for (const values of [
      [current, future],
      [future, current],
    ])
      expect(() =>
        monthlySeries(
          [{ id: '1', name: 'Synthetic store' }],
          values.map((row) => ({
            store_id: '1',
            year: row.year,
            month: row.month,
            order_count: row.count,
          })),
          2026,
        ),
      ).toThrowError(expect.objectContaining({ code: 'DASHBOARD_MONTH_AMBIGUOUS' }));
  }, 30000);

  it('uses current writer role and assignments instead of browser claims; source type2 metric access is refused', async () => {
    const forged = { ...user, role: 1 as const, storeIds: ['3'] };
    expect((await dashboardAuthority(fixture.db, forged)).orderStoreIds).toEqual([
      '1',
      '2',
      '9007199254740993',
    ]);
    await fixture.admin.query('UPDATE pos_user SET user_type=2,role=1 WHERE id=900001');
    await expect(dashboardAuthority(fixture.db, forged)).rejects.toMatchObject({
      status: 403,
      code: 'DASHBOARD_ACCESS_DENIED',
    });
    await expect(
      dashboardAuthority(fixture.db, { ...forged, id: '900003', userType: 2 }),
    ).rejects.toMatchObject({ status: 403 });
    await fixture.admin.query('UPDATE pos_user SET is_active=0 WHERE id=900001');
    await expect(dashboardAuthority(fixture.db, user)).rejects.toMatchObject({ status: 401 });
  });

  it('retains inactive assignments for source totals and active stores only for graph; writer role1 gets current active stores', async () => {
    const assigned = await dashboardAuthority(fixture.db, user);
    expect(assigned.orderStoreIds).toEqual(['1', '2', '9007199254740993']);
    expect(assigned.graphStores.map((store) => store.id)).toEqual(['1', '9007199254740993']);
    const global = await dashboardAuthority(fixture.db, { ...user, id: '900002', role: 1 });
    expect(global.orderStoreIds).toEqual(['1', '3', '9007199254740993']);
    await fixture.admin.query('DELETE FROM user_stores WHERE django_user_id=900001');
    expect((await dashboardAuthority(fixture.db, user)).orderStoreIds).toEqual([]);
  });

  it('does not fall back to any MySQL history read when publication is absent', async () => {
    const readers: string[] = [],
      db = {
        ...fixture.db,
        get: (name: Parameters<typeof fixture.db.get>[0]) => {
          readers.push(name);
          return fixture.db.get(name);
        },
      };
    await expect(
      dashboardService(fixture.config, db, readDashboardOptions({}), { clock: () => now }).history(
        user,
      ),
    ).rejects.toMatchObject({ status: 503, code: 'DASHBOARD_PUBLICATION_UNAVAILABLE' });
    expect(readers).toEqual(['writer']);
  });

  it('rejects history that completed after assignment or authentication-epoch changes', async () => {
    const result = {
      reader: 'bigquery' as const,
      asOf: now.toString(),
      generationId: 'ed4fc837-7a4a-4c5e-a8da-13c8702dd05d',
      contract: 'pos-dashboard-orders-v1' as const,
      year: 2026,
      orderAssociations: '0',
      months: [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ] as const,
      series: [],
    };
    for (const mutation of [
      'DELETE FROM user_stores WHERE django_user_id=900001 AND store_id=2',
      "INSERT INTO pos_rewrite_operator_auth_epochs(operator_id,epoch) VALUES('900001',1)",
    ]) {
      await fixture.reset();
      const service = dashboardService(fixture.config, fixture.db, readDashboardOptions({}), {
        clock: () => now,
        history: {
          async read() {
            await fixture.admin.query(mutation);
            return result;
          },
        },
      });
      await expect(service.history(user)).rejects.toMatchObject({
        status: 409,
        code: 'DASHBOARD_SCOPE_CHANGED',
      });
    }
  });

  it('keeps the optimized distinct-parent result identical and records an executable MySQL plan', async () => {
    for (let id = 1; id <= 40; id++) {
      await fixture.product(String(id));
      for (const store of ['1', '2', '3']) await fixture.stock(String(id), store);
    }
    const [actual] = await fixture.db.get('data').execute(currentDashboardQuery());
    const [original] = await fixture.admin.query<import('mysql2/promise').RowDataPacket[]>(
      'SELECT COUNT(DISTINCT ps.product_id) AS parent_products FROM product_store ps JOIN products p ON p.id=ps.product_id WHERE p.parent_prod_id=0',
    );
    expect(
      z.array(z.object({ parent_products: z.coerce.string() })).parse(actual)[0]?.parent_products,
    ).toBe(String(original[0]?.parent_products));
    const plan = await fixture.db
      .get('data')
      .execute(sql`EXPLAIN FORMAT=JSON ${currentDashboardQuery()}`);
    expect(JSON.stringify(plan[0])).toContain('product_store');
  });

  it('serves all three traced, private HTTP resources and rejects unknown filter input and unauthenticated/type2 callers', async () => {
    const app = Fastify({ logger: false }),
      traces: unknown[] = [];
    app.decorateRequest('principal', null);
    app.addHook('onRoute', (route) => {
      traces.push(route.config?.trace);
    });
    app.addHook('onRequest', async (request) => {
      if (request.headers['x-fixture-user'] === 'internal') request.principal = user;
      if (request.headers['x-fixture-user'] === 'franchise')
        request.principal = { ...user, id: '900003', role: 1, userType: 2 };
    });
    app.setErrorHandler((error, _request, reply) => {
      const status =
        error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500;
      void reply.code(status).send({
        error: {
          code: error instanceof AppError ? error.code : 'INVALID_REQUEST',
          message: 'Fixture request failed.',
        },
      });
    });
    registerDashboard(app, fixture.config, fixture.db, readDashboardOptions({}));
    try {
      const current = await app.inject({
        url: '/api/v1/dashboard/overview',
        headers: { 'x-fixture-user': 'internal' },
      });
      expect(current.statusCode).toBe(200);
      expect(current.headers['cache-control']).toBe('private, no-store');
      expect(current.json()).toMatchObject({
        reader: 'primary',
        activeStores: '3',
        activeOperators: '3',
        parentProducts: '0',
      });
      expect(
        (
          await app.inject({
            url: '/api/v1/dashboard/orders/today',
            headers: { 'x-fixture-user': 'internal' },
          })
        ).statusCode,
      ).toBe(200);
      const history = await app.inject({
        url: '/api/v1/dashboard/orders/history',
        headers: { 'x-fixture-user': 'internal' },
      });
      expect(history.statusCode).toBe(503);
      expect(history.json()).toMatchObject({
        error: { code: 'DASHBOARD_PUBLICATION_UNAVAILABLE' },
      });
      expect(
        (
          await app.inject({
            url: '/api/v1/dashboard/overview?search=ignored',
            headers: { 'x-fixture-user': 'internal' },
          })
        ).statusCode,
      ).toBe(400);
      expect((await app.inject({ url: '/api/v1/dashboard/overview' })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            url: '/api/v1/dashboard/overview',
            headers: { 'x-fixture-user': 'franchise' },
          })
        ).statusCode,
      ).toBe(403);
      expect(traces).toHaveLength(6);
      expect(
        traces.every(
          (trace) =>
            z
              .object({
                module: z.literal('dashboard'),
                resource: z.enum(['current-summary', 'daily-orders', 'order-history']),
                action: z.literal('read'),
              })
              .safeParse(trace).success,
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
