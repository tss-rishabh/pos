import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  publicScreeningFixture,
  run as createSource,
} from '../public-screening-writer/native-fixture.js';
import { sourceKey, financialClock } from '../legacy-import-financial/fixture.js';
import {
  readPublicScreeningCreation,
  publicScreeningHash,
} from '../../src/modules/checkout/screening-writer/proof.js';
import {
  publicScreeningCompletionSchema,
  publicScreeningLineHash,
} from '../../src/modules/checkout/screening-writer/completion.js';
import {
  screeningReservationSchema,
  screeningProof,
} from '../../src/modules/legacy-order-imports/screening-profile.js';
import { operationHash } from '../../src/modules/checkout/crypto.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const publication = z
  .object({
    data: z
      .object({
        contract: z.literal('pos-node-screening-publication-v1'),
        operationId: z.uuid(),
        creationHash: hash,
        completionHash: hash,
        effectsHash: hash,
        status: z.enum(['pending', 'processing', 'uncertain', 'accepted', 'cancelled']),
        deliveries: z.array(z.object({ id: z.string(), kind: z.string() }).strict()),
        updatedAt: z.number().int(),
      })
      .strict(),
    proofHash: hash,
  })
  .strict();
const response = z
  .object({
    responses: z.array(z.object({ status: z.string(), body: z.unknown() }).strict()),
    queueCalls: z.number().int(),
    events: z.array(
      z
        .object({
          module: z.literal('public-screening'),
          resource: z.literal('publications'),
          eventId: z.string(),
          requestId: z.string().nullable(),
          userId: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

describe.skipIf(!template)('private post-completion publication resource/native proof', () => {
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
  function run(
    operationId: string,
    methods: ('POST' | 'GET')[],
    extra: { mode?: 'unknown'; badKey?: boolean; recoveryOnly?: boolean } = {},
  ) {
    return response.parse(
      JSON.parse(
        execFileSync(
          resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
          ['-B', resolve('tools/source-runtime-acceptance/publication_native_driver.py')],
          {
            encoding: 'utf8',
            timeout: 20000,
            maxBuffer: 64000,
            input: JSON.stringify({
              url: f.config.MYSQL_WRITER_URL,
              operationId,
              methods,
              proofKey: sourceKey,
              now: financialClock + 2,
              ...extra,
            }),
          },
        ),
      ) as unknown,
    );
  }
  async function completed() {
    const p = await f.prepare();
    expect(createSource(p.value)).toHaveProperty('result');
    const creation = await f.db
      .get('writer')
      .transaction((tx) => readPublicScreeningCreation(tx, p.state.busyOperationId!, sourceKey));
    if (!creation) throw new Error('Missing native fixture receipt');
    const lines = creation.lines.map((line) => ({
      id: line.id,
      productId: '390238',
      quantity: String(line.quantity),
      inputHash: 'e'.repeat(64),
    }));
    const value = publicScreeningCompletionSchema.parse({
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
    });
    const seal = publicScreeningHash(sourceKey, 'completion', value);
    await f.connection.execute(
      'INSERT INTO pos_rewrite_public_screening_completions VALUES(?,?,?,?)',
      [value.operationId, value.orderId, JSON.stringify(value), seal],
    );
    await f.connection.execute(
      "INSERT INTO pos_rewrite_checkout_projections VALUES(?,1,2,77,?,?,'pos-checkout-projection-v1',NOW())",
      [value.orderId, value.projectionHash, lines.length],
    );
    for (const line of lines)
      await f.connection.execute(
        'INSERT INTO pos_rewrite_checkout_projection_lines VALUES(?,?,?,?,?)',
        [value.orderId, line.id, line.productId, line.quantity, line.inputHash],
      );
    const [rows] = await f.connection.query(
      'SELECT data FROM pos_rewrite_import_screening_reservations',
    );
    const held = screeningReservationSchema.parse((rows as { data: unknown }[])[0]!.data);
    const counted = screeningReservationSchema.parse({
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
    return { p, value };
  }
  it('GET proves pending without routing, POST dispatches once, lost reply GET returns exact signed acceptance', async () => {
    const { value } = await completed();
    const result = run(value.operationId, ['GET', 'POST', 'GET', 'POST']);
    expect(result.responses.map((row) => row.status)).toEqual([
      '200 OK',
      '200 OK',
      '200 OK',
      '200 OK',
    ]);
    const parsed = result.responses.map((row) => publication.parse(row.body));
    expect(parsed[0]?.data.status).toBe('pending');
    expect(parsed[1]?.data.status).toBe('accepted');
    expect(parsed[1]).toEqual(parsed[2]);
    expect(parsed[2]).toEqual(parsed[3]);
    expect(result.queueCalls).toBe(2);
    for (const row of parsed) {
      const { proofHash, data } = row;
      expect(proofHash).toBe(
        operationHash(
          'legacy-order-imports.source.public-screening-publication.v1',
          data,
          sourceKey,
        ),
      );
    }
    expect(result.events.every((row) => row.userId === '1')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-import@example.test');
  });
  it('an accepted broker write with unknown ACK remains uncertain and every later POST/GET is read-only', async () => {
    const { value } = await completed();
    const result = run(value.operationId, ['POST', 'GET', 'POST'], { mode: 'unknown' });
    expect(result.responses.map((row) => publication.parse(row.body).data.status)).toEqual([
      'uncertain',
      'uncertain',
      'uncertain',
    ]);
    expect(result.queueCalls).toBe(1);
  });
  it('retains exact source GET recovery with its key after new resource dispatch is disabled', async () => {
    const { value } = await completed();
    const original = run(value.operationId, ['POST']);
    const recovered = run(value.operationId, ['GET', 'POST'], { recoveryOnly: true });
    expect(recovered.responses[0]?.body).toEqual(original.responses[0]?.body);
    expect(recovered.responses[0]?.status).toBe('200 OK');
    expect(recovered.responses[1]?.body).toEqual({ code: 'SCREENING_PUBLICATION_UNAVAILABLE' });
    expect(recovered.queueCalls).toBe(0);
  });
  it('invalid private auth never opens publication native authority or calls a broker', async () => {
    const { value } = await completed();
    const result = run(value.operationId, ['GET', 'POST'], { badKey: true });
    expect(result.responses.map((row) => row.status)).toEqual([
      '401 Unauthorized',
      '401 Unauthorized',
    ]);
    expect(result.queueCalls).toBe(0);
    expect(result.events.every((row) => row.userId === null)).toBe(true);
  });
  it('mutable paid/header flags cannot publish an uncompleted source creation', async () => {
    const p = await f.prepare();
    expect(createSource(p.value)).toHaveProperty('result');
    await f.connection.query('UPDATE orders SET payment_status=4,order_status=3');
    const result = run(p.state.busyOperationId!, ['GET', 'POST']);
    expect(result.responses.every((row) => row.status === '409 Conflict')).toBe(true);
    expect(result.queueCalls).toBe(0);
  });
  it.each(['seal', 'reservation', 'projection', 'line', 'effects', 'deliveries'] as const)(
    'refuses modified %s before dispatch',
    async (field) => {
      const { value } = await completed();
      if (field === 'seal')
        await f.connection.query(
          "UPDATE pos_rewrite_public_screening_completions SET proof_hash=REPEAT('f',64)",
        );
      if (field === 'reservation')
        await f.connection.query(
          "UPDATE pos_rewrite_import_screening_reservations SET proof_hash=REPEAT('f',64)",
        );
      if (field === 'projection')
        await f.connection.query('UPDATE pos_rewrite_checkout_projections SET store_id=2');
      if (field === 'line')
        await f.connection.query('UPDATE pos_rewrite_checkout_projection_lines SET quantity=8');
      if (field === 'effects')
        await f.connection.query(
          "UPDATE pos_rewrite_public_screening_effects SET effects_hash=REPEAT('f',64)",
        );
      if (field === 'deliveries')
        await f.connection.query(
          "UPDATE pos_rewrite_public_screening_effects SET status='accepted',deliveries='[]'",
        );
      const result = run(value.operationId, ['GET', 'POST']);
      expect(result.responses.every((row) => row.status === '409 Conflict')).toBe(true);
      expect(result.queueCalls).toBe(0);
    },
  );
});
