import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { publicScreeningAbandonment } from '../../src/modules/checkout/screening-writer/abandon.js';
import { readPublicScreeningCreation } from '../../src/modules/checkout/screening-writer/proof.js';
import { publicScreeningFixture, run, runAsync } from './native-fixture.js';
import { sourceKey, financialClock } from '../legacy-import-financial/fixture.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL,
  binary = process.env.POS_PUBLIC_SCREENING_GO_BINARY;
describe.skipIf(!template)('current public-source concurrency and retained outcomes', () => {
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
  async function secondScope(customer = '78') {
    await f.fixture.insert('pos_user', {
      id: '2',
      username: 'other-fixture',
      role: 1,
      user_type: 1,
      is_active: 1,
    });
    await f.fixture.insert('stores', {
      id: '2',
      type: 'STORE',
      is_active: 1,
      city_id: 10,
      store_name: 'Other fixture',
      address: 'Road',
      alt_address: '',
      phone: '9000000000',
      pincode: '400001',
    });
    await f.fixture.insert('store_counters', { id: '4', store_id: '2', is_active: 1 });
    if (customer === '78') {
      await f.fixture.insert('users', {
        id: '78',
        email: 'other-fixture@example.test',
        telephone: '',
        status: 1,
        is_block: 0,
        is_disabled: 0,
        cashback: 0,
        tss_money: 0,
        tss_points: 0,
      });
      await f.sourceFixture.insert('has_addresses', { id: 89, user_id: 78 });
    }
    await f.fixture.insert('product_store', {
      id: '3',
      store_id: '2',
      product_id: '390238',
      stock: 100,
      is_avail: 1,
      is_del: 0,
    });
    await f.connection.query(
      "INSERT INTO pos_rewrite_operator_checkins VALUES('2',2,4,'2099-06-15 23:59:59','2026-06-15 00:00:00')",
    );
    return { actorId: '2', customerId: customer, storeId: '2', counterId: '4' };
  }
  it('two customers reach both literal bodies before either receipt is visible, without gap-lock retries', async () => {
    const scope = await secondScope(),
      a = await f.prepare(),
      b = await f.prepare(2, false, scope),
      folder = mkdtempSync(join(tmpdir(), 'pos-public-screening-')),
      gate = join(folder, 'release'),
      one = runAsync({ ...a.value, gate }),
      two = runAsync({ ...b.value, gate });
    try {
      await Promise.all([one.ready, two.ready]);
      const [visible] = await f.connection.query('SELECT COUNT(*) AS n FROM orders');
      expect(visible).toMatchObject([{ n: '0' }]);
      writeFileSync(gate, 'release');
      expect(await one.completed).toHaveProperty('result');
      expect(await two.completed).toHaveProperty('result');
      const [rows] = await f.connection.query(
        'SELECT COUNT(*) AS n FROM pos_rewrite_public_screening_orders',
      );
      expect(rows).toMatchObject([{ n: '2' }]);
    } finally {
      one.stop();
      two.stop();
      rmSync(folder, { recursive: true, force: true });
    }
  }, 20000);
  it('same-customer cross-store admission retains pending0 credit instead of admitting four units', async () => {
    const scope = await secondScope('77'),
      a = await f.prepare(),
      b = await f.prepare(2, false, scope);
    // Each source command has its original owned checkout; the active lease is
    // deliberately returned to the first only until it commits.
    await f.connection.execute(
      'UPDATE pos_rewrite_customer_cart_leases SET checkout_id=? WHERE customer_id=77',
      [a.state.id],
    );
    expect(run(a.value)).toHaveProperty('result');
    await f.connection.execute(
      'UPDATE pos_rewrite_customer_cart_leases SET checkout_id=? WHERE customer_id=77',
      [b.state.id],
    );
    expect(run(b.value)).toMatchObject({ code: 'SCREENING_WRITER_LIMIT' });
    const [rows] = await f.connection.query('SELECT COUNT(*) AS n FROM orders');
    expect(rows).toMatchObject([{ n: '1' }]);
  });
  it.skipIf(!binary)(
    'literal Python order → actual Go Apply → Node immutable creation read; replay never reapplies',
    async () => {
      const prepared = await f.prepare();
      expect(run(prepared.value)).toHaveProperty('result');
      const proof = await f.db
        .get('writer')
        .transaction((tx) =>
          readPublicScreeningCreation(tx, prepared.state.busyOperationId!, sourceKey),
        );
      expect(proof).not.toBeNull();
      const executed = spawnSync(
        binary!,
        ['-test.run=^TestPublicScreeningExistingSource$', '-test.v'],
        {
          input: JSON.stringify({
            url: f.config.MYSQL_WRITER_URL,
            proofKey: sourceKey,
            orderId: Number(proof!.orderId),
            expectRejected: false,
          }),
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 32000,
          env: { ...process.env, POS_PUBLIC_SCREENING_FIXTURE: '1' },
        },
      );
      expect(executed.status, executed.stdout).toBe(0);
      expect(executed.stdout).toContain('PUBLIC_SCREENING_CONFIRMED');
      expect(
        await f.db
          .get('writer')
          .transaction((tx) =>
            readPublicScreeningCreation(tx, prepared.state.busyOperationId!, sourceKey),
          ),
      ).toEqual(proof);
      const [rows] = await f.connection.query(
        'SELECT data FROM pos_rewrite_import_screening_reservations',
      );
      expect(rows).toMatchObject([{ data: { kind: 'pos', phase: 'BOUND' } }]);
    },
    30000,
  );
  it.skipIf(!binary)(
    'a confirmed unpaid abandonment fences a delayed actual Go attempt after a lost source reply',
    async () => {
      const p = await f.prepare();
      expect(run(p.value)).toHaveProperty('result');
      const proof = await publicScreeningAbandonment({
        config: f.config,
        db: f.db,
        proofKey: sourceKey,
        checkins: checkInService(f.db, f.config),
        authSessionValid: async () => true,
        clock: () => financialClock,
      }).abandon(
        {
          id: '1',
          name: 'Fixture',
          email: 'fixture@example.test',
          role: 1,
          userType: 1,
          storeIds: [],
        },
        {
          operationId: randomUUID(),
          sourceOperationId: p.state.busyOperationId!,
          storeId: '1',
          counterId: '2',
          reason: 'cash-abandoned',
        },
      );
      expect(() =>
        execFileSync(binary!, ['-test.run=^TestPublicScreeningExistingSource$', '-test.v'], {
          input: JSON.stringify({
            url: f.config.MYSQL_WRITER_URL,
            proofKey: sourceKey,
            orderId: Number(proof.orderId),
            expectRejected: true,
          }),
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 32000,
          env: { ...process.env, POS_PUBLIC_SCREENING_FIXTURE: '1' },
        }),
      ).not.toThrow();
      const [rows] = await f.connection.query(
        'SELECT COUNT(*) AS n FROM pos_rewrite_checkout_projections',
      );
      expect(rows).toMatchObject([{ n: '0' }]);
    },
    30000,
  );
});
