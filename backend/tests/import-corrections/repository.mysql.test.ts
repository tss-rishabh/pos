import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  legacyOrderImports,
  legacyOrderImportRows,
} from '../../src/modules/legacy-order-imports/schema.js';
import { importCorrections } from '../../src/modules/legacy-order-imports/correction-schema.js';
import { legacyOrderImportCorrections } from '../../src/modules/legacy-order-imports/correction-repository.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { openImportGroup } from '../../src/modules/legacy-order-imports/sealed-groups.js';
import { PosUser, StoreCounter } from '../../src/db/legacy-schema.js';
import type { ImportFinancialStart } from '../../src/modules/legacy-order-imports/financial-contracts.js';
import type { ImportCorrectionBinding } from '../../src/modules/legacy-order-imports/correction-contracts.js';
import {
  correctionActor as actor,
  correctionClock,
  correctionCommand,
  correctionFixture,
  correctionSecret,
} from './fixture.js';

const template = process.env.LEGACY_ORDER_IMPORT_MYSQL_TEST_URL;
describe.skipIf(!template)(
  'native manager correction coordination with a typed synthetic no-effect boundary',
  () => {
    let native: Awaited<ReturnType<typeof correctionFixture>>,
      sessionId: string,
      original: { jobId: string; operationId: string };
    beforeAll(async () => {
      native = await correctionFixture(template!);
    });
    afterAll(async () => native?.close());
    beforeEach(async () => {
      sessionId = (await native.reset()).sessionId;
      original = await native.original();
    });
    async function review() {
      return native.corrections.review(actor, original.jobId, original.operationId, sessionId);
    }
    async function create(input: ReturnType<typeof correctionCommand>) {
      return native.corrections.create(
        actor,
        original.jobId,
        original.operationId,
        input,
        sessionId,
        'fixture-correction-request',
      );
    }
    it('reviews bounded ordered original rows and creates one approved-later successor without changing sibling/original money', async () => {
      const before = await native.db
          .get('writer')
          .select()
          .from(legacyOrderImportRows)
          .where(eq(legacyOrderImportRows.jobId, original.jobId)),
        originalJob = await native.db
          .get('writer')
          .select()
          .from(legacyOrderImports)
          .where(eq(legacyOrderImports.id, original.jobId)),
        value = await review();
      expect(value).toMatchObject({
        enabled: true,
        eligible: true,
        original: {
          firstRow: 2,
          state: 'FAILED',
          lineValue: '50.98',
          lines: [{ productId: '9007199254740993', quantity: 2, unitPrice: '25.49' }],
        },
        calculation: { payable: '50.00' },
      });
      expect(JSON.stringify(value)).not.toMatch(
        /private-import@|Private fixture|private fixture message/i,
      );
      const input = correctionCommand(value.reviewHash!),
        receipt = await create(input);
      expect(receipt).toMatchObject({
        originalLineValue: '50.98',
        correctedLineValue: '50.98',
        historicalTenderAmount: '50.00',
        requiresApproval: true,
        financialExecution: 'pending-approval',
      });
      expect(
        await native.db
          .get('writer')
          .select()
          .from(legacyOrderImportRows)
          .where(eq(legacyOrderImportRows.jobId, original.jobId)),
      ).toEqual(before);
      expect(
        await native.db
          .get('writer')
          .select()
          .from(legacyOrderImports)
          .where(eq(legacyOrderImports.id, original.jobId)),
      ).toEqual(originalJob);
      const [row] = await native.db
        .get('writer')
        .select()
        .from(legacyOrderImportRows)
        .where(eq(legacyOrderImportRows.operationId, input.successorOperationId));
      expect(row).toMatchObject({
        state: 'PENDING',
        orderId: null,
        errorCode: 'ORDER_IMPORT_APPROVAL_REQUIRED',
      });
      const opened = openImportGroup(
        correctionSecret,
        {
          jobId: input.successorJobId,
          operationId: input.successorOperationId,
          actorId: actor.id,
          storeId: '1',
          counterId: '2',
          sequence: 1,
          kind: 'offline',
        },
        row!.payload,
      );
      expect(opened.plan).toMatchObject({
        originalTenderAmount: '50.98',
        email: 'private-import@example.test',
        createdAt: '2026-06-15 12:00:00',
        payment: 'cash',
      });
      expect(opened.group.details.manager_correction_id).toBe(input.id);
      expect((await review()).successor).toEqual(receipt);
      expect(
        await native.corrections.read(
          actor,
          original.jobId,
          original.operationId,
          input.id,
          sessionId,
        ),
      ).toEqual(receipt);
    });
    it('twenty same-UUID commits/replays produce one immutable successor and reject changed command values', async () => {
      const input = correctionCommand((await review()).reviewHash!),
        replies = await Promise.all(Array.from({ length: 20 }, () => create(input)));
      expect(replies.every((reply) => JSON.stringify(reply) === JSON.stringify(replies[0]))).toBe(
        true,
      );
      expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(1);
      expect(await native.db.get('writer').select().from(legacyOrderImports)).toHaveLength(2);
      await expect(create({ ...input, historicalTenderAmount: '49.00' })).rejects.toMatchObject({
        code: 'ORDER_IMPORT_CORRECTION_COMMAND_CHANGED',
      });
      native.setProofAvailable(false);
      expect(
        await native.corrections.read(
          actor,
          original.jobId,
          original.operationId,
          input.id,
          sessionId,
        ),
      ).toEqual(replies[0]);
    });
    it('racing different correction IDs cannot create duplicate successors for the same original row', async () => {
      const hash = (await review()).reviewHash!,
        outcomes = await Promise.allSettled(
          Array.from({ length: 8 }, () => create(correctionCommand(hash))),
        );
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(7);
      expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(1);
    });
    it.each(['STARTING', 'RECONCILING', 'IMPORTED', 'CANCELLED', 'PENDING'] as const)(
      'keeps %s outcomes read-only even if a caller claims correction',
      async (state) => {
        await native.db
          .get('writer')
          .update(legacyOrderImportRows)
          .set({ state })
          .where(eq(legacyOrderImportRows.operationId, original.operationId));
        expect(await review()).toMatchObject({
          eligible: false,
          blocker: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
        });
        await expect(create(correctionCommand('a'.repeat(64)))).rejects.toMatchObject({
          code: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
        });
        expect(native.inspections()).toBe(0);
        expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(0);
      },
    );
    it('refuses a missing signed boundary, an existing order and unqualified or missing source calculations', async () => {
      native.setProofAvailable(false);
      expect(await review()).toMatchObject({
        eligible: false,
        blocker: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
      });
      native.setProofAvailable(true);
      native.setNoCalculation(true);
      expect(await review()).toMatchObject({
        eligible: false,
        blocker: 'ORDER_IMPORT_CORRECTION_CALCULATION_REQUIRED',
      });
      native.setNoCalculation(false);
      native.setQualified(false);
      expect(await review()).toMatchObject({
        eligible: false,
        blocker: 'ORDER_IMPORT_CORRECTION_PROFILE_UNQUALIFIED',
      });
      native.setQualified(true);
      await native.db
        .get('writer')
        .update(legacyOrderImportRows)
        .set({ orderId: '9007199254742001' })
        .where(eq(legacyOrderImportRows.operationId, original.operationId));
      expect(await review()).toMatchObject({
        eligible: false,
        blocker: 'ORDER_IMPORT_CORRECTION_NO_EFFECT_REQUIRED',
      });
    });
    it('supports explicitly attested zero only with a qualified source-zero bill, without inventing a cash movement', async () => {
      native.setPayable('0.00');
      const input = correctionCommand((await review()).reviewHash!, '0.00');
      expect(await create(input)).toMatchObject({
        historicalTenderAmount: '0.00',
        originalLineValue: '50.98',
        financialExecution: 'pending-approval',
      });
      expect(
        await native.db
          .get('writer')
          .select()
          .from(legacyOrderImportRows)
          .where(eq(legacyOrderImportRows.operationId, input.successorOperationId)),
      ).toMatchObject([{ orderId: null, state: 'PENDING' }]);
    });
    it('does not alter both price and derived tender to pretend that a permanent percentage discount is fixed', async () => {
      const input = correctionCommand((await review()).reviewHash!);
      await expect(
        create({
          ...input,
          lines: [{ row: 2, unitPrice: '25.00' }],
          historicalTenderAmount: '50.00',
        }),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_CORRECTION_PRICE_REVIEW_REQUIRED' });
      await expect(create({ ...input, historicalTenderAmount: '50.98' })).rejects.toMatchObject({
        code: 'ORDER_IMPORT_CORRECTION_TENDER_MISMATCH',
      });
      expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(0);
    });
    it('detects changed review facts/session authority and refuses archived, reassigned-counter or other-owner access', async () => {
      const input = correctionCommand((await review()).reviewHash!);
      native.setPayable('49.00');
      await expect(create(input)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_CORRECTION_REVIEW_CHANGED',
      });
      native.setPayable('50.00');
      await expect(
        native.corrections.review(
          { ...actor, id: '2' },
          original.jobId,
          original.operationId,
          sessionId,
        ),
      ).rejects.toMatchObject({ status: 404 });
      await native.db
        .get('writer')
        .update(StoreCounter)
        .set({ is_active: false })
        .where(eq(StoreCounter.id, 2n));
      await expect(create(input)).rejects.toBeDefined();
      await native.db
        .get('writer')
        .update(StoreCounter)
        .set({ is_active: true })
        .where(eq(StoreCounter.id, 2n));
      await native.db
        .get('writer')
        .update(PosUser)
        .set({ is_active: false })
        .where(eq(PosUser.id, 1n));
      await expect(create(input)).rejects.toBeDefined();
      expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(0);
    });
    it('rolls back the correction record atomically if the successor queue cannot be inserted', async () => {
      const input = correctionCommand((await review()).reviewHash!);
      await native.db
        .get('writer')
        .insert(legacyOrderImports)
        .values({
          id: input.successorJobId,
          actorId: '1',
          requestHash: 'a'.repeat(64),
          kind: 'offline',
          state: 'QUEUED',
          totalOrders: 1,
          importedOrders: 0,
          failedOrders: 0,
          cancelledOrders: 0,
          createdAt: '2026-11-17 12:00:00.000',
          updatedAt: '2026-11-17 12:00:00.000',
        });
      await expect(create(input)).rejects.toBeDefined();
      expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(0);
      expect(
        await native.db
          .get('writer')
          .select()
          .from(legacyOrderImportRows)
          .where(eq(legacyOrderImportRows.operationId, input.successorOperationId)),
      ).toHaveLength(0);
    });
    it('a missing coordinator resolver cannot silently treat the sealed successor as an ordinary CSV row', async () => {
      const input = correctionCommand((await review()).reviewHash!);
      await create(input);
      const unconfigured = legacyOrderImportRepository(native.db, {
          secret: correctionSecret,
          now: () => correctionClock,
        }),
        start = vi.fn();
      expect(await unconfigured.runOne({ start, read: async () => null })).toBeNull();
      expect(start).not.toHaveBeenCalled();
      expect(
        await native.db
          .get('writer')
          .select()
          .from(legacyOrderImports)
          .where(eq(legacyOrderImports.id, input.successorJobId)),
      ).toMatchObject([{ state: 'BLOCKED', errorCode: 'ORDER_IMPORT_PAYLOAD_INVALID' }]);
    });
    it('passes the immutable binding and distinct declared tender to the financial port only after approval', async () => {
      const input = correctionCommand((await review()).reviewHash!);
      await create(input);
      let approved = false;
      const starts: (ImportFinancialStart & { correction?: ImportCorrectionBinding })[] = [],
        gateway = {
          async authorizeStart() {
            return approved
              ? { ready: true as const }
              : { ready: false as const, code: 'ORDER_IMPORT_APPROVAL_REQUIRED' as const };
          },
          async start(value: ImportFinancialStart) {
            starts.push(value);
            return {
              status: 'unknown' as const,
              operationId: value.operationId,
              stage: 'order' as const,
              orderId: null,
            };
          },
          async read() {
            return null;
          },
        };
      expect(await native.queue.runOne(gateway)).toBeNull();
      expect(starts).toHaveLength(0);
      approved = true;
      await native.db
        .get('writer')
        .update(legacyOrderImports)
        .set({ leaseUntil: null })
        .where(eq(legacyOrderImports.id, input.successorJobId));
      await native.queue.runOne(gateway);
      expect(starts).toHaveLength(1);
      expect(starts[0]!.plan.originalTenderAmount).toBe('50.98');
      expect(starts[0]!.correction).toMatchObject({
        id: input.id,
        historicalTenderAmount: '50.00',
        original: {
          operationId: original.operationId,
          boundary: { customerId: '9007199254740994', noFinancialEffects: true },
        },
      });
      expect(starts[0]!.operationId).toBe(input.successorOperationId);
    });
    it('disabled correction still allows GET recovery of its previously stored immutable receipt', async () => {
      const input = correctionCommand((await review()).reviewHash!),
        receipt = await create(input),
        disabled = legacyOrderImportCorrections(native.db, native.config, {
          secret: correctionSecret,
          clock: () => correctionClock,
        });
      expect(
        await disabled.read(actor, original.jobId, original.operationId, input.id, sessionId),
      ).toEqual(receipt);
      await expect(
        disabled.create(
          actor,
          original.jobId,
          original.operationId,
          { ...input, id: randomUUID() },
          sessionId,
          'fixture',
        ),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_CORRECTION_DISABLED' });
    });
  },
);
