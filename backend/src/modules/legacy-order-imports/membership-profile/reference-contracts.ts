import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { operationHash } from '../../checkout/crypto.js';
import { csvMembershipProvenanceSchema, activatedMembershipContract } from './domain.js';

export const csvMembershipReferenceContract = 'pos-csv-membership-contact-reference-v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.number().int().positive().safe();
export const membershipContactTransferSchema = z
  .object({
    challengeId: z.uuid(),
    operationId: z.uuid(),
    deliveryId: z.uuid(),
    inputHash: hash,
    effectHash: hash,
    mutationHash: hash,
    previousEntity: hash,
    nextEntity: hash,
    committedAt: time,
  })
  .strict();
/** No contact, cache key, destination, OTP or decrypted envelope is retained. */
export const csvMembershipReferenceDataSchema = z
  .object({
    contract: z.literal(csvMembershipReferenceContract),
    operationId: z.uuid(),
    requestHash: hash,
    planHash: hash,
    namespace: z.string().regex(/^pos-import-v1:[a-f0-9-]{36}$/),
    orderId: identifier,
    customerId: identifier,
    sourceReceiptHash: hash,
    confirmationHash: hash,
    activation: csvMembershipProvenanceSchema.refine(
      (value) => value.contract === activatedMembershipContract,
    ),
    currentEntity: hash,
    currentRevision: z.string().regex(/^[1-9]\d{0,19}$/),
    currentRowsHash: hash,
    transfers: z.array(membershipContactTransferSchema).min(1).max(16),
    grantId: z.uuid(),
    managerId: identifier,
    approvedAt: time,
  })
  .strict();
export const csvMembershipReferenceSchema = z
  .object({
    data: csvMembershipReferenceDataSchema,
    sourceHash: hash,
  })
  .strict();
export type CsvMembershipReference = z.infer<typeof csvMembershipReferenceSchema>;
export type MembershipContactTransfer = z.infer<typeof membershipContactTransferSchema>;
export function membershipReferenceHash(data: CsvMembershipReference['data'], key: string) {
  return operationHash('legacy-order-imports.source.membership-reference.v1', data, key);
}
