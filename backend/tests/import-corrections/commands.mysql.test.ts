import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { legacyOrderImportCorrections } from '../../src/modules/legacy-order-imports/correction-repository.js';
import { importCorrections } from '../../src/modules/legacy-order-imports/correction-schema.js';
import { importCorrectionCommands } from '../../src/modules/legacy-order-imports/correction-command-schema.js';
import { verifiedCorrectionCommand } from '../../src/modules/legacy-order-imports/correction-commands.js';
import { legacyOrderImports } from '../../src/modules/legacy-order-imports/schema.js';
import {
  correctionActor as actor,
  correctionClock,
  correctionCommand,
  correctionFixture,
  correctionSecret,
} from './fixture.js';

const template = process.env.LEGACY_ORDER_IMPORT_MYSQL_TEST_URL;
describe.skipIf(!template)(
  'durable correction-command absence fences under native row/UUID serialization',
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
    async function input() {
      return correctionCommand(
        (await native.corrections.review(actor, original.jobId, original.operationId, sessionId))
          .reviewHash!,
      );
    }
    const recover = (id: string) =>
      native.corrections.readCommand(
        actor,
        original.jobId,
        original.operationId,
        id,
        sessionId,
        'fixture-command-recovery',
      );
    const create = (value: ReturnType<typeof correctionCommand>) =>
      native.corrections.create(
        actor,
        original.jobId,
        original.operationId,
        value,
        sessionId,
        'fixture-command-create',
      );
    it('GET fences an absent UUID durably, and every delayed POST observes the fence without creating a successor', async () => {
      const value = await input(),
        first = await recover(value.id),
        again = await recover(value.id);
      expect(first).toEqual(again);
      expect(first).toMatchObject({
        status: 'not-created',
        contract: 'pos-import-correction-command-v1',
        id: value.id,
        originalJobId: original.jobId,
        originalOperationId: original.operationId,
        managerId: '1',
        noSuccessorQueued: true,
        latePostsFenced: true,
      });
      await expect(create(value)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_CORRECTION_COMMAND_FENCED',
      });
      await expect(
        create({ ...value, successorJobId: randomUUID(), successorOperationId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_CORRECTION_COMMAND_FENCED' });
      expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(0);
      expect(await native.db.get('writer').select().from(legacyOrderImports)).toHaveLength(1);
      const [row] = await native.db.get('writer').select().from(importCorrectionCommands);
      expect(verifiedCorrectionCommand(row!, correctionSecret)).toEqual(first);
    });
    it('a definite native correction refusal becomes recoverable through its original fenced command', async () => {
      const value = await input();
      await expect(create({ ...value, historicalTenderAmount: '50.98' })).rejects.toMatchObject({
        code: 'ORDER_IMPORT_CORRECTION_TENDER_MISMATCH',
      });
      expect(await recover(value.id)).toMatchObject({ status: 'not-created', id: value.id });
      const next = await input();
      expect(next.id).not.toBe(value.id);
      expect(await create(next)).toMatchObject({ id: next.id, historicalTenderAmount: '50.00' });
      expect(await recover(value.id)).toMatchObject({ status: 'not-created', id: value.id });
    });
    it('accepted evidence wins recovery; it cannot be zeroed or replaced by an absence fence', async () => {
      const value = await input(),
        receipt = await create(value);
      for (let count = 0; count < 5; count++)
        expect(await recover(value.id)).toEqual({ status: 'accepted', receipt });
      const [command] = await native.db.get('writer').select().from(importCorrectionCommands);
      expect(command!.state).toBe('ACCEPTED');
      expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(1);
    });
    it('GET waits for an in-flight native creator and observes accepted rather than falsely fencing it', async () => {
      const value = await input();
      let entered: () => void = () => {},
        release: () => void = () => {},
        readFinished = false;
      const inside = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        gated = legacyOrderImportCorrections(native.db, native.config, {
          secret: correctionSecret,
          contract: 'pos-import-manager-correction-v1',
          clock: () => correctionClock,
          boundary: {
            async inspectRejectedBoundary(tx, context) {
              entered();
              await gate;
              return native.boundary.inspectRejectedBoundary(tx, context);
            },
          },
        });
      const creating = gated.create(
        actor,
        original.jobId,
        original.operationId,
        value,
        sessionId,
        'fixture-held-create',
      );
      await inside;
      const reading = recover(value.id).then((outcome) => {
        readFinished = true;
        return outcome;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(readFinished).toBe(false);
      release();
      expect(await reading).toEqual({ status: 'accepted', receipt: await creating });
    });
    it('native create-versus-fence races permit exactly one financial successor decision', async () => {
      for (let count = 0; count < 6; count++) {
        if (count) {
          sessionId = (await native.reset()).sessionId;
          original = await native.original();
        }
        const value = await input(),
          [created, read] = await Promise.allSettled([create(value), recover(value.id)]);
        expect(read.status).toBe('fulfilled');
        if (read.status !== 'fulfilled')
          throw new Error('Recovery must produce one native outcome.');
        if (read.value.status === 'accepted') {
          expect(created.status).toBe('fulfilled');
          expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(1);
        } else {
          expect(created.status).toBe('rejected');
          expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(0);
        }
      }
    });
    it('malformed or committed unresolved command evidence stays uncertain and cannot be replaced', async () => {
      const value = await input();
      await recover(value.id);
      const [row] = await native.db.get('writer').select().from(importCorrectionCommands);
      if (!row || row.outcome?.status !== 'not-created')
        throw new Error('Expected a native absence fence.');
      await native.db
        .get('writer')
        .update(importCorrectionCommands)
        .set({ outcome: { ...row.outcome, recordedAt: row.createdAt + 1 } })
        .where(eq(importCorrectionCommands.id, row.id));
      await expect(recover(value.id)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_CORRECTION_COMMAND_EVIDENCE_INVALID',
      });
      await expect(create(value)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_CORRECTION_COMMAND_EVIDENCE_INVALID',
      });
      await native.db
        .get('writer')
        .update(importCorrectionCommands)
        .set({ state: 'RESERVED', outcome: null, proofHash: null })
        .where(eq(importCorrectionCommands.id, row.id));
      await expect(recover(value.id)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_CORRECTION_COMMAND_UNCERTAIN',
      });
      expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(0);
    });
    it('known fenced receipts remain recoverable with the retained key after creation is disabled', async () => {
      const value = await input(),
        outcome = await recover(value.id),
        disabled = legacyOrderImportCorrections(native.db, native.config, {
          secret: correctionSecret,
        });
      expect(
        await disabled.readCommand(
          actor,
          original.jobId,
          original.operationId,
          value.id,
          sessionId,
          'fixture-disabled-recovery',
        ),
      ).toEqual(outcome);
      expect(await native.db.get('writer').select().from(importCorrectionCommands)).toHaveLength(1);
    });
    it('a command UUID cannot be fenced or recovered under a different original row', async () => {
      const value = await input();
      await recover(value.id);
      const other = await native.original(false);
      await expect(
        native.corrections.readCommand(
          actor,
          other.jobId,
          other.operationId,
          value.id,
          sessionId,
          'fixture-wrong-scope',
        ),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_CORRECTION_COMMAND_CHANGED' });
      expect(await native.db.get('writer').select().from(importCorrectionCommands)).toHaveLength(1);
    });
  },
);
