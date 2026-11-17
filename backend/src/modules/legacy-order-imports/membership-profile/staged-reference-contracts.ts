import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { identifier } from '../../../domain/validation.js';
import { operationHash } from '../../checkout/crypto.js';
import {
  csvMemberStateSchema,
  csvMembershipProvenanceSchema,
  stagedMembershipContract,
  activatedMembershipContract,
  csvMembershipError,
} from './domain.js';
import { membershipContactTransferSchema } from './reference-contracts.js';

export const csvMembershipStagedReferenceContract = 'pos-csv-membership-staged-reference-v1';
export const csvMembershipReferenceActivationContract =
  'pos-csv-membership-reference-activation-v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.number().int().positive().safe();
export const csvMembershipStagedReferenceDataSchema = z
  .object({
    contract: z.literal(csvMembershipStagedReferenceContract),
    operationId: z.uuid(),
    requestHash: hash,
    planHash: hash,
    namespace: z.string().regex(/^pos-import-v1:[a-f0-9-]{36}$/),
    orderId: identifier,
    customerId: identifier,
    sourceReceiptHash: hash,
    original: csvMembershipProvenanceSchema.refine(
      (value) => value.contract === stagedMembershipContract,
    ),
    currentEntity: hash,
    currentRevision: z.string().regex(/^[1-9]\d{0,19}$/),
    currentRows: z.array(csvMemberStateSchema).length(2),
    transfers: z.array(membershipContactTransferSchema).min(1).max(16),
    grantId: z.uuid(),
    managerId: identifier,
    approvedAt: time,
  })
  .strict();
export const csvMembershipStagedReferenceSchema = z
  .object({
    data: csvMembershipStagedReferenceDataSchema,
    sourceHash: hash,
  })
  .strict();
export const csvMembershipReferenceActivationSchema = z
  .object({
    contract: z.literal(csvMembershipReferenceActivationContract),
    operationId: z.uuid(),
    requestHash: hash,
    planHash: hash,
    orderId: identifier,
    customerId: identifier,
    nonce: z.uuid(),
    sourceReceiptHash: hash,
    referenceHash: hash,
    originalStageHash: hash,
    confirmationHash: hash,
    sourceMutation: z
      .object({
        kind: z.enum(['activate', 'upgrade']),
        productId: identifier,
        delta: z.union([z.literal(0), z.literal(270), z.literal(330), z.literal(365)]),
        memberValue: z.string().regex(/^[1-6]$/),
        expiryBefore: z.string().min(1).max(80),
        expiryAfter: z.string().min(1).max(80),
      })
      .strict(),
    activation: csvMembershipProvenanceSchema.refine(
      (value) => value.contract === activatedMembershipContract,
    ),
    confirmedAt: time,
  })
  .strict();
export type CsvMembershipStagedReference = z.infer<typeof csvMembershipStagedReferenceSchema>;
export type CsvMembershipReferenceActivation = z.infer<
  typeof csvMembershipReferenceActivationSchema
>;
export const stagedReferenceHash = (value: CsvMembershipStagedReference['data'], key: string) =>
  operationHash('legacy-order-imports.source.membership-staged-reference.v1', value, key);
export const referenceActivationHash = (value: CsvMembershipReferenceActivation, key: string) =>
  operationHash('legacy-order-imports.source.membership-reference-activation.v1', value, key);

/** The pinned Go new/free branch activates only. Its upgrade branch performs
 * the original second delta after API-v2 staging; no corrected expiry is chosen. */
export function assertReferenceActivationMutation(
  reference: CsvMembershipStagedReference,
  activation: CsvMembershipReferenceActivation,
  source: { kind: 'new' | 'upgrade' | 'auto-free'; productId: string },
) {
  try {
    const mutation = activation.sourceMutation,
      before = reference.data.currentRows,
      after = activation.activation.confirmed,
      expiry = before.find((row) => row.attribute === 'EXCLUSIVE_EXPIRY'),
      member = before.find((row) => row.attribute === 'EXCLUSIVE_MEMBER');
    if (
      !expiry?.value ||
      !member?.value ||
      mutation.productId !== source.productId ||
      mutation.kind !== (source.kind === 'upgrade' ? 'upgrade' : 'activate') ||
      mutation.expiryBefore !== expiry.value ||
      after.length !== before.length
    )
      throw csvMembershipError();
    const expectedExpiry =
      mutation.kind === 'activate'
        ? expiry.value
        : Temporal.PlainDateTime.from(expiry.value.replace(' ', 'T'))
            .add({ days: mutation.delta })
            .toString({ fractionalSecondDigits: 6 });
    const expectedMember =
      mutation.kind === 'activate'
        ? member.value
        : mutation.delta === 330
          ? '4'
          : mutation.delta === 270
            ? '5'
            : mutation.delta === 365
              ? '6'
              : '1';
    if (
      (mutation.kind === 'activate' && mutation.delta !== 0) ||
      mutation.expiryAfter !== expectedExpiry ||
      mutation.memberValue !== expectedMember
    )
      throw csvMembershipError();
    for (const row of after) {
      const original = before.find((value) => value.attribute === row.attribute);
      if (
        !original ||
        row.createdAt !== original.createdAt ||
        row.active !== (mutation.kind === 'activate' ? 1 : original.active) ||
        row.active !== 1 ||
        row.value !== (row.attribute === 'EXCLUSIVE_EXPIRY' ? expectedExpiry : expectedMember)
      )
        throw csvMembershipError();
    }
  } catch {
    throw csvMembershipError();
  }
}
