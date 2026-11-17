import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { checkInService } from '../../src/modules/administration/checkins.js';
import type { Principal } from '../../src/domain/access.js';
import { nodeScreeningWriterIssuer } from '../../src/modules/checkout/screening-writer/issuer.js';
import { publicScreeningAbandonment } from '../../src/modules/checkout/screening-writer/abandon.js';
import { assertPublicScreeningOrderAvailable } from '../../src/modules/checkout/screening-writer/proof.js';
import { publicScreeningFixture, run, environment } from './native-fixture.js';
import { sourceKey, financialClock } from '../legacy-import-financial/fixture.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL,
  user: Principal = {
    id: '1',
    name: 'Fixture manager',
    email: 'fixture@example.test',
    role: 1,
    userType: 1,
    storeIds: [],
  };
describe.skipIf(!template)('native Node admission and unpaid screening fence', () => {
  let f: Awaited<ReturnType<typeof publicScreeningFixture>>;
  beforeAll(async () => {
    f = await publicScreeningFixture(template!);
  }, 30000);
  beforeEach(async () => {
    await f.reset();
  });
  afterAll(async () => {
    await f?.close();
  });
  function services(authSessionValid: () => Promise<boolean> = async () => true) {
    const common = {
      db: f.db,
      config: f.config,
      checkins: checkInService(f.db, f.config),
      authSessionValid,
      clock: () => financialClock,
    };
    return {
      issuer: nodeScreeningWriterIssuer({ ...common, environment }),
      abandon: publicScreeningAbandonment({ ...common, proofKey: sourceKey }),
    };
  }
  it('mints only from the persisted busy order operation and current writer identity/contact', async () => {
    const p = await f.prepare(),
      issued = await services().issuer.issue(
        user,
        { storeId: '1', checkoutId: p.state.id, operationId: p.state.busyOperationId! },
        p.value.payload,
      );
    expect(issued).toEqual(p.signed);
    await f.connection.query("UPDATE pos_rewrite_checkout_operations SET status='uncertain'");
    await expect(
      services().issuer.issue(
        user,
        { storeId: '1', checkoutId: p.state.id, operationId: p.state.busyOperationId! },
        p.value.payload,
      ),
    ).rejects.toMatchObject({ code: 'SCREENING_WRITER_SCOPE_CHANGED' });
  });
  it('does not publish a capability after an awaited session revocation', async () => {
    const p = await f.prepare();
    let calls = 0;
    await expect(
      services(async () => ++calls === 1).issuer.issue(
        user,
        { storeId: '1', checkoutId: p.state.id, operationId: p.state.busyOperationId! },
        p.value.payload,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(calls).toBe(2);
  });
  async function created() {
    const p = await f.prepare();
    expect(run(p.value)).toHaveProperty('result');
    const command = {
      operationId: randomUUID(),
      sourceOperationId: p.state.busyOperationId!,
      storeId: '1',
      counterId: '2',
      reason: 'cash-abandoned' as const,
    };
    return { p, command };
  }
  it('fences a lost source reply once without deleting the original order/HP/markers', async () => {
    const { p, command } = await created(),
      service = services().abandon,
      receipts = await Promise.all(
        Array.from({ length: 20 }, () => service.abandon(user, command)),
      );
    expect(receipts.every((value) => JSON.stringify(value) === JSON.stringify(receipts[0]))).toBe(
      true,
    );
    const { reason: _reason, ...readScope } = command;
    expect(await service.read(user, readScope)).toEqual(receipts[0]);
    expect(await service.read(user, { ...readScope, operationId: randomUUID() })).toBeNull();
    const [orders] = await f.connection.query('SELECT order_status,payment_status FROM orders');
    expect(orders).toMatchObject([{ order_status: 0, payment_status: 0 }]);
    const [markers] = await f.connection.query(
      'SELECT COUNT(*) AS n FROM spiderman_screening_orders',
    );
    expect(markers).toMatchObject([{ n: '1' }]);
    const [held] = await f.connection.query(
      'SELECT data FROM pos_rewrite_import_screening_reservations',
    );
    expect(held).toMatchObject([
      { data: { phase: 'REJECTED', orderId: null, sourceReceiptHash: null } },
    ]);
    await expect(
      f.db
        .get('writer')
        .transaction((tx) => assertPublicScreeningOrderAvailable(tx, receipts[0]!.orderId)),
    ).rejects.toMatchObject({ code: 'SCREENING_ORDER_ABANDONED' });
    // The original lost source command stays retained; a new explicitly prepared
    // checkout can use the released quota without rewriting the old receipt.
    const next = await f.prepare();
    expect(next.state.id).not.toBe(p.state.id);
    expect(run(next.value)).toHaveProperty('result');
  });
  it.each(['provider-unknown', 'projection', 'cash', 'wallet', 'membership'] as const)(
    'retains credit for %s evidence',
    async (kind) => {
      const { command } = await created();
      const [rows] = await f.connection.query(
        'SELECT order_id FROM pos_rewrite_public_screening_orders',
      );
      const orderId = (rows as { order_id: string }[])[0]!.order_id;
      if (kind === 'provider-unknown')
        await f.connection.execute(
          "INSERT INTO pos_rewrite_payment_attempts VALUES(?,?,?,'1','uncertain','{}',NOW(),NOW())",
          [randomUUID(), orderId, '1'],
        );
      if (kind === 'projection')
        await f.connection.execute(
          "INSERT INTO pos_rewrite_checkout_projections VALUES(?,1,2,77,?,1,'pos-checkout-projection-v1',NOW())",
          [orderId, 'a'.repeat(64)],
        );
      if (kind === 'cash') await f.connection.query('UPDATE order_stores SET offline_payment=50');
      if (kind === 'wallet') await f.connection.query('UPDATE orders SET tss_money_used=1');
      if (kind === 'membership')
        await f.connection.execute(
          "INSERT INTO pos_rewrite_cancellation_membership_provenance(order_id,customer_id,revision,header_hash,before_state,confirmed_state,proof_hash,contract_version,operation_id,created_at) VALUES(?,77,1,?,'[]','[]',?,'pos-cancellation-membership-staged-v2',?,NOW())",
          [orderId, 'a'.repeat(64), 'b'.repeat(64), randomUUID()],
        );
      await expect(services().abandon.abandon(user, command)).rejects.toBeDefined();
      const [held] = await f.connection.query(
        'SELECT data FROM pos_rewrite_import_screening_reservations',
      );
      expect(held).toMatchObject([{ data: { phase: 'BOUND' } }]);
      const [count] = await f.connection.query(
        'SELECT COUNT(*) AS n FROM pos_rewrite_public_screening_abandonments',
      );
      expect(count).toMatchObject([{ n: '0' }]);
    },
  );
  it('refuses a revoked manager before changing the original hold', async () => {
    const { command } = await created();
    let checks = 0;
    await expect(
      services(async () => ++checks === 1).abandon.abandon(user, command),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const [held] = await f.connection.query(
      'SELECT data FROM pos_rewrite_import_screening_reservations',
    );
    expect(held).toMatchObject([{ data: { phase: 'BOUND' } }]);
    const [receipts] = await f.connection.query(
      'SELECT COUNT(*) AS n FROM pos_rewrite_public_screening_abandonments',
    );
    expect(receipts).toMatchObject([{ n: '0' }]);
  });
  it('rolls back the tombstone, quota release and effect cancellation together', async () => {
    const { command } = await created();
    await f.connection.query(
      "CREATE TRIGGER public_screening_fixture_rollback BEFORE UPDATE ON pos_rewrite_import_screening_reservations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture rollback'",
    );
    try {
      await expect(services().abandon.abandon(user, command)).rejects.toBeDefined();
    } finally {
      await f.connection.query('DROP TRIGGER public_screening_fixture_rollback');
    }
    const [held] = await f.connection.query(
      'SELECT data FROM pos_rewrite_import_screening_reservations',
    );
    expect(held).toMatchObject([{ data: { phase: 'BOUND' } }]);
    const [effects] = await f.connection.query(
      'SELECT status FROM pos_rewrite_public_screening_effects',
    );
    expect(effects).toMatchObject([{ status: 'pending' }]);
    const [count] = await f.connection.query(
      'SELECT COUNT(*) AS n FROM pos_rewrite_public_screening_abandonments',
    );
    expect(count).toMatchObject([{ n: '0' }]);
  });
});
