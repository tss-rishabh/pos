import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { generatedId } from '../../db/generated-id.js';
import { HasProduct, Order, Product } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { CheckoutState } from '../checkout/contracts.js';
import { operationHash } from '../checkout/crypto.js';
import { benefitCustomers } from '../customer-insights/benefits-schema.js';
import {
  customerCheckoutScope,
  customerProfileEditable,
} from '../customer-insights/checkout-scope.js';
import {
  feedbackIdentifier,
  feedbackPage,
  feedbackReceipt,
  feedbackSubmission,
  feedbackWorkspace,
  productFeedbackScope,
  sourceFeedbackOrder,
  type FeedbackSubmission,
  type ProductFeedbackScope,
} from './contracts.js';
import { productRatings } from './schema.js';
import type { OrderRedis } from '../fulfillment/order-redis.js';

/**
 * Lost-response replay receipt (table-disposition.md product-feedback: the rewrite-only
 * `pos_rewrite_product_feedback_receipts` table moves to Redis). Legacy has no dedupe.
 * `pos:product_feedback:{operationId}` → JSON {operatorId, storeId, counterId, checkoutId,
 * customerId, orderId, productId, requestHash, checkoutVersion, receipt}, SET NX EX 86400.
 */
export const feedbackReceiptKey = (operationId: string) => `pos:product_feedback:${operationId}`;
const FEEDBACK_RECEIPT_TTL_SECONDS = 86400;
const storedReceipt = z
  .object({
    operatorId: z.string(),
    storeId: z.string(),
    counterId: z.string(),
    checkoutId: z.string(),
    customerId: z.string(),
    orderId: z.string(),
    productId: z.string(),
    requestHash: z.string(),
    checkoutVersion: z.number().int(),
    receipt: z.unknown(),
  })
  .strict();

const missing = () =>
  new AppError(
    404,
    'PRODUCT_FEEDBACK_NOT_FOUND',
    'This product feedback is unavailable for this sale.',
  );
