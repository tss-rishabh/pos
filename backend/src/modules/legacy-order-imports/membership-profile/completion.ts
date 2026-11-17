import { z } from 'zod';
import type {
  ImportCompletedProof,
  ImportPublicationReceipt,
} from '../financial-adapter-contracts.js';
import { csvMembershipError, csvMembershipReceiptSchema } from './domain.js';
import { csvMembershipReferenceSchema } from './reference-contracts.js';
import {
  csvMembershipStagedReferenceSchema,
  csvMembershipReferenceActivationSchema,
  assertReferenceActivationMutation,
} from './staged-reference-contracts.js';

export const csvMembershipSnapshotMaximumBytes = 262144;
export const csvMembershipCompletionSnapshotSchema = z
  .object({
    receipt: csvMembershipReceiptSchema,
    /** Original completed membership descriptor's source proof_hash. */
    sourceReceiptHash: z.string().regex(/^[a-f0-9]{64}$/),
    reference: csvMembershipReferenceSchema.optional(),
    stagedReference: csvMembershipStagedReferenceSchema.optional(),
    referenceActivation: z
      .object({
        data: csvMembershipReferenceActivationSchema,
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), 'utf8') <= csvMembershipSnapshotMaximumBytes,
    'The immutable membership snapshot exceeds its bound.',
  );
export type CsvMembershipCompletionSnapshot = z.infer<typeof csvMembershipCompletionSnapshotSchema>;
export type CsvMembershipCompletionScope = Pick<
  ImportCompletedProof,
  'scope' | 'planHash' | 'requestHash' | 'authority' | 'kind' | 'order'
>;
/** The private source emits one durable intent for any positive invalidation
 * count. Broker acceptance is distinct from the Redis task's later outcome. */
export function assertCsvMembershipPublication(
  snapshot: CsvMembershipCompletionSnapshot | null,
  publication: ImportPublicationReceipt,
) {
  const jobs = publication.jobs.filter((job) => job.kind === 'membership-cache');
  if (jobs.length !== (snapshot && snapshot.receipt.cacheInvalidations > 0 ? 1 : 0))
    throw csvMembershipError();
}

/** Structural read validation AFTER authenticating the enclosing financial seal.
 * It is deliberately independent of present product settings, source/member keys,
 * contacts and entitlements. It does not authenticate an untrusted snapshot. */
export function validateCsvMembershipCompletionSnapshot(
  input: unknown,
  completed: CsvMembershipCompletionScope,
): CsvMembershipCompletionSnapshot {
  const parsed = csvMembershipCompletionSnapshotSchema.safeParse(input);
  if (!parsed.success) throw csvMembershipError();
  const snapshot = parsed.data,
    value = snapshot.receipt,
    { scope, order } = completed;
  if (
    value.operationId !== scope.operationId ||
    value.actorId !== scope.actorId ||
    value.storeId !== scope.storeId ||
    value.counterId !== scope.counterId ||
    value.planHash !== completed.planHash ||
    value.requestHash !== completed.requestHash ||
    value.namespace !== `pos-import-v1:${scope.operationId}` ||
    value.customerId !== completed.authority.customerId ||
    value.orderId !== order.orderId ||
    value.customerId !== order.customerId ||
    value.storeId !== order.storeId ||
    value.counterId !== order.counterId ||
    value.requestHash !== order.requestHash ||
    value.namespace !== order.namespace ||
    value.operationId !== order.operationId ||
    value.headerHash !== order.headerHash ||
    value.lineHash !== order.lineHash ||
    value.method !== order.method ||
    value.method !== (completed.kind === 'offline' ? 14 : 15) ||
    value.sourceCommit !== order.sourceCommit ||
    value.provenance.orderId !== order.orderId ||
    value.provenance.customerId !== order.customerId
  )
    throw csvMembershipError();
  if (snapshot.reference) {
    const r = snapshot.reference.data;
    if (
      completed.kind !== 'offline' ||
      r.operationId !== scope.operationId ||
      r.requestHash !== completed.requestHash ||
      r.planHash !== completed.planHash ||
      r.namespace !== value.namespace ||
      r.orderId !== order.orderId ||
      r.customerId !== order.customerId ||
      r.sourceReceiptHash !== snapshot.sourceReceiptHash ||
      r.activation.orderId !== value.provenance.orderId ||
      r.activation.customerId !== value.provenance.customerId ||
      r.activation.operationId !== value.provenance.operationId ||
      r.activation.entityDigest !==
        (snapshot.referenceActivation?.data.activation.entityDigest ??
          value.provenance.entityDigest) ||
      (snapshot.referenceActivation &&
        r.activation.proofHash !== snapshot.referenceActivation.data.activation.proofHash) ||
      r.activation.headerHash !== value.provenance.headerHash ||
      r.activation.createdAt !== value.provenance.createdAt ||
      JSON.stringify(r.activation.before) !== JSON.stringify(value.provenance.before) ||
      r.transfers[0]?.previousEntity !== r.activation.entityDigest ||
      r.transfers.at(-1)?.nextEntity !== r.currentEntity
    )
      throw csvMembershipError();
    for (let index = 1; index < r.transfers.length; index++) {
      if (
        r.transfers[index]!.previousEntity !== r.transfers[index - 1]!.nextEntity ||
        r.transfers[index]!.committedAt < r.transfers[index - 1]!.committedAt
      )
        throw csvMembershipError();
    }
  }
  if (snapshot.stagedReference) {
    const r = snapshot.stagedReference.data;
    if (
      r.operationId !== scope.operationId ||
      r.requestHash !== completed.requestHash ||
      r.planHash !== completed.planHash ||
      r.namespace !== value.namespace ||
      r.orderId !== order.orderId ||
      r.customerId !== order.customerId ||
      r.sourceReceiptHash !== snapshot.sourceReceiptHash ||
      JSON.stringify(r.original) !== JSON.stringify(value.provenance) ||
      r.transfers[0]?.previousEntity !== r.original.entityDigest ||
      r.transfers.at(-1)?.nextEntity !== r.currentEntity
    )
      throw csvMembershipError();
    if (completed.kind === 'offline') {
      const a = snapshot.referenceActivation?.data;
      if (
        !a ||
        a.referenceHash !== snapshot.stagedReference.sourceHash ||
        a.originalStageHash !== r.original.proofHash ||
        a.sourceReceiptHash !== r.sourceReceiptHash ||
        a.operationId !== scope.operationId ||
        a.orderId !== order.orderId ||
        a.customerId !== order.customerId ||
        a.requestHash !== completed.requestHash ||
        a.planHash !== completed.planHash ||
        a.activation.entityDigest !== r.currentEntity ||
        JSON.stringify(a.activation.before) !== JSON.stringify(r.original.before)
      )
        throw csvMembershipError();
      assertReferenceActivationMutation(snapshot.stagedReference, a, {
        kind: value.kind,
        productId: value.memberLines[0]!.productId,
      });
    } else if (snapshot.referenceActivation) throw csvMembershipError();
  } else if (snapshot.referenceActivation) throw csvMembershipError();
  const lines = new Map(order.lines.map((line) => [line.id, line]));
  if (lines.size !== order.lines.length) throw csvMembershipError();
  for (const member of [...value.memberLines, ...value.additionalLines]) {
    const line = lines.get(member.id);
    if (
      !line ||
      line.productId !== member.productId ||
      line.quantity !== member.quantity ||
      line.inputHash !== member.inputHash
    )
      throw csvMembershipError();
  }
  const member = value.memberLines[0]!;
  if (order.lines.filter((line) => line.productId === member.productId).length !== 1)
    throw csvMembershipError();
  if (
    value.replacement &&
    order.lines.some((line) => line.productId === value.replacement!.originalLine.productId)
  )
    throw csvMembershipError();
  return snapshot;
}
