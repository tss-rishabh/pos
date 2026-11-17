import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { importFinancialFixture, financialClock, sourceKey } from './fixture.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import { financialImportCorrectionBoundary } from '../../src/modules/legacy-order-imports/financial-adapter-correction-boundary.js';
import { financialSourceHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import { sourceRejectionReceiptSchema } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  financialImportOperations,
  financialImportOrderBindings,
  financialImportSourceEffects,
  financialImportSourceReceipts,
  financialImportStages,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('native signed no-effect boundary for manager CSV correction', () => {
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

  async function rejected(payable: string | null = '49.00') {
    const input = f.input(),
      journal = legacyImportFinancialJournal(f.config, f.db, f.options);
    const reserved = await journal.reserve(input);
    const command = await journal.dispatch(reserved.state.scope, 'order');
    const calculation =
      payable === null
        ? null
        : {
            payable,
            profileQualified: true,
            profileCode: null,
            calculationHash: financialSourceHash(sourceKey, 'calculation', {
              operationId: input.operationId,
              requestHash: command.state.requestHash,
              namespace: command.state.namespace,
              planHash: input.planHash,
              stageNonce: command.nonce,
              rejectedAt: financialClock,
              payable,
              profileQualified: true,
              profileCode: null,
            }),
          };
    const proof = sourceRejectionReceiptSchema.parse({
      contract: 'pos-legacy-order-import-source-v1',
      operationId: input.operationId,
      requestHash: command.state.requestHash,
      namespace: command.state.namespace,
      status: 'rejected',
      code: 'ORDER_IMPORT_ORIGINAL_TENDER_MISMATCH',
      noFinancialEffects: true,
      ...(calculation
        ? {
            review: {
              contract: 'pos-import-rejection-calculation-v1',
              planHash: input.planHash,
              stageNonce: command.nonce,
              rejectedAt: financialClock,
              calculation,
            },
          }
        : {}),
    });
    const sourceId = `${input.operationId}:order`;
    await journal.transaction(async (tx) => {
      await tx.insert(financialImportSourceReceipts).values({
        id: sourceId,
        operationId: input.operationId,
        kind: 'order',
        status: 'rejected',
        requestHash: command.state.requestHash,
        proof,
        proofHash: financialSourceHash(sourceKey, 'rejection', proof),
        createdAt: financialClock,
      });
      await journal.save(tx, { ...command.state, status: 'rejected', errorCode: proof.code });
    });
    const boundary = financialImportCorrectionBoundary({
      secret: f.options.secret,
      sourceProofKey: sourceKey,
    });
    return {
      input,
      journal,
      command,
      proof,
      sourceId,
      inspect: () =>
        journal.transaction((tx) =>
          boundary.inspectRejectedBoundary(tx, {
            scope: command.state.scope,
            plan: input.plan,
            planHash: input.planHash,
          }),
        ),
    };
  }
  it('returns only exact signed calculation facts and the original singleton stage nonce', async () => {
    const r = await rejected();
    expect(await r.inspect()).toMatchObject({
      noFinancialEffects: true,
      scope: r.command.state.scope,
      stageNonce: r.command.nonce,
      financialRequestHash: r.command.state.requestHash,
      customerId: '77',
      calculation: { payable: '49.00', profileQualified: true },
    });
  });
  it('retains a valid old rejection without inventing calculation evidence', async () => {
    const r = await rejected(null);
    expect((await r.inspect()).calculation).toBeNull();
  });
  it('accepts a source-proved zero bill without asserting any cash collection', async () => {
    const r = await rejected('0.00');
    expect((await r.inspect()).calculation?.payable).toBe('0.00');
  });
  it.each(['unknown', 'running'] as const)(
    'refuses %s outcomes despite a matching negative body',
    async (status) => {
      const r = await rejected();
      await r.journal.transaction((tx) =>
        r.journal.save(tx, { ...r.command.state, status, errorCode: r.proof.code }),
      );
      await expect(r.inspect()).rejects.toMatchObject({
        code: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
      });
    },
  );
  it('refuses changed input prices even though the original operation still has no order', async () => {
    const r = await rejected(),
      boundary = financialImportCorrectionBoundary({
        secret: f.options.secret,
        sourceProofKey: sourceKey,
      });
    await expect(
      r.journal.transaction((tx) =>
        boundary.inspectRejectedBoundary(tx, {
          scope: r.command.state.scope,
          planHash: r.input.planHash,
          plan: { ...r.input.plan, originalTenderAmount: '51.00' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED' });
  });
  it('refuses a changed source proof and does not treat a parseable negative as authority', async () => {
    const r = await rejected();
    await f.db
      .get('writer')
      .update(financialImportSourceReceipts)
      .set({
        proof: { ...r.proof, code: 'ORDER_IMPORT_OTHER_REJECTION' },
      })
      .where(eq(financialImportSourceReceipts.id, r.sourceId));
    await expect(r.inspect()).rejects.toMatchObject({
      code: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
    });
  });
  it('separately verifies calculation provenance even if the outer rejection is correctly signed', async () => {
    const r = await rejected();
    const changed = {
      ...r.proof,
      review: {
        ...r.proof.review!,
        calculation: {
          ...r.proof.review!.calculation,
          payable: '1.00',
        },
      },
    };
    await f.db
      .get('writer')
      .update(financialImportSourceReceipts)
      .set({ proof: changed, proofHash: financialSourceHash(sourceKey, 'rejection', changed) })
      .where(eq(financialImportSourceReceipts.id, r.sourceId));
    await expect(r.inspect()).rejects.toMatchObject({
      code: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
    });
  });
  it('refuses a later dispatch and never reclassifies it as a source no-effect outcome', async () => {
    const r = await rejected();
    await f.db
      .get('writer')
      .insert(financialImportStages)
      .values({
        id: `${r.input.operationId}:confirmation`,
        operationId: r.input.operationId,
        kind: 'confirmation',
        nonce: randomUUID(),
        status: 'dispatched',
        requestHash: 'a'.repeat(64),
        createdAt: financialClock,
        updatedAt: financialClock,
      });
    await expect(r.inspect()).rejects.toMatchObject({
      code: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
    });
  });
  it.each([{}, false, 0, 'null'])(
    'refuses non-null retained order-stage proof (%j)',
    async (proof) => {
      const r = await rejected();
      await f.db
        .get('writer')
        .update(financialImportStages)
        .set({ proof })
        .where(eq(financialImportStages.id, `${r.input.operationId}:order`));
      await expect(r.inspect()).rejects.toMatchObject({
        code: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
      });
    },
  );
  it('does not hide an oversized additional source receipt from the no-effect check', async () => {
    const r = await rejected();
    await f.db
      .get('writer')
      .insert(financialImportSourceReceipts)
      .values({
        id: `${r.input.operationId}:publication`,
        operationId: r.input.operationId,
        kind: 'publication',
        status: 'completed',
        requestHash: r.command.state.requestHash,
        proof: { data: 'x'.repeat(20000) },
        proofHash: 'a'.repeat(64),
        createdAt: financialClock,
      });
    await expect(r.inspect()).rejects.toMatchObject({
      code: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
    });
  });
  it('refuses every retained order binding, even when no legacy order happens to be visible', async () => {
    const r = await rejected();
    await f.db
      .get('writer')
      .insert(financialImportOrderBindings)
      .values({
        orderId: '5010',
        operationId: r.input.operationId,
        requestHash: r.command.state.requestHash,
        proofHash: 'a'.repeat(64),
        status: 'held',
      });
    await expect(r.inspect()).rejects.toMatchObject({
      code: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
    });
  });
  it('refuses retained source-effect work before considering a successor', async () => {
    const r = await rejected();
    await f.db
      .get('writer')
      .insert(financialImportSourceEffects)
      .values({
        operationId: r.input.operationId,
        payload: 'fixture-ciphertext',
        effectsHash: 'a'.repeat(64),
        status: 'processing',
        deliveries: [],
        createdAt: financialClock,
        updatedAt: financialClock,
      });
    await expect(r.inspect()).rejects.toMatchObject({
      code: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
    });
  });
  it('checks current operator authority instead of trusting the stored actor identity', async () => {
    const r = await rejected();
    await f.connection.query('UPDATE pos_user SET is_active=0 WHERE id=?', [r.input.actorId]);
    await expect(r.inspect()).rejects.toMatchObject({ code: 'ORDER_IMPORT_ADMINISTRATION_DENIED' });
    expect(
      await f.db
        .get('writer')
        .select({ id: financialImportOperations.id })
        .from(financialImportOperations),
    ).toHaveLength(1);
  });
});
