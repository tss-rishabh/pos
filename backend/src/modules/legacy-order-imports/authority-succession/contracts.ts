import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';
import { customerContactBindingSchema } from '../../checkout/customer-contact-authority.js';
export const importAuthoritySuccessionContract = 'pos-import-authority-succession-v1';
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.number().int().positive().safe();
export const successionScopeSchema = z
  .object({
    actorId: identifier,
    operationId: uuid,
    storeId: identifier,
    counterId: identifier,
  })
  .strict();
const close = z
  .object({
    id: identifier,
    version: z.number().int().min(1).max(65535),
    status: z.enum(['CLOSED', 'STALE']),
  })
  .strict()
  .nullable();
export const successionAuthoritySchema = z
  .object({
    customerId: identifier,
    contact: customerContactBindingSchema,
    actorVersion: hash,
    actorEpoch: z.string().regex(/^(?:0|[1-9]\d{0,19})$/),
    approvalId: uuid.nullable(),
    close,
  })
  .strict();
export const successionReferenceSchema = z
  .object({ id: uuid, sequence: z.number().int().min(1).max(100), hash })
  .strict();
export type ImportSuccessionReference = z.infer<typeof successionReferenceSchema>;
export const successionStageSchema = z.enum(['confirmation', 'settlement', 'publication']);
export type ImportSuccessionStage = z.infer<typeof successionStageSchema>;
export const successionGrantSchema = z
  .object({
    contract: z.literal(importAuthoritySuccessionContract),
    id: uuid,
    sequence: z.number().int().min(1).max(100),
    previous: successionReferenceSchema.nullable(),
    originalScope: successionScopeSchema,
    requestHash: hash,
    planHash: hash,
    namespace: z.string().regex(/^pos-import-v1:[a-f0-9-]{36}$/),
    originalAuthorityHash: hash,
    orderId: identifier,
    sourceReceiptHash: hash,
    headerHash: hash,
    lineHash: hash,
    evidenceHash: hash,
    managerId: identifier,
    requestId: z.string().min(1).max(128),
    sessionHash: hash,
    sessionDigest: hash,
    authority: successionAuthoritySchema,
    businessDate: z.iso.date(),
    reason: z.enum(['actor-changed', 'contact-changed', 'authority-recovery']),
    reviewedAt: time,
    issuedAt: time,
    expiresAt: time,
  })
  .strict();
export type ImportSuccessionGrant = z.infer<typeof successionGrantSchema>;
export const successionEnvelopeSchema = z
  .object({ data: successionGrantSchema, sourceHash: hash })
  .strict();
export type ImportSuccessionEnvelope = z.infer<typeof successionEnvelopeSchema>;
export const successionClaimSchema = z
  .object({
    contract: z.literal(importAuthoritySuccessionContract),
    operationId: uuid,
    stage: successionStageSchema,
    nonce: z.uuid(),
    stageRequestHash: hash,
    grant: successionReferenceSchema,
    commandId: uuid,
    claimedAt: time,
  })
  .strict();
export type ImportSuccessionClaim = z.infer<typeof successionClaimSchema>;
export const successionSnapshotSchema = z
  .object({
    contract: z.literal(importAuthoritySuccessionContract),
    head: successionReferenceSchema,
    grants: z.array(successionEnvelopeSchema).min(1).max(100),
    claims: z.array(successionClaimSchema).max(300),
    applied: z
      .object({
        confirmation: successionReferenceSchema.nullable(),
        settlement: successionReferenceSchema.nullable(),
        publication: successionReferenceSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type ImportSuccessionSnapshot = z.infer<typeof successionSnapshotSchema>;
export const successionApproveInputSchema = z
  .object({
    commandId: uuid,
    reviewHash: hash,
    reason: z.enum(['actor-changed', 'contact-changed', 'authority-recovery']),
  })
  .strict();
export const successionContinueInputSchema = z.object({ commandId: uuid, grantId: uuid }).strict();
export const successionReceiptSchema = z
  .object({
    id: uuid,
    sequence: z.number().int().positive(),
    jobId: uuid,
    operationId: uuid,
    orderId: identifier,
    managerId: identifier,
    issuedAt: time,
    expiresAt: time,
    reviewHash: hash,
  })
  .strict();
export const successionReviewSchema = z
  .object({
    contract: z.literal(importAuthoritySuccessionContract),
    jobId: uuid,
    operationId: uuid,
    orderId: identifier,
    storeId: identifier,
    counterId: identifier,
    originalActorId: identifier,
    currentManagerId: identifier,
    businessDate: z.iso.date(),
    payable: z.string().regex(/^\d{1,10}\.\d{2}$/),
    kind: z.enum(['offline', 'shopify']),
    status: z.enum(['ready', 'blocked', 'completed']),
    code: z
      .string()
      .regex(/^ORDER_IMPORT_[A-Z0-9_]{1,45}$/)
      .nullable(),
    next: successionStageSchema.nullable(),
    head: successionReferenceSchema.nullable(),
    reviewHash: hash,
    grant: successionReceiptSchema.nullable(),
  })
  .strict();
export type ImportSuccessionReview = z.infer<typeof successionReviewSchema>;
export const successionContinuationSchema = z
  .object({
    commandId: uuid,
    grantId: uuid,
    jobId: uuid,
    operationId: uuid,
    status: z.enum(['started', 'unknown', 'completed']),
    stage: successionStageSchema.nullable(),
    orderId: identifier,
    result: z
      .object({
        operationId: uuid,
        orderId: identifier,
        receiptId: uuid,
        businessDate: z.iso.date(),
        projectionHash: hash,
      })
      .strict()
      .nullable(),
    createdAt: time,
    updatedAt: time,
  })
  .strict();
export type ImportSuccessionContinuation = z.infer<typeof successionContinuationSchema>;
export interface ImportAuthoritySuccessionPort {
  review(
    user: import('../../../domain/access.js').Principal,
    jobId: string,
    operationId: string,
    sessionId: string,
  ): Promise<ImportSuccessionReview>;
  approve(
    user: import('../../../domain/access.js').Principal,
    jobId: string,
    operationId: string,
    input: z.infer<typeof successionApproveInputSchema>,
    sessionId: string,
    requestId: string,
  ): Promise<z.infer<typeof successionReceiptSchema>>;
  readApproval(
    user: import('../../../domain/access.js').Principal,
    jobId: string,
    operationId: string,
    commandId: string,
    sessionId: string,
  ): Promise<z.infer<typeof successionReceiptSchema> | null>;
  continue(
    user: import('../../../domain/access.js').Principal,
    jobId: string,
    operationId: string,
    input: z.infer<typeof successionContinueInputSchema>,
    sessionId: string,
    requestId: string,
  ): Promise<ImportSuccessionContinuation>;
  readContinuation(
    user: import('../../../domain/access.js').Principal,
    jobId: string,
    operationId: string,
    commandId: string,
    sessionId: string,
  ): Promise<ImportSuccessionContinuation | null>;
}
