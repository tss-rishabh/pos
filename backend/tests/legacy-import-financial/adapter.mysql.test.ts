import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { importFinancialFixture, financialPlan, financialClock, sourceKey } from './fixture.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import { legacyOrderImportFinancialApprovals } from '../../src/modules/legacy-order-imports/financial-adapter-approval.js';
import {
  expectedFinancialPlanHash,
  financialSourceHash,
} from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import { assertImportOrderMutationAvailable } from '../../src/modules/legacy-order-imports/financial-adapter-proof.js';
import { financialImportSourceReceipts } from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import { PosUser, Order } from '../../src/db/legacy-schema.js';
import { runtimeImportSecret } from '../legacy-order-imports/runtime-fixture.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('native legacy CSV financial journal', () => {
  let f: Awaited<ReturnType<typeof importFinancialFixture>>;
  beforeAll(async () => {
    f = await importFinancialFixture(template!);
  }, 30000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.reset();
  });
  it('settles a source-confirmed cash import exactly once and retains HP PLACED/custom date', async () => {
    const transport = f.transport(),
      order = vi.spyOn(transport, 'order'),
      confirmation = vi.spyOn(transport, 'confirm'),
      publication = vi.spyOn(transport, 'publication');
    const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport),
      input = f.input();
    const result = await adapter.start(input);
    expect(result.status).toBe('completed');
    expect(await adapter.read(input)).toEqual(result);
    expect(await adapter.start(input)).toEqual(result);
    expect([
      order.mock.calls.length,
      confirmation.mock.calls.length,
      publication.mock.calls.length,
    ]).toEqual([1, 1, 1]);
    const [orders] = await f.connection.query(
      'SELECT payment_status,order_status,updated_at FROM orders',
    );
    expect(orders).toEqual([
      expect.objectContaining({
        payment_status: 4,
        order_status: 3,
        updated_at: input.plan.createdAt,
      }),
    ]);
    const [lines] = await f.connection.query('SELECT status,updated_at FROM has_products');
    expect(lines).toEqual([
      expect.objectContaining({ status: 'PLACED', updated_at: input.plan.createdAt }),
    ]);
    const [mappings] = await f.connection.query(
      'SELECT transaction_id,offline_payment,online_other_payment FROM order_stores',
    );
    expect(mappings).toEqual([
      expect.objectContaining({
        transaction_id: 'FIXTURE-REF',
        offline_payment: 50,
        online_other_payment: 0,
      }),
    ]);
    await expect(
      f.db
        .get('writer')
        .transaction((tx) =>
          assertImportOrderMutationAvailable(tx, '9007199254740995', runtimeImportSecret),
        ),
    ).resolves.toBeUndefined();
  });
  it('preserves source pending method15 Shopify semantics and changes stock once', async () => {
    const transport = f.transport(),
      confirmation = vi.spyOn(transport, 'confirm'),
      input = f.input(financialPlan('shopify'));
    const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport);
    const result = await adapter.start(input);
    expect(result.status).toBe('completed');
    expect(confirmation).not.toHaveBeenCalled();
    expect(await adapter.start(input)).toEqual(result);
    const [orders] = await f.connection.query(
      'SELECT payment_method,payment_status,order_status FROM orders',
    );
    expect(orders).toEqual([
      expect.objectContaining({ payment_method: 15, payment_status: 1, order_status: 1 }),
    ]);
    const [stock] = await f.connection.query('SELECT stock FROM product_store');
    expect(stock).toEqual([{ stock: 98 }]);
    const [logs] = await f.connection.query('SELECT COUNT(*) AS n FROM pos_transaction_logs');
    expect(logs).toEqual([{ n: '0' }]);
  });
  it('twenty simultaneous starts reserve one immutable operation and one dispatch', async () => {
    const transport = f.transport(),
      start = vi.spyOn(transport, 'order'),
      input = f.input();
    const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport);
    const results = await Promise.all(Array.from({ length: 20 }, () => adapter.start(input)));
    expect(start).toHaveBeenCalledTimes(1);
    expect(results.every((result) => ['unknown', 'completed'].includes(result.status))).toBe(true);
    expect((await adapter.read(input))?.status).toBe('completed');
  }, 30000);
  it('lost original order reply never starts confirmation or resends order', async () => {
    const transport = f.transport(),
      original = transport.order;
    transport.order = vi.fn(async (input) => {
      await original(input);
      throw new Error('private body canary');
    });
    const confirmation = vi.spyOn(transport, 'confirm'),
      adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport),
      input = f.input();
    const result = await adapter.start(input);
    expect(result).toMatchObject({
      status: 'unknown',
      stage: 'order',
      orderId: '9007199254740995',
    });
    for (let count = 0; count < 3; count++) expect(await adapter.read(input)).toEqual(result);
    expect(await adapter.start(input)).toEqual(result);
    expect(transport.order).toHaveBeenCalledTimes(1);
    expect(confirmation).not.toHaveBeenCalled();
    await expect(
      f.db
        .get('writer')
        .transaction((tx) =>
          assertImportOrderMutationAvailable(tx, '9007199254740995', runtimeImportSecret),
        ),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_ORDER_HELD' });
  });
  it('lost confirmation reply does not settle or redispatch an already confirmed stock mutation', async () => {
    const transport = f.transport(),
      original = transport.confirm;
    transport.confirm = vi.fn(async (...args: Parameters<typeof original>) => {
      await original(...args);
      throw new Error('lost');
    });
    const publish = vi.spyOn(transport, 'publication'),
      adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport),
      input = f.input();
    expect(await adapter.start(input)).toMatchObject({ status: 'unknown', stage: 'confirmation' });
    await adapter.start(input);
    await adapter.read(input);
    expect(transport.confirm).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    const [rows] = await f.connection.query('SELECT payment_status FROM orders');
    expect(rows).toEqual([{ payment_status: 1 }]);
  });
  it('native completion recovers a lost final publication reply without republishing', async () => {
    const transport = f.transport(),
      original = transport.publication;
    transport.publication = vi.fn(async (...args: Parameters<typeof original>) => {
      await original(...args);
      throw new Error('lost committed reply');
    });
    const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport),
      input = f.input();
    expect((await adapter.start(input)).status).toBe('completed');
    await adapter.read(input);
    expect(transport.publication).toHaveBeenCalledTimes(1);
  });
  it('HTTP success with no native confirmation proof remains unknown and cannot record cash', async () => {
    const transport = f.transport();
    transport.confirm = async () => {};
    const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport),
      input = f.input();
    expect(await adapter.start(input)).toMatchObject({ status: 'unknown', stage: 'confirmation' });
    const [rows] = await f.connection.query('SELECT offline_payment FROM order_stores');
    expect(rows).toEqual([{ offline_payment: 0 }]);
  });
  it('rolls back late dated-settlement SQL failures while retaining confirmed upstream stock', async () => {
    await f.connection.query(
      "CREATE TRIGGER import_late_error BEFORE INSERT ON pos_transaction_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture rollback'",
    );
    try {
      const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, f.transport());
      expect(await adapter.start(f.input())).toMatchObject({
        status: 'unknown',
        stage: 'settlement',
      });
      const [order] = await f.connection.query('SELECT payment_status FROM orders');
      expect(order).toEqual([{ payment_status: 1 }]);
      const [mappings] = await f.connection.query('SELECT offline_payment FROM order_stores');
      expect(mappings).toEqual([{ offline_payment: 0 }]);
      const [comments] = await f.connection.query('SELECT COUNT(*) AS n FROM comments');
      expect(comments).toEqual([{ n: '0' }]);
    } finally {
      await f.connection.query('DROP TRIGGER import_late_error');
    }
  });
  it('uses an immutable no-effects source rejection and blocks changed requests/replayed nonces', async () => {
    const transport = f.transport();
    transport.order = async (input) => {
      const proof = {
        contract: 'pos-legacy-order-import-source-v1',
        operationId: input.state.scope.operationId,
        requestHash: input.state.requestHash,
        namespace: input.state.namespace,
        status: 'rejected',
        code: 'ORDER_IMPORT_CUSTOM_PRICE_MISMATCH',
        noFinancialEffects: true,
      };
      await f.db
        .get('writer')
        .insert(financialImportSourceReceipts)
        .values({
          id: input.state.scope.operationId + ':order',
          operationId: input.state.scope.operationId,
          kind: 'order',
          requestHash: input.state.requestHash,
          status: 'rejected',
          proof,
          proofHash: financialSourceHash(sourceKey, 'rejection', proof),
          createdAt: financialClock,
        });
    };
    const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport),
      input = f.input();
    const result = await adapter.start(input);
    expect(result).toMatchObject({
      status: 'rejected',
      code: 'ORDER_IMPORT_CUSTOM_PRICE_MISMATCH',
    });
    expect(await adapter.read(input)).toEqual(result);
    const changed = { ...input, plan: { ...input.plan, reference: 'different' } };
    changed.planHash = expectedFinancialPlanHash(runtimeImportSecret, changed, changed.plan);
    await expect(adapter.start(changed)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_PLAN_CHANGED',
    });
  });
  it('requires a bound backdate/closed-period approval before dispatch and stales only latest close', async () => {
    const plan = { ...financialPlan(), createdAt: '2026-06-14 12:00:00' },
      input = f.input(plan);
    await f.fixture.insert('store_day_close', {
      id: '1',
      store_id: 1,
      close_date: '2026-06-14',
      version: 1,
      status: 'CLOSED',
      cash_system: '123.00',
    });
    await f.fixture.insert('store_day_close', {
      id: '2',
      store_id: 1,
      close_date: '2026-06-14',
      version: 2,
      status: 'CLOSED',
      cash_system: '456.00',
    });
    const transport = f.transport(),
      start = vi.spyOn(transport, 'order'),
      adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport);
    expect(
      await f.db.get('writer').transaction((tx) => adapter.authorizeStart!(tx, input)),
    ).toEqual({ ready: false, code: 'ORDER_IMPORT_APPROVAL_REQUIRED' });
    expect(start).not.toHaveBeenCalled();
    const approvals = legacyOrderImportFinancialApprovals(f.config, f.db, f.options);
    const request = {
      approverId: '1',
      scope: {
        actorId: input.actorId,
        operationId: input.operationId,
        storeId: input.storeId,
        counterId: input.counterId,
      },
      plan: input.plan,
      planHash: input.planHash,
      commandId: randomUUID(),
      reason: 'historical-correction' as const,
    };
    const approval = await approvals.request(request);
    expect(await approvals.request(request)).toEqual(approval);
    expect(
      await f.db.get('writer').transaction((tx) => adapter.authorizeStart!(tx, input)),
    ).toEqual({ ready: true });
    expect((await adapter.start(input)).status).toBe('completed');
    const [rows] = await f.connection.query(
      'SELECT id,status,cash_system FROM store_day_close ORDER BY version',
    );
    expect(rows).toEqual([
      { id: '1', status: 'CLOSED', cash_system: '123.00' },
      { id: '2', status: 'STALE', cash_system: '456.00' },
    ]);
  });
  it('rejects stale actor/contact authority before a later dispatch and retains original native order', async () => {
    const transport = f.transport(),
      original = transport.order;
    transport.order = async (input) => {
      await original(input);
      await f.db.get('writer').update(PosUser).set({ is_active: false }).where(eq(PosUser.id, 1n));
    };
    const confirm = vi.spyOn(transport, 'confirm'),
      adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, transport),
      input = f.input();
    expect(await adapter.start(input)).toMatchObject({ status: 'unknown', stage: 'order' });
    expect(confirm).not.toHaveBeenCalled();
    // Original service read-only reconciliation remains possible after archive.
    expect(await adapter.read(input)).toMatchObject({
      status: 'unknown',
      orderId: '9007199254740995',
    });
  });
  it('immutable sealed completion survives later legitimate status/price/contact changes', async () => {
    const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, f.transport()),
      input = f.input(),
      result = await adapter.start(input);
    expect(result.status).toBe('completed');
    await f.db
      .get('writer')
      .update(Order)
      .set({ payment_statuses: 5n, order_statuses: 8n, pay_amt: 0 })
      .where(eq(Order.id, 9007199254740995n));
    await f.connection.query("UPDATE has_products SET price=1,status='RETURN_RECEIVED'");
    await f.connection.query(
      "UPDATE users SET email='changed@example.test',is_block=1 WHERE id=77",
    );
    expect(await adapter.read(input)).toEqual(result);
    await f.connection.query('DELETE FROM pos_rewrite_import_financial_proofs');
    await expect(
      f.db
        .get('writer')
        .transaction((tx) =>
          assertImportOrderMutationAvailable(tx, '9007199254740995', runtimeImportSecret),
        ),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_ORDER_HELD' });
  });
});

// A prior nonlocking RR read must not certify a stale native line identity.
describe.skipIf(!template)('financial import current structural evidence', () => {
  it('refuses a concurrent HP quantity change after an established repeatable-read snapshot', async () => {
    const f = await importFinancialFixture(template!);
    try {
      await f.reset();
      const adapter = legacyOrderImportFinancialAdapter(f.config, f.db, f.options, f.transport());
      expect((await adapter.start(f.input())).status).toBe('completed');
      await f.db.get('writer').transaction(async (tx) => {
        await tx.execute(sql`SELECT qty FROM has_products WHERE id=9007199254740997`);
        await f.connection.query('UPDATE has_products SET qty=3 WHERE id=9007199254740997');
        await expect(
          assertImportOrderMutationAvailable(tx, '9007199254740995', runtimeImportSecret),
        ).rejects.toMatchObject({ code: 'ORDER_IMPORT_RECEIPT_INVALID' });
      });
    } finally {
      await f.close();
    }
  }, 30000);
});
