import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { publicScreeningFixture, run } from './native-fixture.js';
import {
  publicScreeningCompletionSchema,
  publicScreeningLineHash,
} from '../../src/modules/checkout/screening-writer/completion.js';
import {
  readPublicScreeningCreation,
  publicScreeningHash,
} from '../../src/modules/checkout/screening-writer/proof.js';
import {
  screeningReservationSchema,
  screeningProof,
} from '../../src/modules/legacy-order-imports/screening-profile.js';
import { sourceKey, financialClock } from '../legacy-import-financial/fixture.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('unselected postcommit source effect protocol', () => {
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
  async function fixtureCompletion() {
    const prepared = await f.prepare();
    expect(run(prepared.value)).toHaveProperty('result');
    const creation = await f.db
      .get('writer')
      .transaction((tx) =>
        readPublicScreeningCreation(tx, prepared.state.busyOperationId!, sourceKey),
      );
    if (!creation) throw new Error('Missing source fixture receipt');
    // Pure protocol fixture seal, not production payment certification. The real
    // independently paid Node final-writer remains intentionally unregistered.
    const lines = creation.lines.map((line) => ({
        id: line.id,
        productId: '390238',
        quantity: String(line.quantity),
        inputHash: 'e'.repeat(64),
      })),
      proof = publicScreeningCompletionSchema.parse({
        contract: 'pos-node-screening-completion-v1',
        operationId: creation.operationId,
        creationHash: publicScreeningHash(sourceKey, 'creation', creation),
        orderId: creation.orderId,
        customerId: creation.customerId,
        storeId: creation.storeId,
        counterId: creation.counterId,
        paymentReceiptId: 'fixture-only-verified-payment',
        projectionHash: 'd'.repeat(64),
        lineHash: publicScreeningLineHash(lines),
        completedAt: financialClock + 1,
      }),
      seal = publicScreeningHash(sourceKey, 'completion', proof);
    await f.connection.execute(
      'INSERT INTO pos_rewrite_public_screening_completions VALUES(?,?,?,?)',
      [proof.operationId, proof.orderId, JSON.stringify(proof), seal],
    );
    await f.connection.execute(
      "INSERT INTO pos_rewrite_checkout_projections VALUES(?,1,2,77,?,?,'pos-checkout-projection-v1',NOW())",
      [proof.orderId, proof.projectionHash, lines.length],
    );
    for (const line of lines)
      await f.connection.execute(
        'INSERT INTO pos_rewrite_checkout_projection_lines VALUES(?,?,?,?,?)',
        [proof.orderId, line.id, line.productId, line.quantity, line.inputHash],
      );
    const [rows] = await f.connection.query(
        'SELECT data FROM pos_rewrite_import_screening_reservations',
      ),
      held = screeningReservationSchema.parse((rows as { data: unknown }[])[0]!.data),
      counted = screeningReservationSchema.parse({
        ...held,
        phase: 'COUNTED',
        completionHash: seal,
        version: held.version + 1,
        updatedAt: financialClock + 1,
      });
    await f.connection.execute(
      'UPDATE pos_rewrite_import_screening_reservations SET data=?,proof_hash=?',
      [JSON.stringify(counted), screeningProof(sourceKey, 'state', counted)],
    );
    return { prepared, proof };
  }
  it('cannot publish pending creation from a mutable paid flag or missing final seal', async () => {
    const p = await f.prepare();
    expect(run(p.value)).toHaveProperty('result');
    await f.mutateWatched('UPDATE orders SET payment_status=4,order_status=3');
    expect(
      run({ ...p.value, action: 'effects', operationId: p.state.busyOperationId }),
    ).toMatchObject({ code: 'SCREENING_WRITER_SCOPE_CHANGED' });
    const [rows] = await f.connection.query(
      'SELECT status FROM pos_rewrite_public_screening_effects',
    );
    expect(rows).toMatchObject([{ status: 'pending' }]);
  });
  it('accepts one original durable source queue publication and never repeats an acknowledged batch', async () => {
    const { prepared } = await fixtureCompletion(),
      input = { ...prepared.value, action: 'effects', operationId: prepared.state.busyOperationId };
    expect(run(input)).toMatchObject({ status: 'accepted', queueCalls: 2 });
    expect(run(input)).toMatchObject({ status: 'accepted', queueCalls: 0 });
    const [rows] = await f.connection.query(
      'SELECT payload FROM pos_rewrite_public_screening_effects',
    );
    expect(JSON.stringify(rows)).not.toContain('private-import@example.test');
  });
  it.each(['hash', 'header', 'lines', 'scope'] as const)(
    'refuses changed %s proof before claiming or publishing',
    async (field) => {
      const { prepared } = await fixtureCompletion();
      if (field === 'hash')
        await f.connection.query(
          "UPDATE pos_rewrite_public_screening_completions SET proof_hash=REPEAT('f',64)",
        );
      if (field === 'header')
        await f.connection.query(
          "UPDATE pos_rewrite_checkout_projections SET input_hash=REPEAT('f',64)",
        );
      if (field === 'lines')
        await f.connection.query('UPDATE pos_rewrite_checkout_projection_lines SET quantity=9');
      if (field === 'scope')
        await f.connection.query('UPDATE pos_rewrite_checkout_projections SET store_id=2');
      expect(
        run({ ...prepared.value, action: 'effects', operationId: prepared.state.busyOperationId }),
      ).toHaveProperty('code');
      const [rows] = await f.connection.query(
        'SELECT status FROM pos_rewrite_public_screening_effects',
      );
      expect(rows).toMatchObject([{ status: 'pending' }]);
    },
  );
});
