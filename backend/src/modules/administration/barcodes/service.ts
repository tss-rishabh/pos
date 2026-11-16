import { createHmac } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import {
  PosUser,
  Product,
  ProductBarcode,
  PosSpecialPermissionActivityLog,
} from '../../../db/legacy-schema.js';
import { generatedId } from '../../../db/generated-id.js';
import { retryTransaction } from '../../../db/retry.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import type { Principal } from '../../../domain/access.js';
import { currentRequestTrace } from '../../../observability/context.js';
import type { AdministrationTransaction } from '../checkins.js';
import { barcodeAssignmentInput, barcodeReceipt, type BarcodeReceipt } from './domain.js';
import { barcodeAssignmentReceipts as receipts } from './schema.js';
import { lockBarcodeMutation } from './locks.js';

export async function assertBarcodeOperator(tx: AdministrationTransaction, user: Principal) {
  identifier.parse(user.id);
  const [actor] = await tx
    .select({ active: PosUser.is_active, role: PosUser.role, userType: PosUser.user_type })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(user.id)))
    .limit(1)
    .for('share');
  if (!actor?.active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  if (actor.userType !== 1 || ![1, 2, 3].includes(actor.role))
    throw new AppError(
      403,
      'BARCODE_ASSIGNMENT_DENIED',
      'Barcode assignment requires an internal administrator.',
    );
}
const notFound = () =>
  new AppError(404, 'BARCODE_ASSIGNMENT_NOT_FOUND', 'This barcode assignment has not been saved.');
function readReceipt(row: typeof receipts.$inferSelect): BarcodeReceipt {
  const result = barcodeReceipt.safeParse(row.result);
  if (
    !result.success ||
    result.data.id !== row.id ||
    result.data.operatorId !== row.actorId ||
    result.data.productId !== row.productId ||
    result.data.barcode !== row.barcode ||
    result.data.createdAt !== row.createdAt
  )
    throw new AppError(
      503,
      'BARCODE_RECEIPT_INVALID',
      'This barcode assignment requires receipt reconciliation.',
    );
  return result.data;
}
export function barcodeAssignmentService(
  config: Config,
  db: Databases,
  clock = () => Temporal.Now.instant(),
) {
  return {
    async assign(user: Principal, raw: unknown) {
      const input = barcodeAssignmentInput.parse(raw),
        inputHash = createHmac('sha256', config.SESSION_SECRET)
          .update('barcode-assignment-v1:')
          .update(JSON.stringify({ productId: input.productId, barcode: input.barcode }))
          .digest('hex');
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await assertBarcodeOperator(tx, user);
          await lockBarcodeMutation(tx);
          const [previous] = await tx
            .select()
            .from(receipts)
            .where(eq(receipts.id, input.operationId))
            .limit(1)
            .for('update');
          if (previous) {
            if (previous.actorId !== user.id || previous.inputHash !== inputHash)
              throw new AppError(
                409,
                'BARCODE_OPERATION_REUSED',
                'This operation belongs to a different barcode assignment.',
              );
            return readReceipt(previous);
          }
          const createdAt = clock()
              .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
              .toPlainDateTime()
              .toString({ smallestUnit: 'second' })
              .replace('T', ' '),
            requestId = currentRequestTrace()?.requestId || null;
          const base = {
            id: input.operationId,
            operatorId: user.id,
            productId: input.productId,
            barcode: input.barcode,
            createdAt,
            requestId,
          };
          const save = async (result: BarcodeReceipt) => {
            const valid = barcodeReceipt.parse(result);
            await tx.insert(receipts).values({
              id: input.operationId,
              actorId: user.id,
              inputHash,
              productId: input.productId,
              barcode: input.barcode,
              result: valid,
              createdAt,
            });
            return valid;
          };
          const rejected = (
            code: 'INVALID_PRODUCT' | 'PRODUCT_HAS_BARCODE' | 'GTIN_ASSIGNED',
            message: string,
          ) => save({ ...base, status: 'fail', code, message, barcodeRowId: null, auditId: null });
          const [product] = await tx
            .select({ id: Product.id })
            .from(Product)
            .where(eq(Product.id, BigInt(input.productId)))
            .limit(1)
            .for('update');
          if (!product) return rejected('INVALID_PRODUCT', 'Invalid Product');
          const [existing] = await tx
            .select({ id: ProductBarcode.id })
            .from(ProductBarcode)
            .where(eq(ProductBarcode.product, product.id))
            .orderBy(asc(ProductBarcode.id))
            .limit(1)
            .for('update');
          if (existing)
            return rejected('PRODUCT_HAS_BARCODE', 'Product already belongs to another Barcode');
          const [conflict] = await tx
            .select({ productId: ProductBarcode.product })
            .from(ProductBarcode)
            .where(eq(ProductBarcode.gtin, BigInt(input.barcode)))
            .orderBy(asc(ProductBarcode.id))
            .limit(1)
            .for('update');
          if (conflict)
            return rejected(
              'GTIN_ASSIGNED',
              `Barcode already belongs to another product, Product ID : ${conflict.productId}`,
            );
          const message = `Barcode ${input.barcode} has been added for product Id ${input.productId}`;
          const barcodeRowId = generatedId(
            await tx.insert(ProductBarcode).values({
              product: product.id,
              gtin: BigInt(input.barcode),
              created_at: createdAt,
              updated_at: createdAt,
            }),
          );
          const auditId = generatedId(
            await tx.insert(PosSpecialPermissionActivityLog).values({
              pos_user_id: BigInt(user.id),
              platform: 'barcode',
              comment: message,
              recipient: '',
              created_at: createdAt,
              updated_at: createdAt,
            }),
          );
          return save({
            ...base,
            status: 'success',
            code: 'ASSIGNED',
            message,
            barcodeRowId: String(barcodeRowId),
            auditId: String(auditId),
          });
        }),
      );
    },
    async get(user: Principal, id: string) {
      z.uuid().parse(id);
      return db.get('writer').transaction(async (tx) => {
        await assertBarcodeOperator(tx, user);
        const [row] = await tx
          .select()
          .from(receipts)
          .where(eq(receipts.id, id))
          .limit(1)
          .for('share');
        if (!row || row.actorId !== user.id) throw notFound();
        return readReceipt(row);
      });
    },
  };
}
