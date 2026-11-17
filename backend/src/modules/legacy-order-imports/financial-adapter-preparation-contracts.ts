import { z } from 'zod';
import type { CsvMembershipPrefetch } from './membership-profile/bridge.js';
import type { CsvCouponPrefetch } from './benefit-profile/bridge.js';
import {
  financialImportScopeSchema,
  financialOrderPreparationContract,
  type ImportFinancialState,
} from './financial-adapter-contracts.js';
import type { LegacyOrderImportPlan } from './plans.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { ImportFinancialScope, ImportFinancialStart } from './financial-contracts.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  instant = z.number().int().safe().positive();
export const preparationMaximumAttempts = 64;
export const preparationLeaseMilliseconds = 60000;
export interface FinancialOrderPreparationPort {
  prepare(
    input: {
      readonly state: ImportFinancialState;
      readonly plan: LegacyOrderImportPlan;
      readonly attemptId: string;
      readonly expiresAt: number;
    },
    options: { readonly signal: AbortSignal },
  ): Promise<{ membershipHistory?: CsvMembershipPrefetch; couponHistory?: CsvCouponPrefetch }>;
}
export const financialQueueLeaseSchema = z
  .object({ jobId: z.uuid(), claimToken: z.uuid() })
  .strict();
export type FinancialQueueLease = z.infer<typeof financialQueueLeaseSchema>;
export const financialPreparationExecutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), queue: financialQueueLeaseSchema }).strict(),
  z
    .object({
      kind: z.literal('preparation'),
      queue: financialQueueLeaseSchema.optional(),
      attemptId: z.uuid(),
      ownerToken: z.uuid(),
    })
    .strict(),
]);
export type FinancialPreparationExecution = z.infer<typeof financialPreparationExecutionSchema>;

export const nativePreparationClosureSchema = z
  .object({
    contract: z.literal('pos-import-native-no-dispatch-v1'),
    scope: financialImportScopeSchema,
    planHash: hash,
    requestHash: hash,
    authorityHash: hash,
    namespace: z.string().regex(/^pos-import-v1:[a-f0-9-]{36}$/),
    attemptId: z.uuid(),
    sequence: z.number().int().min(1).max(preparationMaximumAttempts),
    code: z.enum([
      'ORDER_IMPORT_PREPARATION_FAILED',
      'ORDER_IMPORT_PREPARATION_EXPIRED',
      'ORDER_IMPORT_PREPARATION_CANCELLED',
    ]),
    noFinancialEffects: z.literal(true),
    closedAt: instant,
    nonce: z.uuid(),
  })
  .strict();
export type NativePreparationClosure = z.infer<typeof nativePreparationClosureSchema>;

export const financialPreparationAttemptSchema = z
  .object({
    contract: z.literal(financialOrderPreparationContract),
    id: z.uuid(),
    scope: financialImportScopeSchema,
    planHash: hash,
    requestHash: hash,
    authorityHash: hash,
    sequence: z.number().int().min(1).max(preparationMaximumAttempts),
    previousId: z.uuid().nullable(),
    authorizedBy: z.uuid().nullable(),
    phase: z.enum(['AUTHORIZED', 'RESERVED', 'RUNNING', 'DISPATCHED', 'CLOSED']),
    queue: financialQueueLeaseSchema.nullable(),
    ownerHash: hash.nullable(),
    expiresAt: instant.nullable(),
    artifactHash: hash.nullable(),
    closure: nativePreparationClosureSchema.nullable(),
    closureHash: hash.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict()
  .superRefine((value, context) => {
    const owned = ['RESERVED', 'RUNNING', 'DISPATCHED'].includes(value.phase);
    if (
      (value.phase === 'AUTHORIZED' &&
        (value.ownerHash !== null || value.expiresAt !== null || value.authorizedBy === null)) ||
      (owned && (value.ownerHash === null || value.expiresAt === null)) ||
      (value.phase === 'DISPATCHED') !== (value.artifactHash !== null) ||
      (value.phase === 'CLOSED') !== (value.closure !== null && value.closureHash !== null) ||
      (value.closure === null) !== (value.closureHash === null) ||
      (value.sequence === 1) !== (value.previousId === null) ||
      value.updatedAt < value.createdAt ||
      (value.closure &&
        (value.closure.attemptId !== value.id || value.closure.sequence !== value.sequence))
    )
      context.addIssue({
        code: 'custom',
        message: 'The native preparation attempt is inconsistent.',
      });
  });
export type FinancialPreparationAttempt = z.infer<typeof financialPreparationAttemptSchema>;

/** Only server wiring receives these callbacks; HTTP bodies cannot supply a lease or hook. */
export interface FinancialPreparationHooks {
  lock(
    tx: AdministrationTransaction,
    scope: Pick<ImportFinancialScope, 'actorId' | 'storeId' | 'counterId'>,
  ): Promise<void>;
  claim(
    tx: AdministrationTransaction,
    input: ImportFinancialStart,
    queue: FinancialQueueLease,
  ): Promise<FinancialPreparationExecution>;
  resume(
    tx: AdministrationTransaction,
    input: ImportFinancialStart,
    commandId: string,
  ): Promise<void>;
  cancel(tx: AdministrationTransaction, input: ImportFinancialScope): Promise<void>;
}
