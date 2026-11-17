import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { financialImportHash } from './financial-adapter-crypto.js';
import { correctionError } from './correction-domain.js';
import {
  importCorrectionCommandOutcomeSchema,
  type ImportCorrectionCommandOutcome,
} from './correction-contracts.js';
import { importCorrectionCommands } from './correction-command-schema.js';

type Command = typeof importCorrectionCommands.$inferSelect;
export function correctionCommandProof(row: Omit<Command, 'proofHash'>, secret: string) {
  return financialImportHash(secret, 'correction-command-outcome', row);
}
export function verifiedCorrectionCommand(row: Command, secret: string) {
  const outcome = importCorrectionCommandOutcomeSchema.parse(row.outcome),
    { proofHash, ...fields } = row,
    receipt = outcome.status === 'accepted' ? outcome.receipt : outcome;
  if (
    proofHash !== correctionCommandProof(fields, secret) ||
    receipt.id !== row.id ||
    receipt.originalJobId !== row.originalJobId ||
    receipt.originalOperationId !== row.originalOperationId ||
    receipt.managerId !== row.managerId ||
    (outcome.status === 'accepted'
      ? row.state !== 'ACCEPTED'
      : row.state !== 'FENCED' || outcome.recordedAt !== row.createdAt)
  )
    throw correctionError('ORDER_IMPORT_CORRECTION_COMMAND_EVIDENCE_INVALID');
  return outcome;
}
export function correctionCommands(secret: string) {
  return {
    async reserve(
      tx: AdministrationTransaction,
      input: Pick<
        Command,
        | 'id'
        | 'originalJobId'
        | 'originalOperationId'
        | 'managerId'
        | 'uploadHash'
        | 'planHash'
        | 'groupHash'
        | 'requestId'
        | 'createdAt'
      >,
    ) {
      z.uuid().parse(input.id);
      const reservationToken = randomUUID();
      await tx
        .insert(importCorrectionCommands)
        .values({ ...input, reservationToken, state: 'RESERVED' })
        .onDuplicateKeyUpdate({ set: { id: sql`${importCorrectionCommands.id}` } });
      const [row] = await tx
        .select()
        .from(importCorrectionCommands)
        .where(eq(importCorrectionCommands.id, input.id))
        .limit(1)
        .for('update');
      if (
        !row ||
        row.originalJobId !== input.originalJobId ||
        row.originalOperationId !== input.originalOperationId ||
        row.managerId !== input.managerId ||
        row.uploadHash !== input.uploadHash ||
        row.planHash !== input.planHash ||
        row.groupHash !== input.groupHash
      )
        throw correctionError('ORDER_IMPORT_CORRECTION_COMMAND_CHANGED');
      const fresh = row.reservationToken === reservationToken;
      if (row.state === 'RESERVED') {
        if (!fresh || row.outcome !== null || row.proofHash !== null)
          throw correctionError('ORDER_IMPORT_CORRECTION_COMMAND_UNCERTAIN');
        return { row, outcome: null };
      }
      return { row, outcome: verifiedCorrectionCommand(row, secret) };
    },
    async complete(
      tx: AdministrationTransaction,
      row: Command,
      value: ImportCorrectionCommandOutcome,
    ) {
      if (row.state !== 'RESERVED')
        throw correctionError('ORDER_IMPORT_CORRECTION_COMMAND_EVIDENCE_INVALID');
      const outcome = importCorrectionCommandOutcomeSchema.parse(value),
        { proofHash: _previous, ...original } = row,
        clean: Omit<Command, 'proofHash'> = {
          ...original,
          state: outcome.status === 'accepted' ? 'ACCEPTED' : 'FENCED',
          outcome,
        },
        proofHash = correctionCommandProof(clean, secret);
      verifiedCorrectionCommand({ ...clean, proofHash }, secret);
      await tx
        .update(importCorrectionCommands)
        .set({ state: clean.state, outcome, proofHash })
        .where(eq(importCorrectionCommands.id, row.id));
      return outcome;
    },
  };
}
