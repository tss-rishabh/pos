import { and, asc, eq, inArray, like, or, gt } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import {
  AmountToBeRefundedLog,
  Attributes,
  HasCategories,
  HasOptions,
  HasProduct,
  Order,
  Product,
  ProductStore,
  ReversePickupReason,
  SubReason,
} from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { pythonRound2 } from '../../domain/python-round.js';
import type { CheckoutGateway } from './gateway.js';

/** Source AjaxGetPayAmtView; fractional behavior intentionally matches Python. */
export function refundPreview(input: {
  prepaid: boolean;
  exchangeOrder: boolean;
  superAdmin: boolean;
  amount: number;
  walletUsed: number;
  giftVoucherUsed: number;
}) {
  let mode = 'prepaid',
    pay = 0;
  if (!input.prepaid) {
    mode = 'other';
    pay = pythonRound2(input.amount - input.walletUsed - input.giftVoucherUsed);
  }
  if (input.prepaid && input.superAdmin && input.exchangeOrder) {
    mode = 'other';
    pay = pythonRound2(input.amount - input.giftVoucherUsed);
  }
  return { pay_mode: mode, pay_amt: pay, is_exchange_order: input.exchangeOrder };
}
/** The return leg, not a mutable line marker, proves a failed exchange took the old item. */
export const exchangeRetryable = (lineStatus: string | null, phaseOneCommitted: boolean) =>
  phaseOneCommitted &&
  lineStatus !== null &&
  ['DELIVERED', 'EXCHANGE_INITIATED'].includes(lineStatus);
