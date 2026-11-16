import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { legacyFulfillmentService } from '../../src/modules/legacy-fulfillment/service.js';
import { availableStockProjection } from '../../src/db/stock-projection/service.js';
import { availableSystemStockProjection } from '../../src/db/stock-projection/service.js';
import { AppError } from '../../src/domain/errors.js';
import { providerRequestHash } from '../../src/modules/legacy-fulfillment/lifecycle/domain.js';
import type { LegacyProvider } from '../../src/modules/legacy-fulfillment/lifecycle/provider.js';
import {
  createLifecycleFixture,
  deliveryHpIds,
  deliveryOrderId,
  deliveryUser,
  type LifecycleFixture,
} from './lifecycle-fixture.js';
describe.skipIf(!process.env.MYSQL_INTEGRATION_URL)(
  'local delivery lifecycle on actual isolated MySQL',
  () => {
    let local: LifecycleFixture | undefined;
    const fixture = () => {
        if (!local) throw new Error('Fixture unavailable.');
        return local;
      },
      input = (reason = '') => ({ commandId: randomUUID(), reason }),
      arrival = async (notify = false) => {
        const f = fixture(),
          parts = f.build();
        await parts.service.arrive('1', deliveryOrderId, { ...input(), notify }, 'fixture-request');
        return parts;
      };
    async function stocks() {
      const [rows] = await fixture().connection.query<mysql.RowDataPacket[]>(
        'SELECT CAST(store_id AS CHAR) storeId,CAST(product_id AS CHAR) productId,stock FROM product_store ORDER BY store_id,product_id',
      );
      return rows;
    }
    async function drain(worker: ReturnType<LifecycleFixture['build']>['worker']) {
      for (let index = 0; index < 30; index++) if (!(await worker.dispatchNext())) return;
      throw new Error('Fixture worker did not drain.');
    }
    beforeAll(async () => {
      local = await createLifecycleFixture();
    });
    beforeEach(async () => {
      await fixture().reset();
    });
    afterAll(async () => {
      await local?.close();
    });
    it('accepts20 identical arrival retries once, holds each HP, stores actor0 audits and schedules both notification and transfer durably', async () => {
      const f = fixture(),
        { service } = f.build(),
        request = { ...input(), notify: true };
      const receipts = await Promise.all(
        Array.from({ length: 20 }, () =>
          service.arrive('1', deliveryOrderId, request, 'r'.repeat(128)),
        ),
      );
      expect(new Set(receipts.map((receipt) => receipt.commandId)).size).toBe(1);
      expect(receipts[0]).toMatchObject({ phase: 'completed', outcome: 'arrival-scheduled' });
      expect((await stocks())[0]).toMatchObject({ storeId: '1', productId: '10', stock: 2 });
      const [held] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT CAST(product_id AS CHAR) productId,stock FROM hold_stock_store',
      );
      expect(held).toEqual([{ productId: '10', stock: 3 }]);
      const [audit] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT CAST(pos_user_id AS CHAR) actor,stock_before,stock_after FROM pos_hold_stock_logs ORDER BY id',
      );
      expect(audit).toEqual([
        { actor: '0', stock_before: '0', stock_after: '2' },
        { actor: '0', stock_before: '2', stock_after: '3' },
      ]);
      expect(await f.count('pos_rewrite_local_delivery_jobs')).toBe(2);
      expect(await f.count('pos_rewrite_administration_outbox')).toBe(1);
      expect(await f.count('pos_transaction_logs')).toBe(1);
      expect(f.sends).toHaveLength(0);
      const [jobs] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT request_id FROM pos_rewrite_local_delivery_jobs',
      );
      expect(jobs.every((row) => row.request_id === 'r'.repeat(128))).toBe(true);
    }, 15000);
    it('passes all selected HP reservations atomically and accepts at a backup, consuming only its hold and releasing the other backup', async () => {
      const f = fixture(),
        { service, worker } = await arrival();
      const passed = await service.submit(
        deliveryUser,
        '1',
        deliveryOrderId,
        'pass',
        input('Next store'),
        'fixture-request',
      );
      expect(passed.outcome).toBe('transferred');
      expect(
        (await stocks()).filter((row) => row.productId === '10').map((row) => row.stock),
      ).toEqual([5, 2, 2]);
      await f.checkin('2');
      const accepted = await service.submit(
        deliveryUser,
        '2',
        deliveryOrderId,
        'create',
        input(),
        'fixture-request',
      );
      expect(accepted.phase).toBe('queued');
      await drain(worker);
      expect(await service.view(deliveryUser, accepted.commandId)).toMatchObject({
        phase: 'completed',
        outcome: 'created',
        courierOrderId: '9007199254742999',
      });
      expect(
        (await stocks()).filter((row) => row.productId === '10').map((row) => row.stock),
      ).toEqual([5, 2, 5]);
      const [flags] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT action,main_location_id,borzo_id,pos_admin_id FROM hyperlocal_order_log',
      );
      expect(flags[0]).toMatchObject({
        action: 'ACCEPTED',
        main_location_id: 1,
        borzo_id: '9007199254742999',
        pos_admin_id: 44,
      });
      expect((await f.lines(deliveryOrderId)).map((line) => line.status)).toEqual([
        'PROCESSING',
        'PROCESSING',
        'PLACED',
      ]);
      const [held] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT stock FROM hold_stock_store',
      );
      expect(held.every((row) => row.stock === 0)).toBe(true);
      expect(f.sends.filter((call) => call.kind === 'borzo-create')).toHaveLength(1);
    });
    it('uses one distinct-SKU cancellation call for two authorized HL HPs and preserves all online HPs', async () => {
      const f = fixture(),
        { service, worker } = await arrival(),
        operation = await service.submit(
          deliveryUser,
          '1',
          deliveryOrderId,
          'cancel',
          input('Customer requested cancellation'),
          'fixture-request',
        );
      await drain(worker);
      expect(await service.view(deliveryUser, operation.commandId)).toMatchObject({
        phase: 'completed',
        outcome: 'cancelled',
        inventoryMovementCommandId: operation.commandId,
      });
      expect(f.sends.filter((call) => call.kind === 'cancel-item')).toHaveLength(1);
      expect(await f.count('cancel_orders')).toBe(2);
      expect((await f.lines(deliveryOrderId)).map((line) => line.status)).toEqual([
        'CANCELLED',
        'CANCELLED',
        'PLACED',
      ]);
      expect((await stocks())[0]!.stock).toBe(5);
      expect(await f.count('pos_rewrite_legacy_rto_receipts')).toBe(1);
    });
    it('rejects a SKU sweep spanning selected and online lines, plus a wrong-store cancellation, before any provider call', async () => {
      const f = fixture(),
        { service } = await arrival();
      await f.connection.query('UPDATE has_products SET prod_id=10 WHERE id=?', [deliveryHpIds[2]]);
      await expect(
        service.submit(deliveryUser, '1', deliveryOrderId, 'cancel', input(), 'fixture-request'),
      ).rejects.toMatchObject({ code: 'PER_HP_CANCELLATION_REQUIRED' });
      await f.checkin('2');
      await expect(
        service.submit(deliveryUser, '2', deliveryOrderId, 'cancel', input(), 'fixture-request'),
      ).rejects.toMatchObject({ code: 'LOCAL_DELIVERY_NOT_FOUND' });
      expect(f.sends).toHaveLength(0);
      expect(await f.count('cancel_orders')).toBe(0);
      expect((await f.lines(deliveryOrderId)).every((line) => line.status === 'PLACED')).toBe(true);
    });
    it('retains a committed but lost cancellation outcome, freezes stock/RTO, and reconciles without another refund dispatch', async () => {
      const f = fixture(),
        { service, worker } = await arrival(),
        operation = await service.submit(
          deliveryUser,
          '1',
          deliveryOrderId,
          'cancel',
          input('Cancel once'),
          'fixture-request',
        );
      f.loseNext('cancel-item');
      expect((await worker.dispatchNext())?.status).toBe('UNCERTAIN');
      expect(await worker.dispatchNext()).toBeNull();
      expect((await stocks())[0]!.stock).toBe(2);
      expect(await f.count('cancel_orders')).toBe(2);
      const old = legacyFulfillmentService(f.config, f.database, {
        stockProcedure: availableStockProjection(f.config.BUSINESS_TIMEZONE, f.clock),
        synchronizationAvailable: true,
        clock: f.clock,
      });
      await expect(
        old.execute(
          deliveryUser,
          '1',
          deliveryOrderId,
          'rto-receipt',
          { commandId: randomUUID(), note: 'Parcel' },
          'fixture-request',
        ),
      ).rejects.toMatchObject({ code: 'LOCAL_DELIVERY_COMMAND_PENDING' });
      const current = await service.view(deliveryUser, operation.commandId),
        recovery = {
          commandId: randomUUID(),
          expectedVersion: current.version,
          reason: 'Read the authoritative provider receipt',
        },
        result = await service.reconcile(
          deliveryUser,
          operation.commandId,
          recovery,
          'fixture-recovery',
        );
      expect(result).toMatchObject({ phase: 'completed', outcome: 'cancelled' });
      expect((await stocks())[0]!.stock).toBe(5);
      expect(f.sends.filter((call) => call.kind === 'cancel-item')).toHaveLength(1);
      await service.reconcile(deliveryUser, operation.commandId, recovery, 'fixture-recovery');
      expect((await stocks())[0]!.stock).toBe(5);
      expect(f.sends.filter((call) => call.kind === 'cancel-item')).toHaveLength(1);
    });
    it('runs actual delayed transfer/conversion, releases every owned hold and retains split refund and child-order proofs', async () => {
      const f = fixture(),
        { service, worker } = await arrival();
      f.setNow('2026-11-16T09:00:01Z');
      expect((await worker.runNextJob())?.status).toBe('COMPLETED');
      expect(
        (await stocks()).filter((row) => row.productId === '10').map((row) => row.stock),
      ).toEqual([5, 2, 2]);
      f.setNow('2026-11-16T10:00:02Z');
      expect((await worker.runNextJob())?.status).toBe('COMPLETED');
      await drain(worker);
      const history = await service.recent(deliveryUser, '1', deliveryOrderId),
        converted = history.find((receipt) => receipt.outcome === 'converted');
      expect(converted).toMatchObject({
        phase: 'completed',
        newOrderId: '9007199254743999',
        moneyHistoryId: expect.any(String),
      });
      expect(
        (await stocks()).filter((row) => row.productId === '10').map((row) => row.stock),
      ).toEqual([5, 5, 5]);
      expect(f.sends.filter((call) => call.kind === 'online-convert')).toHaveLength(1);
      expect(f.sends.filter((call) => call.kind === 'split-charge-refund')).toHaveLength(1);
      const [logs] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT location_ids FROM hyperlocal_to_online_order_logs',
      );
      expect(logs[0]!.location_ids).toBe('[2, 3]');
      expect((await f.lines(deliveryOrderId)).map((line) => line.status)).toEqual([
        'CANCELLED',
        'CANCELLED',
        'PLACED',
      ]);
      expect(await f.count('tss_money_history')).toBe(1);
    });
    it('completes an unsplit conversion and credits the exact source floating wallet/history arithmetic once', async () => {
      const f = fixture();
      await f.connection.query("UPDATE orders SET is_split_order=0,next_location_ids='[]'");
      const { service, worker } = await arrival();
      const submitted = await service.submit(
        deliveryUser,
        '1',
        deliveryOrderId,
        'pass',
        input('No backup'),
        'fixture-request',
      );
      await drain(worker);
      expect(await service.view(deliveryUser, submitted.commandId)).toMatchObject({
        phase: 'completed',
        outcome: 'converted',
        moneyHistoryId: expect.any(String),
      });
      const [money] = await f.connection.query<mysql.RowDataPacket[]>(
          'SELECT tss_money,cashback FROM users WHERE id=7',
        ),
        [ledger] = await f.connection.query<mysql.RowDataPacket[]>(
          'SELECT amt_before_update,amt_after_update,added_amt FROM tss_money_history',
        );
      expect(money[0]).toEqual({ tss_money: 60.125, cashback: 60.125 });
      expect(ledger[0]).toMatchObject({
        amt_before_update: 10.125,
        amt_after_update: 60.12,
        added_amt: 50,
      });
      expect(f.sends.filter((call) => call.kind === 'online-convert')).toHaveLength(1);
      await service.submit(
        deliveryUser,
        '1',
        deliveryOrderId,
        'pass',
        { commandId: submitted.commandId, reason: 'No backup' },
        'fixture-request',
      );
      expect(await f.count('tss_money_history')).toBe(1);
    });
    it('does not dispatch after writer-current operator revocation, and retains the pending command for authorized recovery', async () => {
      const f = fixture(),
        { service, worker } = await arrival(),
        submitted = await service.submit(
          deliveryUser,
          '1',
          deliveryOrderId,
          'create',
          input(),
          'fixture-request',
        );
      await f.connection.query('UPDATE pos_user SET is_active=0 WHERE id=44');
      expect((await worker.dispatchNext())?.status).toBe('BLOCKED');
      expect(f.sends).toHaveLength(0);
      expect((await stocks())[0]!.stock).toBe(2);
      await f.connection.query('UPDATE pos_user SET is_active=1 WHERE id=44');
      expect(await service.view(deliveryUser, submitted.commandId)).toMatchObject({
        phase: 'reconciliation-required',
        errorCode: 'CURRENT_AUTHORITY_REQUIRED',
      });
    });
    it('shares one cancellation/RTO movement proof: observer restores once and later physical receipt never adds stock again', async () => {
      const f = fixture(),
        { service, worker } = await arrival(),
        created = await service.submit(
          deliveryUser,
          '1',
          deliveryOrderId,
          'create',
          input(),
          'fixture-request',
        );
      await drain(worker);
      expect((await service.view(deliveryUser, created.commandId)).outcome).toBe('created');
      await f.connection.query('UPDATE orders SET order_status=28 WHERE id=?', [deliveryOrderId]);
      await f.connection.query('UPDATE hyperlocal_order_log SET is_rto=1');
      const cancelled = await service.observeCancellation(
        '1',
        deliveryOrderId,
        { ...input('RTO-intransit'), notify: false },
        'fixture-observer',
      );
      await drain(worker);
      expect((await service.view(deliveryUser, cancelled.commandId)).outcome).toBe('cancelled');
      expect((await stocks())[0]!.stock).toBe(5);
      const rto = legacyFulfillmentService(f.config, f.database, { clock: f.clock });
      expect(await rto.status(deliveryUser, '1', deliveryOrderId)).toMatchObject({
        rtoReceived: false,
        canReceiveRto: true,
      });
      const physical = await rto.execute(
        deliveryUser,
        '1',
        deliveryOrderId,
        'rto-receipt',
        { commandId: randomUUID(), note: 'Physical parcel checked' },
        'fixture-rto',
      );
      expect(physical).toMatchObject({
        outcome: 'rto-received',
        restoredUnits: '0',
        originalCommandId: cancelled.commandId,
      });
      await f.connection.query('UPDATE hyperlocal_order_log SET rto_recieved=0');
      const repeated = await rto.execute(
        deliveryUser,
        '1',
        deliveryOrderId,
        'rto-receipt',
        { commandId: randomUUID(), note: 'Repeated parcel check' },
        'fixture-rto',
      );
      expect(repeated.outcome).toBe('already-recorded');
      expect((await stocks())[0]!.stock).toBe(5);
      expect(await f.count('pos_rewrite_legacy_rto_receipts')).toBe(1);
      expect(f.sends.filter((call) => call.kind === 'cancel-item')).toHaveLength(1);
    });
    it('allows an accepted backup store to receive RTO using current Order.location_id while retaining original main_location_id', async () => {
      const f = fixture(),
        { service, worker } = await arrival();
      await service.submit(deliveryUser, '1', deliveryOrderId, 'pass', input(), 'fixture-request');
      await f.checkin('2');
      await service.submit(
        deliveryUser,
        '2',
        deliveryOrderId,
        'create',
        input(),
        'fixture-request',
      );
      await drain(worker);
      await f.connection.query('UPDATE orders SET order_status=28 WHERE id=?', [deliveryOrderId]);
      await f.connection.query('UPDATE hyperlocal_order_log SET is_rto=1');
      const rto = legacyFulfillmentService(f.config, f.database, {
        stockProcedure: availableStockProjection(f.config.BUSINESS_TIMEZONE, f.clock),
        synchronizationAvailable: true,
        clock: f.clock,
      });
      expect((await rto.status(deliveryUser, '2', deliveryOrderId)).canReceiveRto).toBe(true);
      expect(
        (
          await rto.execute(
            deliveryUser,
            '2',
            deliveryOrderId,
            'rto-receipt',
            { commandId: randomUUID(), note: 'Backup return' },
            'fixture-rto',
          )
        ).restoredUnits,
      ).toBe('3');
      expect(
        (await stocks()).filter((row) => row.productId === '10').map((row) => row.stock),
      ).toEqual([5, 5, 5]);
    });
    it('can refund after a verified RTO inward without restocking again, and deduplicates later observer command IDs by the cancellation proof', async () => {
      const f = fixture(),
        { service, worker } = await arrival();
      await service.submit(
        deliveryUser,
        '1',
        deliveryOrderId,
        'create',
        input(),
        'fixture-request',
      );
      await drain(worker);
      await f.connection.query('UPDATE orders SET order_status=28 WHERE id=?', [deliveryOrderId]);
      await f.connection.query('UPDATE hyperlocal_order_log SET is_rto=1');
      const rto = legacyFulfillmentService(f.config, f.database, {
        stockProcedure: availableStockProjection(f.config.BUSINESS_TIMEZONE, f.clock),
        synchronizationAvailable: true,
        clock: f.clock,
      });
      await rto.execute(
        deliveryUser,
        '1',
        deliveryOrderId,
        'rto-receipt',
        { commandId: randomUUID(), note: 'Returned first' },
        'fixture-rto',
      );
      expect((await stocks())[0]!.stock).toBe(5);
      const observed = await service.observeCancellation(
        '1',
        deliveryOrderId,
        input('RTO-intransit'),
        'fixture-observer',
      );
      await drain(worker);
      expect((await service.view(deliveryUser, observed.commandId)).outcome).toBe('cancelled');
      expect((await stocks())[0]!.stock).toBe(5);
      const repeated = await service.observeCancellation(
        '1',
        deliveryOrderId,
        input('RTO-intransit'),
        'fixture-observer',
      );
      expect(repeated.outcome).toBe('already-recorded');
      expect(f.sends.filter((call) => call.kind === 'cancel-item')).toHaveLength(1);
    });
    it('rolls back the entire arrival hold, actual stock projection, audits, command and job state after a late failure', async () => {
      const f = fixture(),
        native = availableSystemStockProjection(f.config.BUSINESS_TIMEZONE, f.clock);
      let calls = 0;
      const { service } = f.build({
        systemStockProcedure: async (tx, value) => {
          await native(tx, value);
          if (++calls === 2) throw new AppError(409, 'FIXTURE_LATE_FAILURE', 'Fixture failure.');
        },
      });
      await expect(
        service.arrive('1', deliveryOrderId, input(), 'fixture-request'),
      ).rejects.toMatchObject({ code: 'FIXTURE_LATE_FAILURE' });
      expect(calls).toBe(2);
      expect((await stocks()).every((row) => row.stock === 5)).toBe(true);
      for (const table of [
        'pos_rewrite_legacy_fulfillment_commands',
        'pos_rewrite_local_delivery_orders',
        'pos_rewrite_local_delivery_commands',
        'pos_rewrite_local_delivery_jobs',
        'pos_rewrite_administration_outbox',
        'hold_stock_store',
        'pos_hold_stock_logs',
        'product_inventory_logs',
        'pos_inventory_sync_log',
        'pos_transaction_logs',
      ])
        expect(await f.count(table), table).toBe(0);
    });
    it('runs advance-slot notification at the source-selected weekday/first slot even when availability is false and rechecks current recipients', async () => {
      const f = fixture();
      await f.connection.query("UPDATE orders SET start_timeslot='2026-11-17 11:00:00'");
      await f.connection.query("UPDATE pos_hyperlocal_slots SET weekday='TUE',is_avail=0");
      const { service, worker } = await arrival(true);
      expect(await worker.runNextJob()).toBeNull();
      const [addon] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT order_success_timestamp FROM order_addons',
      );
      expect(addon[0]!.order_success_timestamp).toBe('2026-11-17 10:00:00');
      await f.connection.query('UPDATE pos_user SET is_active=0 WHERE id=44');
      f.setNow('2026-11-17T04:30:00Z');
      expect((await worker.runNextJob())?.kind).toBe('advance-notification');
      expect(await worker.runNextJob()).toBeNull();
      expect(await f.count('pos_notifications')).toBe(1);
      expect(await f.count('pos_user_notifications')).toBe(0);
      await drain(worker);
      expect(f.sends.filter((row) => row.kind === 'slack')).toHaveLength(1);
      await f.connection.query('UPDATE pos_user SET is_active=1 WHERE id=44');
      expect((await service.recent(deliveryUser, '1', deliveryOrderId))[0]!.outcome).toBe(
        'arrival-scheduled',
      );
    });
    it('freezes a lost courier outcome and applies its original proof without another creation call or stock consumption', async () => {
      const f = fixture(),
        { service, worker } = await arrival(),
        receipt = await service.submit(
          deliveryUser,
          '1',
          deliveryOrderId,
          'create',
          input(),
          'fixture-request',
        );
      f.loseNext('borzo-create');
      expect((await worker.dispatchNext())?.status).toBe('UNCERTAIN');
      expect(await worker.dispatchNext()).toBeNull();
      const [before] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT stock FROM hold_stock_store',
      );
      expect(before[0]!.stock).toBe(3);
      const current = await service.view(deliveryUser, receipt.commandId);
      const recovered = await service.reconcile(
        deliveryUser,
        receipt.commandId,
        { ...input('Read original courier receipt'), expectedVersion: current.version },
        'fixture-recovery',
      );
      expect(recovered).toMatchObject({ outcome: 'created', courierOrderId: '9007199254742999' });
      await drain(worker);
      expect(f.sends.filter((row) => row.kind === 'borzo-create')).toHaveLength(1);
      expect((await stocks())[0]!.stock).toBe(2);
      const [after] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT stock FROM hold_stock_store',
      );
      expect(after[0]!.stock).toBe(0);
    });
    it('uses a definitive side-effect-free courier rejection to convert once and releases its original reservations', async () => {
      const f = fixture(),
        { service, worker } = await arrival(),
        receipt = await service.submit(
          deliveryUser,
          '1',
          deliveryOrderId,
          'create',
          input(),
          'fixture-request',
        );
      f.rejectCourier();
      await drain(worker);
      expect(await service.view(deliveryUser, receipt.commandId)).toMatchObject({
        phase: 'completed',
        outcome: 'converted',
        newOrderId: '9007199254743999',
      });
      expect(f.sends.filter((row) => row.kind === 'borzo-create')).toHaveLength(1);
      expect(f.sends.filter((row) => row.kind === 'online-convert')).toHaveLength(1);
      expect((await stocks())[0]!.stock).toBe(5);
      expect(await f.count('tss_money_history')).toBe(1);
    });
    it('delivers an independent timeout alert without clearing an uncertain conversion or allowing a second financial dispatch', async () => {
      const f = fixture();
      await f.connection.query("UPDATE orders SET next_location_ids='[]'");
      const { service, worker } = await arrival();
      f.setNow('2026-11-16T09:00:01Z');
      await worker.runNextJob();
      f.loseNext('online-convert');
      expect((await worker.dispatchNext())?.status).toBe('UNCERTAIN');
      expect((await worker.dispatchNext())?.status).toBe('ACKNOWLEDGED');
      expect(await worker.dispatchNext()).toBeNull();
      const current = (await service.recent(deliveryUser, '1', deliveryOrderId)).find(
        (row) => row.action === 'pass',
      )!;
      expect(current).toMatchObject({ phase: 'uncertain', errorCode: 'PROVIDER_OUTCOME_UNKNOWN' });
      expect((await stocks())[0]!.stock).toBe(2);
      expect(await f.count('tss_money_history')).toBe(0);
      await service.reconcile(
        deliveryUser,
        current.commandId,
        { ...input('Read bound online receipt'), expectedVersion: current.version },
        'fixture-recovery',
      );
      await drain(worker);
      expect((await service.view(deliveryUser, current.commandId)).outcome).toBe('converted');
      expect(f.sends.filter((row) => row.kind === 'online-convert')).toHaveLength(1);
      expect(await f.count('tss_money_history')).toBe(1);
    });
    it('refuses a fresh blocked customer before token-dependent conversion dispatch and preserves its held stock', async () => {
      const f = fixture();
      await f.connection.query("UPDATE orders SET next_location_ids='[]'");
      const { service, worker } = await arrival(),
        receipt = await service.submit(
          deliveryUser,
          '1',
          deliveryOrderId,
          'pass',
          input(),
          'fixture-request',
        );
      await f.connection.query('UPDATE users SET is_block=1 WHERE id=7');
      expect((await worker.dispatchNext())?.status).toBe('BLOCKED');
      expect(f.sends).toHaveLength(0);
      expect((await stocks())[0]!.stock).toBe(2);
      expect((await service.view(deliveryUser, receipt.commandId)).phase).toBe(
        'reconciliation-required',
      );
    });
    it('keeps inventory frozen when provider cancellation rows repeat or misattribute a selected HP link', async () => {
      const f = fixture(),
        { service, worker } = await arrival(),
        receipt = await service.submit(
          deliveryUser,
          '1',
          deliveryOrderId,
          'cancel',
          input(),
          'fixture-request',
        );
      f.loseNext('cancel-item');
      await worker.dispatchNext();
      await f.connection.query('UPDATE cancel_orders SET has_product_id=?', [deliveryHpIds[0]]);
      const current = await service.view(deliveryUser, receipt.commandId);
      await service.reconcile(
        deliveryUser,
        receipt.commandId,
        { ...input('Inspect exact affected HPs'), expectedVersion: current.version },
        'fixture-recovery',
      );
      await worker.applyPending();
      expect((await service.view(deliveryUser, receipt.commandId)).phase).toBe(
        'reconciliation-required',
      );
      expect((await stocks())[0]!.stock).toBe(2);
      expect(await f.count('pos_rewrite_legacy_rto_receipts')).toBe(0);
      expect(f.sends.filter((row) => row.kind === 'cancel-item')).toHaveLength(1);
    });
    it('fences a late failed attempt after a proven-not-sent recovery and a successful replacement lease', async () => {
      const f = fixture();
      await arrival();
      let started!: () => void,
        release!: (error: Error) => void,
        calls = 0;
      const waiting = new Promise<void>((resolve) => {
          started = resolve;
        }),
        first = new Promise<never>((_resolve, reject) => {
          release = reject;
        }),
        provider: LegacyProvider = {
          ready: () => true,
          async send(request) {
            if (request.kind === 'borzo-create') {
              if (++calls === 1) {
                started();
                return first;
              }
              return {
                kind: 'courier-created',
                courierOrderId: '9007199254742999',
                sourceTracking: null,
                destinationTracking: null,
              };
            }
            return { kind: 'acknowledged' };
          },
          async reconcile(request) {
            return {
              status: 'not-sent',
              requestHash: providerRequestHash(request),
              safeToSend: true,
            };
          },
        },
        { service, worker } = f.build({ provider }),
        receipt = await service.submit(
          deliveryUser,
          '1',
          deliveryOrderId,
          'create',
          input(),
          'fixture-request',
        ),
        original = worker.dispatchNext();
      await waiting;
      f.setNow('2026-11-16T08:01:01Z');
      expect(await worker.expireClaims()).toEqual({ uncertain: 1 });
      const current = await service.view(deliveryUser, receipt.commandId);
      await service.reconcile(
        deliveryUser,
        receipt.commandId,
        { ...input('Verified original operation was not sent'), expectedVersion: current.version },
        'fixture-recovery',
      );
      expect((await worker.dispatchNext())?.status).toBe('ACKNOWLEDGED');
      expect((await service.view(deliveryUser, receipt.commandId)).phase).toBe('completed');
      release(new AppError(502, 'PROVIDER_OUTCOME_UNKNOWN', 'Fixture late failure.'));
      await original;
      expect((await service.view(deliveryUser, receipt.commandId)).phase).toBe('completed');
      const [rows] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT status,attempts FROM pos_rewrite_local_delivery_calls WHERE sequence_no=0',
      );
      expect(rows[0]).toEqual({ status: 'ACKNOWLEDGED', attempts: 2 });
      expect((await stocks())[0]!.stock).toBe(2);
      expect(calls).toBe(2);
    });
    it('rejects a missing-log arrival before stock/provider work until the reviewed unset-event-date schema is deployed', async () => {
      const f = fixture(),
        { service } = f.build();
      await f.connection.query('DELETE FROM hyperlocal_order_log');
      await expect(
        service.arrive('1', deliveryOrderId, input(), 'fixture-request'),
      ).rejects.toMatchObject({ code: 'LOCAL_DELIVERY_LOG_SCHEMA_UNAVAILABLE' });
      expect((await service.capabilities(deliveryUser, '1', deliveryOrderId)).contractReady).toBe(
        false,
      );
      expect((await stocks())[0]!.stock).toBe(5);
      expect(await f.count('pos_rewrite_local_delivery_commands')).toBe(0);
      expect(f.sends).toHaveLength(0);
    });
    it('keeps missing logs absent during arrival/pass and inserts source defaults only when a backup courier creation succeeds', async () => {
      const f = fixture();
      await f.applyInitialLogCompatibility();
      await f.connection.query('DELETE FROM hyperlocal_order_log');
      const { service, worker } = await arrival();
      expect(await f.count('hyperlocal_order_log')).toBe(0);
      expect((await service.capabilities(deliveryUser, '1', deliveryOrderId)).canCreate).toBe(true);
      await service.submit(deliveryUser, '1', deliveryOrderId, 'pass', input(), 'fixture-request');
      expect(await f.count('hyperlocal_order_log')).toBe(0);
      await f.checkin('2');
      const created = await service.submit(
        deliveryUser,
        '2',
        deliveryOrderId,
        'create',
        input(),
        'fixture-request',
      );
      await drain(worker);
      expect((await service.view(deliveryUser, created.commandId)).outcome).toBe('created');
      const [rows] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT action,main_location_id,delivery_exception_date,created_at,pos_admin_id FROM hyperlocal_order_log',
      );
      expect(rows).toEqual([
        {
          action: 'ACCEPTED',
          main_location_id: 0,
          delivery_exception_date: null,
          created_at: '2026-11-16 13:30:00',
          pos_admin_id: 44,
        },
      ]);
      expect(
        (await stocks()).filter((row) => row.productId === '10').map((row) => row.stock),
      ).toEqual([5, 2, 5]);
    });
    it('inserts one missing source log on manual cancellation without inventing an exception date', async () => {
      const f = fixture();
      await f.applyInitialLogCompatibility();
      await f.connection.query('DELETE FROM hyperlocal_order_log');
      const { service, worker } = await arrival(),
        receipt = await service.submit(
          deliveryUser,
          '1',
          deliveryOrderId,
          'cancel',
          input(),
          'fixture-request',
        );
      await drain(worker);
      expect((await service.view(deliveryUser, receipt.commandId)).outcome).toBe('cancelled');
      const [rows] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT action,main_location_id,delivery_exception_date,is_refunded FROM hyperlocal_order_log',
      );
      expect(rows).toEqual([
        { action: 'DECLINED', main_location_id: 0, delivery_exception_date: null, is_refunded: 1 },
      ]);
      expect((await stocks())[0]!.stock).toBe(5);
    });
    it('creates the missing converted log only after an actual child/refund proof and leaves observer-only source log updates absent', async () => {
      const f = fixture();
      await f.applyInitialLogCompatibility();
      await f.connection.query('DELETE FROM hyperlocal_order_log');
      await f.connection.query("UPDATE orders SET next_location_ids='[]'");
      const { service, worker } = await arrival(),
        receipt = await service.submit(
          deliveryUser,
          '1',
          deliveryOrderId,
          'pass',
          input(),
          'fixture-request',
        );
      await drain(worker);
      expect((await service.view(deliveryUser, receipt.commandId)).outcome).toBe('converted');
      const [rows] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT action,main_location_id,delivery_exception_date FROM hyperlocal_order_log',
      );
      expect(rows).toEqual([
        { action: 'CONVERT_ONLINE', main_location_id: 0, delivery_exception_date: null },
      ]);
      expect(await f.count('tss_money_history')).toBe(1);
    });
    it('preserves source observer update-only behavior for an order that has no courier log', async () => {
      const f = fixture();
      await f.applyInitialLogCompatibility();
      await f.connection.query('DELETE FROM hyperlocal_order_log');
      const { service, worker } = await arrival(),
        receipt = await service.observeCancellation(
          '1',
          deliveryOrderId,
          input('Delivery cancelled'),
          'fixture-request',
        );
      await drain(worker);
      expect((await service.view(deliveryUser, receipt.commandId)).outcome).toBe('cancelled');
      expect(await f.count('hyperlocal_order_log')).toBe(0);
      expect((await stocks())[0]!.stock).toBe(5);
    });
    it('denies ordinary POS orders with no local-delivery identity and rechecks unset-event compatibility before external dispatch', async () => {
      const f = fixture();
      await f.applyInitialLogCompatibility();
      await f.connection.query('DELETE FROM hyperlocal_order_log');
      await f.connection.query('UPDATE has_products SET order_platform_id=5');
      const { service, worker } = f.build();
      await expect(
        service.arrive('1', deliveryOrderId, input(), 'fixture-request'),
      ).rejects.toMatchObject({ code: 'LOCAL_DELIVERY_NOT_FOUND' });
      await f.connection.query('UPDATE has_products SET order_platform_id=4 WHERE prod_id=10');
      await service.arrive('1', deliveryOrderId, input(), 'fixture-request');
      const receipt = await service.submit(
        deliveryUser,
        '1',
        deliveryOrderId,
        'create',
        input(),
        'fixture-request',
      );
      await f.connection.query(
        'ALTER TABLE hyperlocal_order_log MODIFY delivery_exception_date DATETIME NOT NULL',
      );
      expect((await worker.dispatchNext())?.status).toBe('BLOCKED');
      expect(f.sends).toHaveLength(0);
      expect((await service.view(deliveryUser, receipt.commandId)).phase).toBe(
        'reconciliation-required',
      );
      expect((await stocks())[0]!.stock).toBe(2);
    });
    it('proves the exact review-only nullable correction preserves existing dates and fixes the original strict missing-default insert', async () => {
      const f = fixture(),
        [mode] = await f.connection.query<mysql.RowDataPacket[]>(
          'SELECT @@SESSION.sql_mode AS mode',
        ),
        [before] = await f.connection.query<mysql.RowDataPacket[]>(
          'SELECT id,delivery_exception_date,created_at,updated_at FROM hyperlocal_order_log ORDER BY id',
        );
      await f.connection.query("SET SESSION sql_mode='STRICT_TRANS_TABLES'");
      const insert =
          'INSERT INTO hyperlocal_order_log(order_id,action,borzo_id,pos_admin_id,created_at,updated_at)VALUES(?,?,?,?,?,?)',
        args = [
          '9007199254740994',
          'ACCEPTED',
          0,
          44,
          '2026-11-16 13:30:00',
          '2026-11-16 13:30:00',
        ];
      try {
        await expect(f.connection.query(insert, args)).rejects.toMatchObject({
          code: 'ER_NO_DEFAULT_FOR_FIELD',
        });
        await f.applyInitialLogCompatibility();
        const [after] = await f.connection.query<mysql.RowDataPacket[]>(
          'SELECT id,delivery_exception_date,created_at,updated_at FROM hyperlocal_order_log ORDER BY id',
        );
        expect(after).toEqual(before);
        await f.connection.query(insert, args);
        const [rows] = await f.connection.query<mysql.RowDataPacket[]>(
          'SELECT delivery_exception_date FROM hyperlocal_order_log WHERE order_id=?',
          [args[0]],
        );
        expect(rows).toEqual([{ delivery_exception_date: null }]);
      } finally {
        await f.connection.query('SET SESSION sql_mode=?', [mode[0]!.mode]);
      }
    });
  },
);
