import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { availableStockProjection } from '../../src/db/stock-projection/service.js';
import { splitMigration } from '../../src/db/migrations.js';
import { AppError } from '../../src/domain/errors.js';
import type { Principal } from '../../src/domain/access.js';
import { legacyFulfillmentService } from '../../src/modules/legacy-fulfillment/service.js';
import {
  legacyCancellationAudit,
  legacyRtoCorrectionContract,
} from '../../src/modules/legacy-fulfillment/domain.js';
import { verifiedMysqlFixture } from '../../tools/operational-reports/verified-mysql-fixture.js';

const integration = process.env.MYSQL_INTEGRATION_URL,
  user: Principal = {
    id: '44',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 4,
    userType: 1,
    storeIds: ['1'],
  },
  orderId = '9007199254740993',
  hpIds = ['9007199254741993', '9007199254741994', '9007199254741995'];
describe.skipIf(!integration)(
  'legacy status, packing and corrected RTO on real isolated MySQL',
  () => {
    const schema =
        'pos_rewrite_legacy_fulfillment_test_' + randomUUID().replaceAll('-', '').slice(0, 12),
      tables = [
        'stores',
        'orders',
        'products',
        'product_store',
        'pos_user',
        'user_stores',
        'express_line_item',
        'hyperlocal_order_log',
        'has_products',
        'pos_transaction_logs',
        'product_stocks',
        'product_inventory_logs',
        'pos_inventory_sync_log',
        'products_inventory_logs',
        'pos_product_inventory_logs',
        'attributes',
        'has_options',
      ];
    const config = readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        SESSION_SECRET: 'legacy-fulfillment-local-fixture-'.repeat(3),
      }),
      clock = () => Temporal.Instant.from('2026-11-16T08:00:00Z'),
      stockProcedure = availableStockProjection(config.BUSINESS_TIMEZONE, clock);
    let native: mysql.Connection | undefined,
      database: Databases | undefined,
      created = false;
    const sqlDb = () => {
        if (!native) throw new Error('Legacy fixture unavailable.');
        return native;
      },
      db = () => {
        if (!database) throw new Error('Legacy fixture unavailable.');
        return database;
      },
      fixture = () =>
        verifiedMysqlFixture(sqlDb(), ['evidence/mysql-legacy-fulfillment-schema.json']);
    const service = (
      options: Parameters<typeof legacyFulfillmentService>[2] = {
        stockProcedure,
        synchronizationAvailable: true,
        clock,
      },
    ) => legacyFulfillmentService(config, db(), options);
    async function count(table: string) {
      const [rows] = await sqlDb().query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) value FROM ${mysql.escapeId(table)}`,
      );
      return Number(rows[0]!.value);
    }
    async function state() {
      const [stocks] = await sqlDb().query<mysql.RowDataPacket[]>(
          'SELECT product_id,store_id,stock FROM product_store ORDER BY store_id,product_id',
        ),
        [flags] = await sqlDb().query<mysql.RowDataPacket[]>(
          'SELECT is_pack,rto_recieved,updated_at FROM hyperlocal_order_log ORDER BY id',
        );
      return { stocks, flags };
    }
    beforeAll(async () => {
      const url = new URL(integration!);
      if (
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.pathname !== '/pos_rewrite_integration'
      )
        throw new Error('Legacy fixtures require the guarded localhost integration database.');
      native = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      });
      await native.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
      created = true;
      await native.changeUser({ database: schema });
      await fixture().create(tables);
      for (const filename of [
        'src/modules/administration/migration.sql',
        'src/modules/legacy-fulfillment/migration.sql',
        'src/modules/legacy-fulfillment/lifecycle/migration.sql',
      ])
        for (const statement of splitMigration(readFileSync(filename, 'utf8')))
          await native.query(statement);
      url.pathname = '/' + schema;
      database = createDatabases(
        readConfig({
          NODE_ENV: 'test',
          SESSION_SECRET: 'legacy-native-'.repeat(6),
          MYSQL_WRITER_URL: url.href,
          MYSQL_PRIMARY_READER_URL: url.href,
          MYSQL_DATA_READER_URL: url.href,
          MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
        }),
      );
    });
    beforeEach(async () => {
      for (const table of [
        ...tables,
        'pos_rewrite_operator_checkins',
        'pos_rewrite_administration_outbox',
        'pos_rewrite_legacy_fulfillment_commands',
        'pos_rewrite_legacy_rto_receipts',
        'pos_rewrite_local_delivery_orders',
        'pos_rewrite_local_delivery_commands',
        'pos_rewrite_local_delivery_calls',
        'pos_rewrite_local_delivery_jobs',
      ])
        await sqlDb().query(`DELETE FROM ${mysql.escapeId(table)}`);
      for (const id of [1, 2])
        await fixture().insert('stores', {
          id,
          store_name: 'Fixture ' + id,
          is_active: 1,
          type: 'STORE',
          category: 'IN_HOUSE',
          location_code: 'FIXTURE' + id,
          ecom_delivery: id === 1 ? 1 : 0,
          ecom_threshold: 0,
        });
      await fixture().insert('pos_user', {
        id: 44,
        role: 4,
        user_type: 1,
        is_active: 1,
        first_name: 'Fixture',
      });
      await fixture().insert('user_stores', { id: 1, django_user_id: 44, store_id: 1 });
      await sqlDb().query(
        "INSERT INTO pos_rewrite_operator_checkins(operator_id,store_id,counter_id,checked_in_at,expires_at) VALUES('44',1,NULL,'2026-11-16 00:00:00','2099-01-01 00:00:00')",
      );
      await fixture().insert('orders', {
        id: orderId,
        order_ref_no: 'FIXTURE-LONG',
        location_type: 'SW',
        location_id: 1,
        is_split_order: 1,
        order_status: 28,
        payment_status: 4,
      });
      await fixture().insert('hyperlocal_order_log', {
        id: 1,
        order_id: orderId,
        borzo_id: '9007199254741999',
        action: 'ACCEPTED',
        main_location_id: 1,
        is_created_in_borzo: 1,
        is_pack: 0,
        is_rto: 1,
        rto_recieved: 0,
        updated_at: '2026-11-16 09:00:00',
        source_tracking_url: 'https://tracking.example.test/source',
        destination_tracking_url: 'javascript:unsafe()',
      });
      for (const id of [10, 11]) {
        await fixture().insert('products', {
          id,
          prod_type: 1,
          parent_prod_id: 0,
          product: 'Fixture product ' + id,
        });
        await fixture().insert('product_stocks', {
          prod_id: id,
          parent_prod_id: 0,
          stock: 5,
          stocked: 0,
        });
        for (const store of [1, 2])
          await fixture().insert('product_store', {
            id: id + store * 100,
            product_id: id,
            store_id: store,
            stock: store === 1 ? 5 : 20,
            is_avail: 1,
            is_del: 0,
          });
      }
      for (const [index, productId, quantity, platform] of [
        [0, 10, 2, 4],
        [1, 10, 1, 4],
        [2, 11, 4, 1],
      ] as const)
        await fixture().insert('has_products', {
          id: hpIds[index]!,
          order_id: orderId,
          prod_id: productId,
          sub_prod_id: 0,
          qty: quantity,
          order_platform_id: platform,
          status: 'DELIVERED',
        });
    });
    afterAll(async () => {
      await database?.close();
      if (native && created) {
        await native.changeUser({ database: 'mysql' });
        await native.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
      }
      await native?.end();
    });
    it('returns source operational status/long IDs without stored provider errors or unsafe tracking links', async () => {
      const result = await service().status(user, '1', orderId);
      expect(result).toMatchObject({
        orderId,
        borzoId: '9007199254741999',
        sourceStatus: { status: '200', message: 'Order Created Succesfully at Borzo' },
        canPack: true,
        canReceiveRto: true,
        checkedIn: true,
        tracking: { source: 'https://tracking.example.test/source', destination: null },
      });
      expect(result.returnLines.map((line) => line.id)).toEqual(hpIds.slice(0, 2));
      expect(result.excludedLineCount).toBe(1);
      await sqlDb().query(
        "UPDATE hyperlocal_order_log SET action='CREATION_FAILED',error_msg='private-provider-token-and-contact'",
      );
      const failed = await service().status(user, '1', orderId);
      expect(failed.sourceStatus.error).not.toContain('private-provider');
      expect(JSON.stringify(failed)).not.toContain('private-provider');
      expect(failed.canPack).toBe(false);
    });
    it('packs20 concurrent retries once, preserves exact source audit data and leaves all stock/financial fields unchanged', async () => {
      await sqlDb().query('ALTER TABLE pos_transaction_logs AUTO_INCREMENT=9007199254742993');
      const before = await state(),
        input = { commandId: randomUUID(), note: 'Parcel checked €' };
      const receipts = await Promise.all(
        Array.from({ length: 20 }, () =>
          service().execute(user, '1', orderId, 'packing', input, 'fixture-request'),
        ),
      );
      expect(new Set(receipts.map((row) => row.auditId)).size).toBe(1);
      expect(receipts[0]).toMatchObject({
        outcome: 'packed',
        auditId: '9007199254742993',
        restoredUnits: '0',
      });
      expect(await count('pos_transaction_logs')).toBe(1);
      expect(await count('pos_rewrite_legacy_fulfillment_commands')).toBe(1);
      expect((await state()).stocks).toEqual(before.stocks);
      expect((await state()).flags).toEqual([
        { is_pack: 1, rto_recieved: 0, updated_at: '2026-11-16 09:00:00' },
      ]);
      const [logs] = await sqlDb().query<mysql.RowDataPacket[]>(
        'SELECT store_id,user_id,pos_user_id,pay_dict,comment FROM pos_transaction_logs',
      );
      expect(logs[0]).toMatchObject({
        store_id: '0',
        user_id: '0',
        pos_user_id: '44',
        pay_dict: '{}',
        comment: 'Parcel checked €, Order Packed By: Fixture',
      });
      await expect(
        service().execute(
          user,
          '1',
          orderId,
          'packing',
          { ...input, note: 'Changed' },
          'fixture-request',
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(await count('pos_transaction_logs')).toBe(1);
      expect((await service().receipt(user, input.commandId)).commandId).toBe(input.commandId);
      expect(
        (
          await service().execute(
            user,
            '1',
            orderId,
            'packing',
            { ...input, commandId: input.commandId.toUpperCase() },
            'fixture-request',
          )
        ).auditId,
      ).toBe(receipts[0]!.auditId);
      expect(await count('pos_transaction_logs')).toBe(1);
    });
    it('restores only split-platform4 lines, preserves per-HP audit steps, queues one sync and retains an order-scoped immutable correction receipt', async () => {
      const input = { commandId: randomUUID(), note: 'Returned parcel checked' },
        receipt = await service().execute(
          user,
          '1',
          orderId,
          'rto-receipt',
          input,
          'fixture-request',
        );
      expect(receipt).toMatchObject({
        outcome: 'rto-received',
        restoredUnits: '3',
        split: true,
        excludedLineCount: 1,
        correctionContract: legacyRtoCorrectionContract,
        integrationState: 'pending',
        steps: [
          { hasProductId: hpIds[0], productId: '10', before: 5, after: 7 },
          { hasProductId: hpIds[1], productId: '10', before: 7, after: 8 },
        ],
      });
      expect((await state()).stocks).toMatchObject([
        { product_id: '10', store_id: '1', stock: 8 },
        { product_id: '11', store_id: '1', stock: 5 },
        { product_id: '10', store_id: '2', stock: 20 },
        { product_id: '11', store_id: '2', stock: 20 },
      ]);
      expect((await state()).flags[0]).toMatchObject({
        rto_recieved: 1,
        updated_at: '2026-11-16 09:00:00',
      });
      expect(await count('pos_inventory_sync_log')).toBe(2);
      expect(await count('product_inventory_logs')).toBe(2);
      expect(await count('pos_rewrite_administration_outbox')).toBe(1);
      expect(await count('pos_rewrite_legacy_rto_receipts')).toBe(1);
      const [outbox] = await sqlDb().query<mysql.RowDataPacket[]>(
        'SELECT payload FROM pos_rewrite_administration_outbox',
      );
      const payload =
        typeof outbox[0]!.payload === 'string'
          ? JSON.parse(outbox[0]!.payload)
          : outbox[0]!.payload;
      expect(payload).toMatchObject({
        reason: 'legacy-rto',
        productIds: ['10'],
        actorId: '44',
        requestId: 'fixture-request',
      });
      await sqlDb().query(
        "UPDATE pos_rewrite_administration_outbox SET delivered_at='2026-11-16 14:00:00'",
      );
      expect((await service().receipt(user, input.commandId)).integrationState).toBe('delivered');
    });
    it('serializes20 different command IDs to one physical restock, even if a later writer clears the legacy flag', async () => {
      const receipts = await Promise.all(
        Array.from({ length: 20 }, () =>
          service().execute(
            user,
            '1',
            orderId,
            'rto-receipt',
            { commandId: randomUUID(), note: 'Received' },
            'fixture-request',
          ),
        ),
      );
      expect(receipts.filter((row) => row.outcome === 'rto-received')).toHaveLength(1);
      expect(receipts.filter((row) => row.outcome === 'already-recorded')).toHaveLength(19);
      expect(await count('pos_transaction_logs')).toBe(1);
      expect(await count('pos_rewrite_administration_outbox')).toBe(1);
      expect(await count('pos_inventory_sync_log')).toBe(2);
      const before = await state();
      await sqlDb().query('UPDATE hyperlocal_order_log SET rto_recieved=0');
      const repeated = await service().execute(
        user,
        '1',
        orderId,
        'rto-receipt',
        { commandId: randomUUID(), note: 'Repeated receipt' },
        'fixture-request',
      );
      expect(repeated).toMatchObject({
        outcome: 'already-recorded',
        restoredUnits: '0',
        originalCommandId: expect.any(String),
        integrationState: 'pending',
      });
      expect((await state()).stocks).toEqual(before.stocks);
      expect((await service().status(user, '1', orderId)).rtoReceived).toBe(true);
    });
    it('recognizes source-already-received flags without inventing verified stock changes', async () => {
      await sqlDb().query('UPDATE hyperlocal_order_log SET rto_recieved=1');
      const before = await state(),
        result = await service({ clock }).execute(
          user,
          '1',
          orderId,
          'rto-receipt',
          { commandId: randomUUID(), note: 'Existing source receipt' },
          'fixture-request',
        );
      expect(result).toMatchObject({
        outcome: 'already-recorded',
        recordedBy: 'legacy',
        restoredUnits: '0',
        steps: [],
        integrationState: 'not-required',
      });
      expect(await state()).toEqual(before);
      expect(await count('pos_transaction_logs')).toBe(0);
      expect(await count('pos_rewrite_administration_outbox')).toBe(0);
    });
    it('retains all per-HP source steps for a normal unsplit return', async () => {
      await sqlDb().query('UPDATE orders SET is_split_order=0');
      const result = await service().execute(
        user,
        '1',
        orderId,
        'rto-receipt',
        { commandId: randomUUID(), note: 'Complete parcel' },
        'fixture-request',
      );
      expect(result).toMatchObject({ restoredUnits: '7', split: false, excludedLineCount: 0 });
      expect(result.steps.map((step) => [step.productId, step.before, step.after])).toEqual([
        ['10', 5, 7],
        ['10', 7, 8],
        ['11', 5, 9],
      ]);
      expect(await count('pos_inventory_sync_log')).toBe(3);
    });
    it.each(['cancellation-audit', 'refund-flag'] as const)(
      'requires reconciliation for prior %s evidence instead of adding stock a second time',
      async (evidence) => {
        // Exact old webhook outcome: stock already restored, yet the courier
        // remains ACCEPTED and eligible for the original RTO inward handler.
        await sqlDb().query('UPDATE product_store SET stock=8 WHERE store_id=1 AND product_id=10');
        if (evidence === 'cancellation-audit')
          await fixture().insert('pos_transaction_logs', {
            id: '9007199254742993',
            order_id: orderId,
            store_id: 1,
            user_id: 0,
            pos_user_id: 0,
            order_status: 28,
            payment_status: 4,
            pay_dict: '{}',
            comment: legacyCancellationAudit,
          });
        else await sqlDb().query('UPDATE hyperlocal_order_log SET is_refunded=1');
        const before = await state(),
          audits = await count('pos_transaction_logs'),
          status = await service().status(user, '1', orderId);
        expect(status).toMatchObject({
          action: 'ACCEPTED',
          rtoEligible: true,
          rtoReceived: false,
          canReceiveRto: false,
          reconciliationRequired: true,
        });
        await expect(
          service().execute(
            user,
            '1',
            orderId,
            'rto-receipt',
            { commandId: randomUUID(), note: 'Returning parcel' },
            'fixture-request',
          ),
        ).rejects.toMatchObject({ code: 'LEGACY_FULFILLMENT_RECONCILIATION_REQUIRED' });
        expect(await state()).toEqual(before);
        expect(await count('pos_transaction_logs')).toBe(audits);
        for (const table of [
          'pos_inventory_sync_log',
          'product_inventory_logs',
          'pos_rewrite_administration_outbox',
          'pos_rewrite_legacy_fulfillment_commands',
          'pos_rewrite_legacy_rto_receipts',
        ])
          expect(await count(table), table).toBe(0);
      },
    );
    it('retains a committed rewrite return receipt after later cancellation/refund changes without another stock movement', async () => {
      const input = { commandId: randomUUID(), note: 'Returning parcel' },
        original = await service().execute(
          user,
          '1',
          orderId,
          'rto-receipt',
          input,
          'fixture-request',
        ),
        before = await state();
      await sqlDb().query('UPDATE hyperlocal_order_log SET is_refunded=1,rto_recieved=0');
      const replay = await service().execute(
          user,
          '1',
          orderId,
          'rto-receipt',
          input,
          'fixture-request',
        ),
        another = await service().execute(
          user,
          '1',
          orderId,
          'rto-receipt',
          { commandId: randomUUID(), note: 'Later retry' },
          'fixture-request',
        );
      expect(replay).toEqual(original);
      expect(another).toMatchObject({
        outcome: 'already-recorded',
        originalCommandId: original.commandId,
        restoredUnits: '0',
      });
      expect((await state()).stocks).toEqual(before.stocks);
      expect(await count('pos_transaction_logs')).toBe(1);
      expect(await count('pos_inventory_sync_log')).toBe(2);
      expect(await count('pos_rewrite_administration_outbox')).toBe(1);
    });
    it('preserves archived operator/store records and immutable receipts while rejecting their inactive use, then permits normal reactivation', async () => {
      const input = { commandId: randomUUID(), note: 'Packed' },
        original = await service().execute(user, '1', orderId, 'packing', input, 'fixture-request');
      await sqlDb().query('UPDATE pos_user SET is_active=0 WHERE id=44');
      await expect(service().receipt(user, input.commandId)).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
      });
      await expect(
        service().execute(user, '1', orderId, 'packing', input, 'fixture-request'),
      ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      await sqlDb().query('UPDATE pos_user SET is_active=1 WHERE id=44');
      expect((await service().receipt(user, input.commandId)).auditId).toBe(original.auditId);
      await sqlDb().query('UPDATE stores SET is_active=0 WHERE id=1');
      expect((await service().receipt(user, input.commandId)).auditId).toBe(original.auditId);
      await expect(
        service().execute(
          user,
          '1',
          orderId,
          'packing',
          { commandId: randomUUID(), note: 'New operation' },
          'fixture-request',
        ),
      ).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
      await sqlDb().query('UPDATE stores SET is_active=1 WHERE id=1');
      expect(
        (await service().execute(user, '1', orderId, 'packing', input, 'fixture-request')).auditId,
      ).toBe(original.auditId);
      expect(await count('pos_transaction_logs')).toBe(1);
    });
    it('rolls back flags, every stock/projection audit, comment, command and outbox after a late candidate failure', async () => {
      const before = await state();
      let calls = 0;
      const failing = service({
        clock,
        synchronizationAvailable: true,
        stockProcedure: async (tx, input) => {
          await stockProcedure(tx, input);
          if (++calls === 2) throw new AppError(409, 'FIXTURE_STOCK_FAILURE', 'Fixture failure.');
        },
      });
      await expect(
        failing.execute(
          user,
          '1',
          orderId,
          'rto-receipt',
          { commandId: randomUUID(), note: 'Checked' },
          'fixture-request',
        ),
      ).rejects.toMatchObject({ code: 'FIXTURE_STOCK_FAILURE' });
      expect(calls).toBe(2);
      expect(await state()).toEqual(before);
      for (const table of [
        'pos_transaction_logs',
        'pos_inventory_sync_log',
        'product_inventory_logs',
        'pos_product_inventory_logs',
        'products_inventory_logs',
        'pos_rewrite_administration_outbox',
        'pos_rewrite_legacy_rto_receipts',
        'pos_rewrite_legacy_fulfillment_commands',
      ])
        expect(await count(table), table).toBe(0);
    });
    it('denies stale role/store/check-in, wrong store, express overlap, ineligible returns and unsafe comments before committing changes', async () => {
      const input = { commandId: randomUUID(), note: 'Parcel' },
        before = await state();
      await expect(
        service().execute(user, '2', orderId, 'packing', input, 'fixture-request'),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
      await sqlDb().query('DELETE FROM user_stores');
      await expect(
        service().execute({ ...user, role: 1 }, '1', orderId, 'packing', input, 'fixture-request'),
      ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
      await fixture().insert('user_stores', { id: 1, django_user_id: 44, store_id: 1 });
      await sqlDb().query(
        "UPDATE pos_rewrite_operator_checkins SET expires_at='2000-01-01 00:00:00'",
      );
      await expect(
        service().execute(user, '1', orderId, 'packing', input, 'fixture-request'),
      ).rejects.toMatchObject({ code: 'CHECK_IN_REQUIRED' });
      await sqlDb().query(
        "UPDATE pos_rewrite_operator_checkins SET expires_at='2099-01-01 00:00:00'",
      );
      await expect(
        service().execute(
          user,
          '1',
          orderId,
          'packing',
          { ...input, note: 'Emoji 😀' },
          'fixture-request',
        ),
      ).rejects.toMatchObject({ code: 'LEGACY_COMMENT_ENCODING_UNSUPPORTED' });
      await sqlDb().query('UPDATE orders SET order_status=21');
      await sqlDb().query('UPDATE hyperlocal_order_log SET is_rto=0');
      await expect(
        service().execute(user, '1', orderId, 'rto-receipt', input, 'fixture-request'),
      ).rejects.toMatchObject({ code: 'LEGACY_RTO_NOT_ELIGIBLE' });
      await expect(
        service({ clock }).execute(user, '1', orderId, 'rto-receipt', input, 'fixture-request'),
      ).rejects.toMatchObject({ code: 'LEGACY_RTO_STOCK_UNAVAILABLE' });
      await fixture().insert('express_line_item', {
        id: 1,
        order_id: 1,
        has_product_id: 1,
        store_id: 1,
      });
      await sqlDb().query('UPDATE orders SET location_id=2');
      await expect(
        service().execute(user, '1', orderId, 'packing', input, 'fixture-request'),
      ).rejects.toMatchObject({ code: 'LEGACY_ORDER_NOT_FOUND' });
      await fixture().insert('orders', {
        id: 1001,
        location_type: 'SW',
        location_id: 1,
        order_status: 28,
        payment_status: 4,
      });
      await sqlDb().query('UPDATE express_line_item SET order_id=1001');
      await expect(
        service().execute(user, '1', '1001', 'packing', input, 'fixture-request'),
      ).rejects.toMatchObject({ code: 'EXPRESS_FULFILLMENT_REQUIRED' });
      expect((await state()).stocks).toEqual(before.stocks);
      expect(await count('pos_transaction_logs')).toBe(0);
      expect(await count('pos_rewrite_legacy_fulfillment_commands')).toBe(0);
    });
    it('refuses conflicting old courier logs instead of packing or restocking ambiguous state', async () => {
      await fixture().insert('hyperlocal_order_log', {
        id: 2,
        order_id: orderId,
        borzo_id: 999,
        action: 'ACCEPTED',
        main_location_id: 1,
        is_created_in_borzo: 1,
      });
      expect((await service().status(user, '1', orderId)).reconciliationRequired).toBe(true);
      await expect(
        service().execute(
          user,
          '1',
          orderId,
          'packing',
          { commandId: randomUUID(), note: 'Pack' },
          'fixture-request',
        ),
      ).rejects.toMatchObject({ code: 'LEGACY_FULFILLMENT_RECONCILIATION_REQUIRED' });
      expect(await count('pos_transaction_logs')).toBe(0);
    });
  },
);