export function productFeedbackService(
  config: Config,
  db: Databases,
  redis: OrderRedis,
  clock: () => number = Date.now,
) {
  const withCheckout = customerCheckoutScope(config, db);
  async function savedReceipt(operationId: string) {
    const raw = await redis.get(feedbackReceiptKey(operationId));
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
    const parsed = storedReceipt.safeParse(value);
    if (!parsed.success)
      throw new AppError(
        503,
        'PRODUCT_FEEDBACK_RECEIPT_INVALID',
        'The saved product feedback requires review.',
      );
    return parsed.data;
  }
  async function currentOrder(
    tx: AdministrationTransaction,
    state: CheckoutState & { customerId: string },
    scope: ProductFeedbackScope,
    lock: 'share' | 'update',
  ) {
    if (state.customerId !== scope.customerId) throw missing();
    // Match payment/source lock order: Order -> customer. Feedback must not
    // invert that order while a cashier is settling the same delivered order.
    const [order] = await tx
      .select({ id: Order.id, amount: Order.order_amt, status: Order.order_statuses })
      .from(Order)
      .where(and(eq(Order.id, BigInt(scope.orderId)), eq(Order.user, BigInt(state.customerId))))
      .limit(1)
      .for(lock);
    if (!order) throw missing();
    const [customer] = await tx
      .select({ id: benefitCustomers.id })
      .from(benefitCustomers)
      .where(
        and(
          eq(benefitCustomers.id, BigInt(state.customerId)),
          eq(benefitCustomers.active, 1),
          or(isNull(benefitCustomers.blocked), eq(benefitCustomers.blocked, 0)),
          or(isNull(benefitCustomers.disabled), eq(benefitCustomers.disabled, 0)),
        ),
      )
      .limit(1)
      .for(lock);
    if (!customer) throw missing();
    return order;
  }
  async function capture(user: Principal, scope: ProductFeedbackScope) {
    return withCheckout(
      user,
      { storeId: scope.storeId, checkoutId: scope.checkoutId },
      'share',
      async (tx, state) => ({
        order: await currentOrder(tx, state, scope, 'share'),
        version: state.version,
        editable: customerProfileEditable(state),
        counterId: state.counterId,
      }),
    );
  }
  async function command(
    user: Principal,
    scope: ProductFeedbackScope,
    operationId: string,
    input?: FeedbackSubmission,
  ) {
    productFeedbackScope.parse(scope);
    z.uuid().parse(operationId);
    return withCheckout(
      user,
      { storeId: scope.storeId, checkoutId: scope.checkoutId },
      'update',
      async (tx, state) => {
        const order = await currentOrder(tx, state, scope, 'update');
        const saved = await savedReceipt(operationId);
        const requestHash = input
          ? operationHash(
              'product-feedback',
              { operatorId: user.id, scope, input },
              config.SESSION_SECRET,
            )
          : null;
        if (saved) {
          if (
            saved.operatorId !== user.id ||
            saved.storeId !== scope.storeId ||
            saved.counterId !== state.counterId ||
            saved.checkoutId !== state.id ||
            saved.customerId !== state.customerId ||
            saved.orderId !== scope.orderId
          )
            throw missing();
          if (requestHash && requestHash !== saved.requestHash)
            throw new AppError(
              409,
              'PRODUCT_FEEDBACK_OPERATION_REUSED',
              'Recover the saved feedback before starting another submission.',
            );
          const result = feedbackReceipt.safeParse(saved.receipt);
          if (
            !result.success ||
            result.data.operationId !== operationId ||
            result.data.checkoutId !== state.id ||
            result.data.customerId !== state.customerId ||
            result.data.orderId !== scope.orderId ||
            result.data.productId !== saved.productId ||
            result.data.checkoutVersion !== saved.checkoutVersion ||
            new Set(result.data.ratingIds).size !== 4
          )
            throw new AppError(
              503,
              'PRODUCT_FEEDBACK_RECEIPT_INVALID',
              'The saved product feedback requires review.',
            );
          return result.data;
        }
        if (!input) throw missing();
        if (!customerProfileEditable(state) || state.version !== input.expectedVersion)
          throw new AppError(
            409,
            'PRODUCT_FEEDBACK_SALE_CHANGED',
            'This sale changed. Reopen product feedback before saving.',
          );
        if (order.status !== 3n)
          throw new AppError(
            409,
            'PRODUCT_FEEDBACK_ORDER_NOT_DELIVERED',
            'Feedback can be added after the order is delivered.',
          );
        const [line] = await tx
          .select({ id: HasProduct.id })
          .from(HasProduct)
          .where(
            and(eq(HasProduct.order, order.id), eq(HasProduct.product, BigInt(input.productId))),
          )
          .orderBy(asc(HasProduct.id))
          .limit(1)
          .for('share');
        if (!line) throw missing();
        // Any source row makes this aggregate SKU read-only, including a partial,
        // mobile, bot or per-HP rating. Never complete or overwrite another writer.
        const [existing] = await tx
          .select({ id: productRatings.id })
          .from(productRatings)
          .where(
            and(
              eq(productRatings.orderId, order.id),
              eq(productRatings.productId, BigInt(input.productId)),
            ),
          )
          .limit(1)
          .for('update');
        if (existing)
          throw new AppError(
            409,
            'PRODUCT_FEEDBACK_ALREADY_EXISTS',
            'Feedback already exists for this product. Reload to view it.',
          );
        const now = new Date(clock());
        const sourceTime = Temporal.Instant.fromEpochMilliseconds(now.getTime())
          .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
          .toPlainDateTime()
          .toString({ smallestUnit: 'second' })
          .replace('T', ' ');
        const ratingIds: string[] = [];
        for (const [option, value] of [
          input.overall,
          input.fit,
          input.size,
          input.quality,
        ].entries()) {
          const [inserted] = await tx.insert(productRatings).values({
            customerId: BigInt(state.customerId),
            orderId: order.id,
            productId: BigInt(input.productId),
            optionId: BigInt(option),
            rating: value,
            platform: 'WEB',
            comment: option === 0 ? input.comment : '',
            isDefault: option === 0 ? 1 : 0,
            createdAt: sourceTime,
            updatedAt: sourceTime,
          });
          if (!inserted)
            throw new AppError(
              503,
              'PRODUCT_FEEDBACK_SAVE_FAILED',
              'Product feedback was not saved.',
            );
          // mysql2 preserves insertId strings above Number.MAX_SAFE_INTEGER.
          // Drizzle's generated-ID loop uses i++ and cannot safely enumerate them.
          ratingIds.push(feedbackIdentifier.parse(String(generatedId(inserted))));
        }
        const receipt = feedbackReceipt.parse({
          operationId,
          customerId: state.customerId,
          checkoutId: state.id,
          checkoutVersion: state.version,
          orderId: scope.orderId,
          productId: input.productId,
          ratingIds,
          appliedAt: now.toISOString(),
        });
        return {
          receipt,
          record: {
            operatorId: user.id,
            storeId: scope.storeId,
            counterId: state.counterId,
            checkoutId: state.id,
            customerId: state.customerId,
            orderId: scope.orderId,
            productId: input.productId,
            requestHash: requestHash!,
            checkoutVersion: state.version,
            receipt,
          },
        };
      },
    );
  }
  /** Runs the MySQL write, then records the replay receipt after commit. */
  async function commandWithReceipt(
    user: Principal,
    scope: ProductFeedbackScope,
    operationId: string,
    input?: FeedbackSubmission,
  ) {
    const result = await command(user, scope, operationId, input);
    if (!('record' in result)) return result;
    // A lost receipt only degrades replay: the same submission then sees the saved rows (409).
    await redis
      .set(feedbackReceiptKey(operationId), JSON.stringify(result.record), {
        NX: true,
        EX: FEEDBACK_RECEIPT_TTL_SECONDS,
      })
      .catch(() => false);
    return result.receipt;
  }
  return {
    async read(user: Principal, rawScope: ProductFeedbackScope, rawPage: unknown) {
      const scope = productFeedbackScope.parse(rawScope),
        page = feedbackPage.parse(rawPage);
      const original = await capture(user, scope),
        primary = db.get('primary');
      const lines = await primary
        .select({ lineId: HasProduct.id, productId: HasProduct.product, name: Product.product })
        .from(HasProduct)
        .innerJoin(Product, eq(Product.id, HasProduct.product))
        .where(
          and(
            eq(HasProduct.order, original.order.id),
            page.after ? gt(HasProduct.id, BigInt(page.after)) : undefined,
          ),
        )
        .orderBy(asc(HasProduct.id))
        .limit(page.limit + 1);
      const visible = lines.slice(0, page.limit);
      const ratings = visible.length
        ? await primary
            .select({
              id: productRatings.id,
              productId: productRatings.productId,
              optionId: productRatings.optionId,
              rating: productRatings.rating,
              platform: productRatings.platform,
              comment: productRatings.comment,
            })
            .from(productRatings)
            .where(
              and(
                eq(productRatings.orderId, original.order.id),
                inArray(productRatings.productId, [
                  ...new Set(visible.map((line) => line.productId)),
                ]),
              ),
            )
            .orderBy(asc(productRatings.optionId), asc(productRatings.id))
            .limit(1001)
        : [];
      if (ratings.length > 1000)
        throw new AppError(
          409,
          'PRODUCT_FEEDBACK_REVIEW_REQUIRED',
          'This product feedback requires review before it can be displayed.',
        );
      const current = await capture(user, scope);
      if (
        current.version !== original.version ||
        current.counterId !== original.counterId ||
        current.order.status !== original.order.status ||
        current.order.amount !== original.order.amount ||
        current.editable !== original.editable
      )
        throw new AppError(
          409,
          'PRODUCT_FEEDBACK_SALE_CHANGED',
          'This sale changed. Reopen product feedback.',
        );
      return feedbackWorkspace.parse({
        customerId: scope.customerId,
        checkoutVersion: current.version,
        orderId: scope.orderId,
        orderAmount: current.order.amount,
        editable: current.editable && current.order.status === 3n,
        items: visible.map((line) => ({
          lineId: String(line.lineId),
          productId: String(line.productId),
          name: line.name || String(line.productId),
          feedback: sourceFeedbackOrder(
            ratings
              .filter((row) => row.productId === line.productId)
              .map((row) => ({
                id: String(row.id),
                optionId: row.optionId === null ? null : String(row.optionId),
                rating: row.rating,
                platform: row.platform,
                comment: row.comment,
              })),
          ),
        })),
        nextCursor: lines.length > page.limit ? String(visible.at(-1)!.lineId) : null,
      });
    },
    submit(user: Principal, scope: ProductFeedbackScope, body: unknown) {
      const input = feedbackSubmission.parse(body);
      return commandWithReceipt(user, scope, input.operationId, input);
    },
    receipt(user: Principal, scope: ProductFeedbackScope, operationId: string) {
      return commandWithReceipt(user, scope, operationId);
    },
  };
}
