import Fastify from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { inventoryAuditService } from '../../src/modules/catalog-details/audit.js';
import {
  auditSearchInput,
  catalogDetailOptions,
} from '../../src/modules/catalog-details/contracts.js';
import { catalogDetailsService } from '../../src/modules/catalog-details/service.js';
import { catalogSnapshotService } from '../../src/modules/catalog-details/snapshot.js';
import { registerCatalogDetails } from '../../src/modules/catalog-details/index.js';
import { memoryEphemeralStore } from '../../src/jobs/ephemeral.js';
const config = readConfig({
  NODE_ENV: 'test',
  MYSQL_PRIMARY_READER_URL: 'mysql://127.0.0.1:1/unused',
  SESSION_SECRET: 'catalog-router-fixture-'.repeat(3),
});
const user: Principal = {
  id: '1',
  name: 'Fixture',
  email: 'fixture@example.test',
  role: 1,
  userType: 2,
  storeIds: ['1'],
};
const clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z');
const input = () =>
  auditSearchInput.parse({
    storeIds: ['1'],
    from: '2026-11-15T00:00:00',
    to: '2026-11-16T23:59:59',
    search: 'Café%_"',
    sort: 'product',
    direction: 'desc',
    start: 999,
    length: 25,
  });
const maintenanceRoutes = [
  { method: 'GET' as const, url: '/api/v1/catalog/maintenance/capabilities' },
  { method: 'GET' as const, url: '/api/v1/catalog/inventory-pulls/sample' },
  {
    method: 'POST' as const,
    url: '/api/v1/catalog/inventory-pulls',
    payload: { input: { mode: 'manual', skus: '20' } },
  },
  { method: 'POST' as const, url: '/api/v1/catalog/products/20/troubleshooting', payload: {} },
];
describe('catalog read boundaries and private input validation', () => {
  it('uses one historical source with bound search and explicit source collation/sort contracts', async () => {
    const get = vi.fn(() => {
        throw new Error('Historical audit must not read MySQL.');
      }),
      db: Databases = { get, close: async () => {} };
    const queryReport = vi.fn(
      async (
        statement: string,
        _params: Record<string, unknown>,
        _types: Record<string, string | string[]>,
        _resource?: string,
      ) =>
        statement.includes('COUNT(*)')
          ? [{ unfiltered_count: 2, filtered_count: 1 }]
          : [
              {
                id: '9007199254740993',
                store_id: '1',
                store_name: 'Fixture',
                storage_name: null,
                product_id: '20',
                product: 'Café',
                erp_product: null,
                stock_before: '3',
                stock_after: '7',
                user: 'Fixture operator',
                comment: 'Fixture',
                created_at: '2026-11-15 12:00:00',
              },
            ],
    );
    const options = catalogDetailOptions({
      BQ_PRODUCT_INVENTORY_AUDIT_VIEW: 'source-project.pos.product_audit',
      BQ_INVENTORY_AUDIT_LIKE_UDF: 'source-project.pos.mysql_like',
    });
    const result = await inventoryAuditService(config, db, options, { queryReport }, clock).search(
      user,
      '20',
      'product',
      input(),
    );
    expect(result).toMatchObject({
      reader: 'bigquery',
      recordsTotal: 1,
      recordsFiltered: 1,
      unfilteredCount: 2,
      start: 0,
    });
    expect(result.data[0]).toMatchObject({ id: '9007199254740993', added_reduced: 4 });
    expect(get).not.toHaveBeenCalled();
    expect(queryReport).toHaveBeenCalledTimes(2);
    for (const [statement, params, types, resource] of queryReport.mock.calls) {
      expect(statement).not.toContain('Café');
      expect(statement).toContain('`source-project.pos.mysql_like`');
      expect(params).toMatchObject({ product: '20', stores: ['1'], search: "%Café%_'%" });
      expect(types).toMatchObject({ product: 'STRING', stores: ['STRING'], search: 'STRING' });
      expect(resource).toBe('catalog-inventory-audit');
    }
    expect(queryReport.mock.calls[1]?.[0]).toContain('ORDER BY product_sort_key DESC');
    expect(queryReport.mock.calls[1]?.[1]).toMatchObject({ offset: 0, limit: 25 });
  });
  it('fails closed for missing history contracts and denied stores before touching a database', async () => {
    const get = vi.fn(() => {
        throw new Error('No database allowed.');
      }),
      db: Databases = { get, close: async () => {} },
      queryReport = vi.fn(async () => []);
    await expect(
      inventoryAuditService(config, db, {}, { queryReport }, clock).search(
        user,
        '20',
        'product',
        input(),
      ),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      inventoryAuditService(
        config,
        db,
        { BQ_PRODUCT_INVENTORY_AUDIT_VIEW: 'source-project.pos.audit' },
        { queryReport },
        clock,
      ).search(user, '20', 'product', input()),
    ).rejects.toMatchObject({ status: 503 });
    const forbidden = { ...input(), storeIds: ['2'] };
    await expect(
      inventoryAuditService(config, db, {}, { queryReport }, clock).search(
        user,
        '20',
        'held',
        forbidden,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(catalogSnapshotService(db).read(user, '2')).rejects.toMatchObject({ status: 403 });
    await expect(
      inventoryAuditService(config, db, {}, { queryReport }, clock).search(
        { ...user, userType: 1, role: 3 },
        '20',
        'storage',
        forbidden,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      catalogDetailsService(config, db).search(user, {
        storeIds: ['2'],
        search: '',
        start: 0,
        length: 25,
        draw: 0,
        sort: 'id',
        direction: 'asc',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(get).not.toHaveBeenCalled();
    expect(queryReport).not.toHaveBeenCalled();
    expect(() =>
      catalogDetailOptions({ BQ_PRODUCT_INVENTORY_AUDIT_VIEW: 'project.dataset.view; DROP' }),
    ).toThrow();
  });
  it('registers only authenticated traced resource routes and rejects malformed bodies before DB work', async () => {
    const get = vi.fn(() => {
        throw new Error('No database allowed.');
      }),
      db: Databases = { get, close: async () => {} },
      app = Fastify();
    const traces: unknown[] = [];
    app.addHook('onRoute', (route) => {
      if (route.method !== 'HEAD')
        traces.push(
          z
            .object({
              module: z.literal('catalog-details'),
              resource: z.string().regex(/^[a-z-]+$/),
              action: z.string().regex(/^[a-z-]+$/),
            })
            .parse(route.config?.trace),
        );
    });
    app.decorateRequest('principal', null);
    app.addHook('preHandler', async (request) => {
      request.principal =
        request.headers['x-fixture-anonymous'] === 'true'
          ? null
          : {
              ...user,
              userType: request.headers['x-fixture-internal'] === 'true' ? 1 : 2,
            };
    });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError)
        return reply.code(error.status).send({ error: { code: error.code } });
      return reply.code(400).send({ error: { code: 'INVALID_INPUT' } });
    });
    await registerCatalogDetails(app, config, db, { ephemeral: memoryEphemeralStore() });
    for (const route of [
      { method: 'GET' as const, url: '/api/v1/catalog/stores' },
      { method: 'POST' as const, url: '/api/v1/catalog/inventory/search', payload: {} },
      { method: 'GET' as const, url: '/api/v1/catalog/inventory/stores' },
      { method: 'POST' as const, url: '/api/v1/catalog/products/search', payload: {} },
      { method: 'GET' as const, url: '/api/v1/catalog/products/20' },
      {
        method: 'POST' as const,
        url: '/api/v1/catalog/products/20/audits/product/search',
        payload: input(),
      },
      { method: 'GET' as const, url: '/api/v1/catalog/stores/1/snapshot' },
      ...maintenanceRoutes,
    ]) {
      const response = await app.inject({ ...route, headers: { 'x-fixture-anonymous': 'true' } });
      expect(response.statusCode).toBe(401);
    }
    expect(traces).toHaveLength(11);
    // Legacy InventorySyncView/AjaxTroubleshootProductView require only a signed-in operator.
    const capabilities = await app.inject(maintenanceRoutes[0]!);
    expect(capabilities.json()).toEqual({
      inventoryPullEnabled: false,
      troubleshootingEnabled: false,
    });
    const sample = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/inventory-pulls/sample',
    });
    expect(sample.statusCode).toBe(200);
    expect(sample.body).toBe('sku\n');
    expect(sample.headers['cache-control']).toBe('no-store');
    const invalidTroubleshoot = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/products/20/troubleshooting',
      payload: 'false',
      headers: { 'content-type': 'application/json' },
    });
    expect(invalidTroubleshoot.statusCode).toBe(400);
    const catalog = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/products/search',
      payload: { storeIds: ['1'], sort: 'price;select(1)' },
    });
    expect(catalog.statusCode).toBe(400);
    const audit = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/products/20/audits/product/search',
      payload: { ...input(), from: 'not-a-date' },
    });
    expect(audit.statusCode).toBe(400);
    const denied = await app.inject({ method: 'GET', url: '/api/v1/catalog/stores/2/snapshot' });
    expect(denied.statusCode).toBe(403);
    expect(get).not.toHaveBeenCalled();
    await app.close();
  });
});
