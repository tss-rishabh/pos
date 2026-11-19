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
import type { EphemeralStore } from '../../../jobs/ephemeral.js';
import { currentRequestTrace } from '../../../observability/context.js';
import type { AdministrationTransaction } from '../checkins.js';
import { barcodeAssignmentInput, barcodeReceipt, type BarcodeReceipt } from './domain.js';
import { withBarcodeMutationLock } from './locks.js';

/** Ledger: `pos:idem:barcode:{operationId}` -> {actorId, inputHash, receipt}, EX 86400. */
export const barcodeReceiptKey = (operationId: string) => `pos:idem:barcode:${operationId}`;
const receiptTtlSeconds = 86_400;
const storedReceipt = z
  .object({
    actorId: identifier,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    receipt: barcodeReceipt,
  })
  .strict();

/** Source `advance_permisson("[1,2,3]")` (`core/views.py:1244`): roles 1-3 of any user type. */
export async function assertBarcodeOperator(tx: AdministrationTransaction, user: Principal) {
  identifier.parse(user.id);
  const [actor] = await tx
    .select({ active: PosUser.is_active, role: PosUser.role })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(user.id)))
    .limit(1)
    .for('share');
  if (!actor?.active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  if (![1, 2, 3].includes(actor.role))
    throw new AppError(
      403,
      'BARCODE_ASSIGNMENT_DENIED',
      'Barcode assignment requires an administrator, admin or operations manager role.',
    );
}
const notFound = () =>
  new AppError(404, 'BARCODE_ASSIGNMENT_NOT_FOUND', 'This barcode assignment has not been saved.');
async function readReceipt(ephemeral: EphemeralStore, operationId: string) {
  const raw = await ephemeral.get(barcodeReceiptKey(operationId));
  if (raw === null) return null;
  const parsed = storedReceipt.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success || parsed.data.receipt.id !== operationId)
    throw new AppError(
      503,
      'BARCODE_RECEIPT_INVALID',
      'This barcode assignment requires receipt reconciliation.',
    );
  return parsed.data;
}
export function barcodeAssignmentService(
  config: Config,
  db: Databases,
  ephemeral: EphemeralStore,
  clock = () => Temporal.Now.instant(),
) {
  return {
    async assign(user: Principal, raw: unknown) {
      const input = barcodeAssignmentInput.parse(raw),
        inputHash = createHmac('sha256', config.SESSION_SECRET)
          .update('barcode-assignment-v1:')
          .update(JSON.stringify({ productId: input.productId, barcode: input.barcode }))
          .digest('hex');
      await db.get('writer').transaction((tx) => assertBarcodeOperator(tx, user));
      return withBarcodeMutationLock(ephemeral, async () => {
        const previous = await readReceipt(ephemeral, input.operationId);
        if (previous) {
          if (previous.actorId !== user.id || previous.inputHash !== inputHash)
            throw new AppError(
              409,
              'BARCODE_OPERATION_REUSED',
              'This operation belongs to a different barcode assignment.',
            );
          return previous.receipt;
        }
        const receipt = await retryTransaction(() =>
          db.get('writer').transaction(async (tx) => {
            await assertBarcodeOperator(tx, user);
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
            const rejected = (
              code: 'INVALID_PRODUCT' | 'PRODUCT_HAS_BARCODE' | 'GTIN_ASSIGNED',
              message: string,
            ): BarcodeReceipt =>
              barcodeReceipt.parse({
                ...base,
                status: 'fail',
                code,
                message,
                barcodeRowId: null,
                auditId: null,
              });
            const [product] = await tx
              .select({ id: Product.id })
              .from(Product)
              .where(eq(Product.id, BigInt(input.productId)))
              .limit(1);
            if (!product) return rejected('INVALID_PRODUCT', 'Invalid Product');
            const [existing] = await tx
              .select({ id: ProductBarcode.id })
              .from(ProductBarcode)
              .where(eq(ProductBarcode.product, product.id))
              .orderBy(asc(ProductBarcode.id))
              .limit(1);
            if (existing)
              return rejected('PRODUCT_HAS_BARCODE', 'Product already belongs to another Barcode');
            const [conflict] = await tx
              .select({ productId: ProductBarcode.product })
              .from(ProductBarcode)
              .where(eq(ProductBarcode.gtin, BigInt(input.barcode)))
              .orderBy(asc(ProductBarcode.id))
              .limit(1);
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
            // Source `special_permission_activity_logger` (`helpers/helpers.py:740-756`) swallows
            // its own failure; a savepoint keeps the committed barcode when the audit insert fails.
            let auditId: string | null = null;
            try {
              auditId = await tx.transaction(async (savepoint) =>
                String(
                  generatedId(
                    await savepoint.insert(PosSpecialPermissionActivityLog).values({
                      pos_user_id: BigInt(user.id),
                      platform: 'barcode',
                      comment: message,
                      recipient: '',
                      created_at: createdAt,
                      updated_at: createdAt,
                    }),
                  ),
                ),
              );
            } catch {
              auditId = null;
            }
            return barcodeReceipt.parse({
              ...base,
              status: 'success',
              code: 'ASSIGNED',
              message,
              barcodeRowId: String(barcodeRowId),
              auditId,
            });
          }),
        );
        await ephemeral.set(
          barcodeReceiptKey(input.operationId),
          JSON.stringify({ actorId: user.id, inputHash, receipt }),
          { EX: receiptTtlSeconds },
        );
        return receipt;
      });
    },
    async get(user: Principal, id: string) {
      z.uuid().parse(id);
      await db.get('writer').transaction((tx) => assertBarcodeOperator(tx, user));
      const stored = await readReceipt(ephemeral, id);
      if (!stored || stored.actorId !== user.id) throw notFound();
      return stored.receipt;
    },
  };
}
