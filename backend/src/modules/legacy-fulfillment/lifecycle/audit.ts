import { sql } from 'drizzle-orm';
import { Store, PosTransactionLog } from '../../../db/legacy-schema.js';
import { generatedId } from '../../../db/generated-id.js';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';

export async function assertDeliveryAuditText(tx: AdministrationTransaction, comment: string) {
  if ([...comment].length > 255)
    throw new AppError(
      422,
      'LOCAL_DELIVERY_AUDIT_TOO_LONG',
      'The delivery attribution exceeds the audit limit.',
    );
  const [encoding] = await tx
    .select({
      valid:
        sql<number>`(CAST(${comment} AS BINARY) = CAST(CONVERT(CONVERT(${comment} USING latin1) USING utf8mb4) AS BINARY))`.mapWith(
          Number,
        ),
    })
    .from(Store)
    .limit(1);
  if (encoding?.valid !== 1)
    throw new AppError(
      422,
      'LOCAL_DELIVERY_AUDIT_ENCODING_UNSUPPORTED',
      'The delivery attribution cannot be stored safely.',
    );
}
export async function deliveryAudit(
  tx: AdministrationTransaction,
  input: {
    orderId: string;
    storeId: string;
    operatorId: string;
    orderStatus: bigint;
    paymentStatus: bigint;
    comment: string;
    timestamp: string;
    payment?: Record<string, number>;
  },
) {
  await assertDeliveryAuditText(tx, input.comment);
  return generatedId(
    await tx.insert(PosTransactionLog).values({
      order_id: BigInt(input.orderId),
      store_id: BigInt(input.storeId),
      user_id: 0n,
      pos_user_id: BigInt(input.operatorId),
      order_status: input.orderStatus,
      payment_status: input.paymentStatus,
      comment: input.comment,
      pay_dict: JSON.stringify(input.payment || {}),
      created_at: input.timestamp,
      updated_at: input.timestamp,
    }),
  ).toString();
}
