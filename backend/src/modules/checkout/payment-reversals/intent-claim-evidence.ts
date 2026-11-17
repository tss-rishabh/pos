import { Temporal } from '@js-temporal/polyfill';
import { operationHash } from '../crypto.js';
import { cashReturnClaimBody } from './intent-claim-contracts.js';
import { cashReturnClaims, cashReturnClaimResolutions } from './intent-claim-schema.js';
import { instantSql, intentReview } from './intent-evidence.js';
export const claimHash = (body: (typeof cashReturnClaims.$inferSelect)['body'], secret: string) =>
  operationHash('cash-return.retained-claim.v1', body, secret);
export function verifiedClaim(row: typeof cashReturnClaims.$inferSelect, secret: string) {
  const parsed = cashReturnClaimBody.safeParse(row.body);
  if (!parsed.success || secret.length < 32) throw intentReview();
  const body = parsed.data,
    local = Temporal.Instant.from(body.input.returnedAt)
      .toZonedDateTimeISO(body.businessTimezone)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  if (
    row.id !== body.id ||
    row.impactFrom !==
      [body.orderDate, body.originalFundingAt.slice(0, 10), body.businessDate].sort()[0] ||
    row.createdAt !== instantSql(Temporal.Instant.from(body.registeredAt)) ||
    body.id !== body.input.original.operationId ||
    row.storeId !== body.storeId ||
    row.orderId !== body.orderId ||
    row.counterId !== body.counterId ||
    body.counterId !== body.input.original.counterId ||
    row.originalPaymentId !== body.input.original.originalPaymentId ||
    row.cashReturnReceiptId !== body.input.original.cashReturnReceiptId ||
    row.bodyHash !== claimHash(body, secret) ||
    body.returnedAt !== local ||
    body.businessDate !== local.slice(0, 10) ||
    Temporal.Instant.compare(
      Temporal.Instant.from(body.input.returnedAt),
      Temporal.Instant.from(body.registeredAt),
    ) > 0
  )
    throw intentReview();
  return body;
}
export function claimResolutionProof(
  fields: Omit<typeof cashReturnClaimResolutions.$inferSelect, 'proofHash'>,
  secret: string,
) {
  return operationHash('cash-return.retained-resolution.v1', fields, secret);
}
export function verifiedClaimResolution(
  row: typeof cashReturnClaimResolutions.$inferSelect,
  secret: string,
) {
  const { proofHash, ...fields } = row;
  if (secret.length < 32 || proofHash !== claimResolutionProof(fields, secret))
    throw intentReview();
  return row;
}
