import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../../src/domain/access.js';
import { availableSystemStockProjection } from '../../../src/db/stock-projection/service.js';
import { ecommerceInventorySynchronization } from '../../../src/modules/administration/ecommerce-sync/service.js';
import { readEcommerceSynchronizationOptions } from '../../../src/modules/administration/ecommerce-sync/options.js';
import {
  fullSyncContract,
  fullSyncHash,
  type FullSyncAdapter,
  type FullSyncCommand,
  type FullSyncResult,
} from '../../../src/modules/administration/ecommerce-sync/domain.js';
import { settingsService } from '../../../src/modules/administration/settings.js';
import { settingsOutbox } from '../../../src/modules/administration/settings-outbox.js';
import {
  settingVersion,
  type SettingsEffectDelivery,
} from '../../../src/modules/administration/settings-domain.js';
import { ecommerceFixture } from '../../../tools/administration/ecommerce-sync/fixture.js';
import { goldenSpawnResult } from '../../golden/load.js';
import { fixturePlaceholders } from '../../golden/fixture-placeholders.js';
const connection = process.env.ECOMMERCE_SYNC_MYSQL_TEST_URL;
const user: Principal = {
  id: '900001',
  name: 'Synthetic actor',
  email: 'fixture@example.invalid',
  role: 1,
  userType: 1,
  storeIds: [],
};
const oracleSchema = z.object({
  calls: z.array(
    z.object({
      storeId: z.string(),
      productId: z.string(),
      stock: z.number(),
      operatorId: z.literal('0'),
      comment: z.literal('Updated by System'),
    }),
  ),
  http: z.array(z.object({ url: z.string(), status: z.number() })),
  errors: z.array(z.string()),
});
describe.skipIf(!connection)('ecommerce stock refresh through the existing settings outbox', () => {
  let fixture: Awaited<ReturnType<typeof ecommerceFixture>>;
  beforeAll(async () => {
    fixture = await ecommerceFixture(connection!);
  }, 20000);
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const options = (batch = 25, max = 50000) =>
    readEcommerceSynchronizationOptions({
      ECOMMERCE_SYNC_BATCH_SIZE: String(batch),
      ECOMMERCE_SYNC_MAX_PRODUCTS: String(max),
    });
  function remote(status: FullSyncResult['status'] = 'succeeded') {
    const submitted: FullSyncCommand[] = [],
      read: FullSyncCommand[] = [];
    const result = (command: FullSyncCommand): FullSyncResult => ({
      contract: fullSyncContract,
      operationId: command.operationId,
      requestHash: fullSyncHash(command),
      status,
      proof:
        status === 'succeeded'
          ? { mongoWrites: 20, redisWrites: 20, cdnBatches: 1, catalogDigest: 'a'.repeat(64) }
          : null,
      errorCode: status === 'failed' ? 'FULL_SYNC_FAILED' : null,
    });
    const adapter: FullSyncAdapter = {
      submit: async (command) => {
        submitted.push(command);
        return result(command);
      },
      read: async (command) => {
        read.push(command);
        return result(command);
      },
    };
    return { adapter, submitted, read, result };
  }
  function processor(adapter: FullSyncAdapter, batch = 25, max = 50000) {
    return ecommerceInventorySynchronization(fixture.config, fixture.db, options(batch, max), {
      projection: availableSystemStockProjection(fixture.config.BUSINESS_TIMEZONE),
      fullSync: adapter,
    });
  }
  function delivery(service: ReturnType<typeof processor>): SettingsEffectDelivery {
    return {
      supports: () => true,
      deliver: async (id, effect, signal) =>
        effect.kind === 'ecommerce.inventory.sync'
          ? service.synchronizeEcommerce(id, effect.storeId, signal)
          : undefined,
    };
  }
  async function effect(storeId = '1') {
    const id = randomUUID();
    await fixture.admin.query(
      'INSERT INTO pos_rewrite_settings_effects(id,partition_key,kind,payload,attempts,created_at) VALUES (?,?,?,?,0,?)',
      [
        id,
        'store:' + storeId,
        'ecommerce.inventory.sync',
        JSON.stringify({
          kind: 'ecommerce.inventory.sync',
          storeId,
          actorId: user.id,
          requestId: 'fixture-request',
          occurredAt: '2026-06-15 06:30:00.000',
        }),
        '2026-06-15 06:30:00.000',
      ],
    );
    return id;
  }
  async function count(table: string) {
    const [result] = await fixture.admin.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM ' + table,
    );
    return Number(result[0]?.n);
  }
  async function oracle(extra: { storeId?: string; failAfter?: number; httpStatus?: number } = {}) {
    const result = goldenSpawnResult(
      'administration',
      'ecommerce-sync-service-mysql',
      JSON.stringify({ database: fixture.url, ...extra }),
      undefined,
      fixturePlaceholders(fixture.url),
    );
    if (result.status !== 0)
      throw new Error('Ecommerce source oracle failed: ' + result.stdout.slice(0, 200));
    return oracleSchema.parse(JSON.parse(result.stdout) as unknown);
  }
  it('matches actual source >threshold membership including archived/unavailable/deleted rows and projects without changing POS/held quantity', async () => {
    const source = await oracle();
    expect(source.calls.map((row) => row.productId)).toEqual(['11', '13', '20', '30']);
    expect(source.http).toEqual([{ url: 'https://fixture.invalid/syncproduct', status: 200 }]);
    const receiver = remote(),
      service = processor(receiver.adapter),
      id = await effect();
    expect((await settingsOutbox(fixture.db, delivery(service)).dispatchNext())?.status).toBe(
      'delivered',
    );
    const [audits] = await fixture.admin.query<RowDataPacket[]>(
      'SELECT CAST(product_id AS CHAR) AS productId,tss_stock,vinc_stock FROM product_inventory_logs ORDER BY product_id',
    );
    expect(audits.map((row) => ({ productId: row.productId, stock: row.tss_stock }))).toEqual(
      source.calls.map(({ productId, stock }) => ({ productId, stock })),
    );
    expect(audits.every((row) => row.tss_stock === row.vinc_stock)).toBe(true);
    const [held] = await fixture.admin.query<RowDataPacket[]>('SELECT stock FROM hold_stock_store');
    expect(held[0]?.stock).toBe(3);
    expect(await count('pos_product_inventory_logs')).toBe(0);
    expect(receiver.submitted).toHaveLength(1);
    expect(receiver.submitted[0]).toMatchObject({
      operationId: id,
      storeId: '1',
      actorId: user.id,
      requestId: 'fixture-request',
    });
    const status = await service.status(user, '1', id);
    expect(status).toMatchObject({
      state: 'COMPLETED',
      selectedRows: 4,
      processedRows: 4,
      skippedRows: 0,
      fullState: 'SUCCEEDED',
    });
  }, 30000);
  it('retains explicit pending without burning ten delivery attempts while bounded projection/full sync is in progress', async () => {
    const receiver = remote('running'),
      service = processor(receiver.adapter, 1),
      id = await effect(),
      outbox = settingsOutbox(fixture.db, delivery(service));
    for (let i = 0; i < 15; i++) expect((await outbox.dispatchNext())?.status).toBe('pending');
    const status = await service.status(user, '1', id);
    expect(status).toMatchObject({
      state: 'FULL_SYNC',
      selectedRows: 4,
      processedRows: 4,
      attempts: 0,
      fullState: 'PENDING',
    });
    expect(receiver.submitted).toHaveLength(1);
    expect(receiver.read.length).toBeGreaterThan(0);
    expect(await count('product_inventory_logs')).toBe(4);
  });
  it('reads original full-sync status after a committed lost reply and never repeats projection or its POST', async () => {
    const receiver = remote(),
      base = receiver.adapter;
    let attempts = 0;
    const adapter: FullSyncAdapter = {
      ...base,
      submit: async (command) => {
        await base.submit(command);
        attempts++;
        throw new Error('private-source-connection-string');
      },
    };
    const service = processor(adapter),
      id = await effect(),
      outbox = settingsOutbox(fixture.db, delivery(service));
    expect((await outbox.dispatchNext())?.status).toBe('pending');
    expect(await service.status(user, '1', id)).toMatchObject({
      fullState: 'UNCERTAIN',
      completed: false,
    });
    expect((await outbox.dispatchNext())?.status).toBe('delivered');
    expect(attempts).toBe(1);
    expect(receiver.read).toHaveLength(1);
    expect(await count('product_inventory_logs')).toBe(4);
    expect(JSON.stringify(await service.status(user, '1', id))).not.toContain('private-source');
  });
  it('uses current locked quantity instead of overwriting a concurrent sale with the initially selected stock', async () => {
    const receiver = remote(),
      service = processor(receiver.adapter, 1),
      outbox = settingsOutbox(fixture.db, delivery(service));
    await effect();
    await outbox.dispatchNext();
    await fixture.admin.query(
      'UPDATE product_store SET stock=2 WHERE product_id=13 AND store_id=1',
    );
    await outbox.dispatchNext();
    const [row] = await fixture.admin.query<RowDataPacket[]>(
      'SELECT r.selected_stock,r.current_stock,ps.stock FROM pos_rewrite_ecommerce_inventory_sync_rows r JOIN product_store ps ON ps.product_id=r.product_id AND ps.store_id=1 WHERE r.product_id=13',
    );
    expect(row.map((value) => [value.selected_stock, value.current_stock, value.stock])).toEqual([
      [6, 2, 2],
    ]);
  });
  it('keeps a removed association explicitly skipped and never resurrects it during synchronization', async () => {
    const receiver = remote(),
      service = processor(receiver.adapter, 1),
      id = await effect(),
      outbox = settingsOutbox(fixture.db, delivery(service));
    await outbox.dispatchNext();
    await fixture.admin.query('DELETE FROM product_store WHERE product_id=13 AND store_id=1');
    await outbox.dispatchNext();
    expect(await service.status(user, '1', id)).toMatchObject({ processedRows: 2, skippedRows: 1 });
    const [found] = await fixture.admin.query<RowDataPacket[]>(
      'SELECT id FROM product_store WHERE product_id=13 AND store_id=1',
    );
    expect(found).toHaveLength(0);
  });
  it('diagnoses an unsupported selected configurable parent instead of filtering it; stock/audit/checkpoint roll back and explicit recovery does not repeat prior rows', async () => {
    await fixture.admin.query(
      'UPDATE product_store SET stock=9 WHERE product_id=10 AND store_id=1',
    );
    const receiver = remote(),
      service = processor(receiver.adapter),
      id = await effect(),
      outbox = settingsOutbox(fixture.db, delivery(service));
    expect((await outbox.dispatchNext())?.status).toBe('failed');
    expect(await service.status(user, '1', id)).toMatchObject({
      state: 'BLOCKED',
      selectedRows: 5,
      processedRows: 0,
      errorCode: 'STOCK_PRODUCT_UNSUPPORTED',
      blockedRecord: { productId: '10' },
    });
    expect(await count('product_inventory_logs')).toBe(0);
    expect(receiver.submitted).toHaveLength(0);
    // Explicitly reconcile the unsupported source association; do not fabricate projection support.
    await fixture.admin.query('DELETE FROM product_store WHERE product_id=10 AND store_id=1');
    await service.retry(user, '1', id, randomUUID());
    expect((await outbox.dispatchNext())?.status).toBe('delivered');
    expect(await service.status(user, '1', id)).toMatchObject({
      processedRows: 5,
      skippedRows: 1,
      state: 'COMPLETED',
    });
  });
  it('handles zero selected rows with a real full-catalog synchronization rather than treating the old started acknowledgement as completion', async () => {
    await fixture.admin.query('UPDATE stores SET ecom_threshold=100 WHERE id=1');
    const source = await oracle({ httpStatus: 500 });
    expect(source.calls).toHaveLength(0);
    expect(source.http[0]?.status).toBe(500);
    expect(source.errors).toEqual([]);
    const receiver = remote(),
      service = processor(receiver.adapter),
      id = await effect();
    await settingsOutbox(fixture.db, delivery(service)).dispatchNext();
    expect(receiver.submitted).toHaveLength(1);
    expect(await service.status(user, '1', id)).toMatchObject({
      state: 'COMPLETED',
      selectedRows: 0,
      processedRows: 0,
    });
  }, 30000);
  it('blocks oversized selections before any projection and can restage through explicit recovery after capacity correction', async () => {
    const receiver = remote(),
      small = processor(receiver.adapter, 25, 1),
      id = await effect();
    expect((await settingsOutbox(fixture.db, delivery(small)).dispatchNext())?.status).toBe(
      'failed',
    );
    expect(await small.status(user, '1', id)).toMatchObject({
      state: 'BLOCKED',
      selectedRows: 0,
      errorCode: 'ECOMMERCE_SYNC_SCOPE_TOO_WIDE',
    });
    expect(await count('product_inventory_logs')).toBe(0);
    const larger = processor(receiver.adapter);
    await larger.retry(user, '1', id, randomUUID());
    expect((await settingsOutbox(fixture.db, delivery(larger)).dispatchNext())?.status).toBe(
      'delivered',
    );
    expect(await larger.status(user, '1', id)).toMatchObject({
      state: 'COMPLETED',
      selectedRows: 4,
    });
  });
  it('keeps same-store FIFO while many workers claim the original effect once', async () => {
    const receiver = remote('running'),
      service = processor(receiver.adapter),
      first = await effect(),
      second = await effect(),
      outbox = settingsOutbox(fixture.db, delivery(service));
    const results = await Promise.all(Array.from({ length: 10 }, () => outbox.dispatchNext()));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(receiver.submitted.map((row) => row.operationId)).toEqual([first]);
    expect((await service.status(user, '1', second)).state).toBe('QUEUED');
  });
  it('records source swallowed partial failure and refuses archived stores before downstream sync', async () => {
    const source = await oracle({ failAfter: 2 });
    expect(source.calls).toHaveLength(2);
    expect(source.http).toHaveLength(0);
    expect(source.errors).toEqual(['SOURCE_SWALLOWED_ERROR']);
    await fixture.admin.query('UPDATE stores SET is_active=0 WHERE id=1');
    const receiver = remote(),
      service = processor(receiver.adapter),
      id = await effect();
    expect((await settingsOutbox(fixture.db, delivery(service)).dispatchNext())?.errorCode).toBe(
      'STORE_NOT_FOUND',
    );
    expect(receiver.submitted).toHaveLength(0);
    expect((await service.status(user, '1', id)).attempts).toBe(1);
  }, 30000);
  it('rechecks franchise assignments/categories for reads, writes, original-operation recovery and retries', async () => {
    const receiver = remote(),
      service = processor(receiver.adapter),
      settings = settingsService(fixture.config, fixture.db, {
        settingsDelivery: delivery(service),
        ecommerceSyncVerified: true,
      });
    const franchise = { ...user, id: '900004', userType: 2 as const, storeIds: ['1', '2', '3'] };
    await expect(settings.ecommerceSettings(franchise, '2')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await expect(settings.ecommerceSettings(franchise, '3')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    const value = {
      operationId: randomUUID(),
      expectedVersion: settingVersion([5, 1]),
      threshold: 4,
      active: false,
    };
    const result = await settings.updateEcommerce(franchise, '1', value);
    expect(result.ecommerceSyncId).toBeTruthy();
    expect(await service.operation(franchise, '1', value.operationId)).toEqual(result);
    await expect(service.operation(user, '1', value.operationId)).rejects.toMatchObject({
      code: 'ECOMMERCE_OPERATION_NOT_FOUND',
    });
    await fixture.admin.query('DELETE FROM user_stores WHERE django_user_id=900004');
    await expect(service.status(franchise, '1', result.ecommerceSyncId!)).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await expect(
      service.retry(franchise, '1', result.ecommerceSyncId!, randomUUID()),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
  });
  it('fences an unaccepted original request and preserves cancellation through late PUT/replay and restored settings', async () => {
    const receiver = remote(),
      service = processor(receiver.adapter),
      settings = settingsService(fixture.config, fixture.db, {
        settingsDelivery: delivery(service),
        ecommerceSyncVerified: true,
      }),
      original = {
        operationId: randomUUID(),
        expectedVersion: settingVersion([5, 1]),
        threshold: 7,
        active: false,
      },
      input = { operationId: randomUUID(), original };
    const cancelled = await service.cancel(user, '1', input);
    expect(cancelled).toMatchObject({
      cancelled: true,
      effectsQueued: false,
      originalOperationId: original.operationId,
    });
    expect(await service.cancel(user, '1', input)).toEqual(cancelled);
    expect(await service.operation(user, '1', input.operationId)).toEqual(cancelled);
    for (let attempt = 0; attempt < 2; attempt++) {
      const replay = await settings.updateEcommerce(user, '1', original);
      expect(replay).toMatchObject({
        cancelled: true,
        operationId: original.operationId,
        effectsQueued: false,
      });
      await fixture.admin.query('UPDATE stores SET ecom_threshold=5,ecom_delivery=1 WHERE id=1');
    }
    expect(await count('pos_rewrite_settings_effects')).toBe(0);
    await expect(
      service.cancel(user, '1', { ...input, original: { ...original, threshold: 8 } }),
    ).rejects.toMatchObject({ code: 'SETTINGS_OPERATION_REUSED' });
  });
  it('serializes cancellation against acceptance without undoing an accepted effect or creating a duplicate', async () => {
    const receiver = remote(),
      service = processor(receiver.adapter),
      settings = settingsService(fixture.config, fixture.db, {
        settingsDelivery: delivery(service),
        ecommerceSyncVerified: true,
      }),
      original = {
        operationId: randomUUID(),
        expectedVersion: settingVersion([5, 1]),
        threshold: 6,
        active: true,
      };
    const [changed, cancelled] = await Promise.all([
      settings.updateEcommerce(user, '1', original),
      service.cancel(user, '1', { operationId: randomUUID(), original }),
    ]);
    expect(!!changed.cancelled).toBe(!!cancelled.cancelled);
    if (changed.cancelled) {
      expect(await count('pos_rewrite_settings_effects')).toBe(0);
    } else {
      expect(cancelled.ecommerceSyncId).toBe(changed.ecommerceSyncId);
      expect(await count('pos_rewrite_settings_effects')).toBe(2);
    }
    expect(await settings.updateEcommerce(user, '1', original)).toEqual(changed);
  });
  it('returns lossless, bounded diagnostic rows including source-selected unavailable/deleted SKUs', async () => {
    await fixture.admin.query(
      'UPDATE product_store SET id=9007199254740993 WHERE product_id=11 AND store_id=1',
    );
    const receiver = remote(),
      service = processor(receiver.adapter),
      id = await effect();
    await settingsOutbox(fixture.db, delivery(service)).dispatchNext();
    const first = await service.records(user, '1', id, undefined, 2);
    expect(first.data).toHaveLength(2);
    const second = await service.records(user, '1', id, first.nextCursor!, 2);
    expect(second.data).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect([...first.data, ...second.data].map((row) => row.productId)).toContain('13');
    expect([...first.data, ...second.data].map((row) => row.associationId)).toContain(
      '9007199254740993',
    );
    expect([...first.data, ...second.data].every((row) => row.state === 'PROCESSED')).toBe(true);
  });
  it('records a completed-job resume race as an immutable no-op receipt rather than trapping recovery on a missing action', async () => {
    const receiver = remote(),
      service = processor(receiver.adapter),
      id = await effect();
    await settingsOutbox(fixture.db, delivery(service)).dispatchNext();
    const operationId = randomUUID(),
      result = await service.retry(user, '1', id, operationId);
    expect(result).toMatchObject({
      effectsQueued: false,
      ecommerceSyncId: id,
      operationId,
      message: 'Ecommerce synchronization already completed.',
    });
    expect(await service.operation(user, '1', operationId)).toEqual(result);
    expect(await service.retry(user, '1', id, operationId)).toEqual(result);
    expect(await count('product_inventory_logs')).toBe(4);
    expect(receiver.submitted).toHaveLength(1);
  });
});