export function returnReadService(
  db: Databases,
  gateway: CheckoutGateway,
  assertCheckIn: (userId: string, storeId: string) => Promise<void>,
) {
  async function orderScope(user: Principal, storeId: string, orderId: string) {
    requireStore(user, storeId);
    await assertCheckIn(user.id, storeId);
    // Returns are purpose-bound cross-store operations: the source explicitly
    // accepts online and other-store purchases at the currently checked-in store.
    // Generic order details remain scoped by OrderStore in modules/orders.ts.
    const [row] = await db
      .get('primary')
      .select({
        id: Order.id,
        prepaid: Order.payment_methods,
        parentId: Order.parent_order_id,
        parentExpress: Order.is_parent_express,
      })
      .from(Order)
      .where(eq(Order.id, BigInt(orderId)))
      .limit(1);
    if (!row) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order was not found.');
    return row;
  }
  return {
    async refund(user: Principal, storeId: string, orderId: string, lineId: string) {
      const order = await orderScope(user, storeId, orderId);
      const [line] = await db
        .get('primary')
        .select({ productId: HasProduct.product })
        .from(HasProduct)
        .where(and(eq(HasProduct.id, BigInt(lineId)), eq(HasProduct.order, BigInt(orderId))))
        .limit(1);
      if (!line) throw new AppError(404, 'ORDER_LINE_NOT_FOUND', 'Order line was not found.');
      const prepaid = order.prepaid === 3n,
        exchangeOrder = order.parentId > 0n && !order.parentExpress;
      if (prepaid && !(user.role === 1 && exchangeOrder))
        return refundPreview({
          prepaid,
          exchangeOrder,
          superAdmin: false,
          amount: 0,
          walletUsed: 0,
          giftVoucherUsed: 0,
        });
      const [amount] = await db
        .get('primary')
        .select({
          amount: AmountToBeRefundedLog.amount_to_be_refunded,
          wallet: AmountToBeRefundedLog.tss_money_used,
          gift: AmountToBeRefundedLog.gift_voucher_amount,
        })
        .from(AmountToBeRefundedLog)
        .where(
          and(
            eq(AmountToBeRefundedLog.order_id, BigInt(orderId)),
            eq(AmountToBeRefundedLog.has_product_id, BigInt(lineId)),
            eq(AmountToBeRefundedLog.prod_id, line.productId),
          ),
        )
        .orderBy(asc(AmountToBeRefundedLog.id))
        .limit(1);
      if (!amount && prepaid)
        return { pay_mode: 'prepaid', pay_amt: 0, is_exchange_order: exchangeOrder };
      if (!amount)
        throw new AppError(
          409,
          'REFUND_AMOUNT_UNAVAILABLE',
          'No refundable amount is recorded for this line.',
        );
      return refundPreview({
        prepaid,
        exchangeOrder,
        superAdmin: user.role === 1,
        amount: amount.amount,
        walletUsed: amount.wallet,
        giftVoucherUsed: amount.gift,
      });
    },
    async reasons(user: Principal, storeId: string) {
      requireStore(user, storeId);
      const rows = await db
        .get('primary')
        .select({
          id: ReversePickupReason.id,
          reason: ReversePickupReason.reason,
          type: ReversePickupReason.type,
        })
        .from(ReversePickupReason)
        .orderBy(asc(ReversePickupReason.id));
      return rows.map((row) => ({ ...row, id: String(row.id) }));
    },
    async subReasons(user: Principal, storeId: string, productId: string, reasonId: string) {
      requireStore(user, storeId);
      const [product] = await db
        .get('primary')
        .select({ id: Product.id, parentId: Product.parent_prod_id })
        .from(Product)
        .where(eq(Product.id, BigInt(productId)))
        .limit(1);
      if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
      const categories = await db
        .get('primary')
        .select({ id: HasCategories.cat_id })
        .from(HasCategories)
        .where(eq(HasCategories.prod_id, product.parentId > 0n ? product.parentId : product.id));
      const categoryIds = new Set(categories.map((c) => String(c.id)));
      const reasons = await db
        .get('primary')
        .select({
          id: SubReason.id,
          sub_reason: SubReason.sub_reason,
          categories: SubReason.cat_id,
        })
        .from(SubReason)
        .where(eq(SubReason.reason, Number(reasonId)))
        .orderBy(asc(SubReason.id));
      return reasons
        .filter((row) => {
          try {
            const list: unknown = JSON.parse(row.categories);
            return (
              Array.isArray(list) &&
              list.some(
                (category) =>
                  typeof category === 'number' &&
                  Number.isSafeInteger(category) &&
                  categoryIds.has(String(category)),
              )
            );
          } catch {
            return false;
          }
        })
        .map(({ id, sub_reason }) => ({ id: String(id), sub_reason }));
    },
    async exchangeReasons(user: Principal, storeId: string, productId: string) {
      requireStore(user, storeId);
      const [product] = await db
        .get('primary')
        .select({ id: Product.id, parentId: Product.parent_prod_id })
        .from(Product)
        .where(eq(Product.id, BigInt(productId)))
        .limit(1);
      if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
      const [category] = await db
        .get('primary')
        .select({ id: HasCategories.cat_id })
        .from(HasCategories)
        .where(eq(HasCategories.prod_id, product.parentId > 0n ? product.parentId : product.id))
        .orderBy(asc(HasCategories.id))
        .limit(1);
      if (!category)
        throw new AppError(
          422,
          'PRODUCT_CATEGORY_MISSING',
          'This product has no category for exchange reasons.',
        );
      return gateway.exchangeReasons(String(category.id));
    },
    async sizes(user: Principal, storeId: string, parentId: string) {
      requireStore(user, storeId);
      const variants = await db
        .get('primary')
        .select({ id: Product.id, stock: ProductStore.stock })
        .from(ProductStore)
        .innerJoin(Product, eq(Product.id, ProductStore.product))
        .where(
          and(
            eq(Product.parent_prod_id, BigInt(parentId)),
            eq(ProductStore.store, BigInt(storeId)),
            eq(ProductStore.is_del, false),
            eq(ProductStore.is_avail, true),
            or(eq(Product.is_del, 0), gt(ProductStore.stock, 0)),
          ),
        )
        .orderBy(asc(Product.id));
      if (!variants.length) return [];
      const sizes = await db
        .get('primary')
        .select({ productId: HasOptions.prod_id, size: HasOptions.attr_val })
        .from(HasOptions)
        .innerJoin(Attributes, eq(Attributes.id, HasOptions.attr))
        .where(
          and(
            inArray(
              HasOptions.prod_id,
              variants.map((v) => v.id),
            ),
            like(Attributes.attr, '%Size%'),
          ),
        )
        .orderBy(asc(HasOptions.id));
      const sizeByProduct = new Map(sizes.map((row) => [String(row.productId), row.size]));
      return variants.map((v) => ({
        prod_id: String(v.id),
        size: sizeByProduct.get(String(v.id)) ?? null,
        stock: v.stock,
      }));
    },
  };
}
