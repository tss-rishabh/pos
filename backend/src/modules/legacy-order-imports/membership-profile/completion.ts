import { z } from 'zod';
import type { ImportCompletedProof } from '../financial-adapter-contracts.js';
import { csvMembershipError, csvMembershipReceiptSchema } from './domain.js';

export const csvMembershipSnapshotMaximumBytes = 262144;
export const csvMembershipCompletionSnapshotSchema = z
  .object({
    receipt: csvMembershipReceiptSchema,
    /** Original completed membership descriptor's source proof_hash. */
    sourceReceiptHash: z.string().regex(/^[a-f0-9]{64}$/),
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
  return snapshot;
}
