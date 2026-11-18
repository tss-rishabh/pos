import { and, asc, eq, inArray } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import {
  ExclusiveUser,
  GiftVoucher,
  HasProduct,
  MUser,
  Order,
  OrderStatus,
  OrderStore,
  PaymentMethod,
  PaymentStatus,
  PosPaytmTransaction,
  PosTerminalTransaction,
  PosTransactionLog,
  Product,
  ReversePickupReason,
  Store,
  StoreCounter,
  UserStore,
  VinculumAutoDeliveredLog,
} from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import { requireStore, type Principal } from '../../domain/access.js';
import { checkInService } from '../administration/checkins.js';
import { detailDecimal, detailPaymentEntries, detailWallet } from './online-detail/values.js';

type Reader = Pick<ReturnType<Databases['get']>, 'select'>;

/**
 * Legacy `EXCHANGE_ENABLED_STORE_IDS` (`POSAdmin/settings.py:588-592`): default `"1"`,
 * `all` (any case) enables every store, otherwise comma-separated integers.
 */
export function exchangeEnabledStores(raw = process.env.EXCHANGE_ENABLED_STORE_IDS ?? '1') {
  const value = raw.trim();
  if (value.toLowerCase() === 'all') return { all: true, ids: new Set<string>() };
  return {
    all: false,
    ids: new Set(
      value
        .split(',')
        .filter((part) => part.trim())
        .map((part) => {
          if (!/^\s*[+-]?\d+\s*$/.test(part)) throw new Error('Invalid EXCHANGE_ENABLED_STORE_IDS');
          return String(BigInt(part.trim()));
        }),
    ),
  };
}

/** Legacy `Helpers.get_exclusive_user` (`helpers/helpers.py:254-281`). */
export function legacyExclusive(
  row: { value: string | null; active: number | null } | undefined,
  now: Temporal.PlainDateTime,
) {
  if (!row) return { member: false, expiry: null, message: '' };
  const active = Number(row.active ?? 0) !== 0;
  let expiry: Temporal.PlainDateTime | null = null;
  const value = row.value ?? '';
  for (const pattern of [
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{1,6})$/,
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/,
  ]) {
    const match = pattern.exec(value);
    if (!match) continue;
    try {
      expiry = Temporal.PlainDateTime.from(
        {
          year: Number(match[1]),
          month: Number(match[2]),
          day: Number(match[3]),
          hour: Number(match[4]),
          minute: Number(match[5]),
          second: Number(match[6]),
          microsecond: match[7] ? Number(match[7].padEnd(6, '0')) : 0,
        },
        { overflow: 'reject' },
      );
      break;
    } catch {
      expiry = null;
    }
  }
  return {
    member: active,
    // Rendered as `strftime("%d/%m/%Y")` by the view.
    expiry: expiry
      ? `${String(expiry.day).padStart(2, '0')}/${String(expiry.month).padStart(2, '0')}/${String(expiry.year).padStart(4, '0')}`
      : null,
    message:
      !active && expiry && Temporal.PlainDateTime.compare(expiry, now) > 0
        ? "User's Membership is deactivated."
        : '',
  };
}

/** Legacy `Helpers.get_transaction_id` (`helpers/helpers.py:714-736`). */
export function legacyTransactionId(input: {
  orderId: string;
  reference: string | null;
  terminalInactiveCreated: number;
  paytmInactiveCreated: number;
  paytmActiveCreated: boolean;
}) {
  const terminal = input.terminalInactiveCreated ? input.terminalInactiveCreated + 1 : 0,
    paytm = input.paytmInactiveCreated ? input.paytmInactiveCreated + 1 : 0,
    total = terminal + paytm;
  let reference = input.reference;
  let suffix: string;
  if (input.paytmActiveCreated) {
    // Legacy calls order_ref_no.replace() here and fails for NULL; keep the order id instead.
    reference = reference === null ? null : reference.replaceAll('-', '');
    suffix = String(total);
  } else suffix = `-${total}`;
  if (total) return `${reference || input.orderId}${suffix}`;
  const result = reference || input.orderId;
  return result.replaceAll('-', '').length >= 8 ? result : input.orderId;
}

const vincPlatforms = ['CREATE', 'PACK', 'SHIP', 'DELIVER'] as const;

export interface StoreOrderLegacyContext {
  crossAccess: boolean;
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    telephone: string;
    tssMoney: string;
    tssPoints: string;
  } | null;
  exclusive: { member: boolean; expiry: string | null; message: string };
  paymentStatus: { id: string; label: string } | null;
  paymentMethod: { id: string; name: string | null } | null;
  orderStatus: { id: string; label: string } | null;
  storeName: string;
  isOfflineOrder: boolean;
  isShopifyOrder: boolean;
  orderMessage: string;
  isManuallyPaid: boolean;
  counterId: string;
  transactionId: string;
  isUploaded: boolean;
  plutusId: string;
  paytmMid: string;
  showMarkPaymentPopUp: boolean;
  totalItems: number;
  giftVouchers: { id: string; giftCardSrno: string }[];
  vincStatus: Record<(typeof vincPlatforms)[number], { status: string; date: string }>;
  isFranchiseeOrder: boolean;
  isSuperAdmin: boolean;
  isAtStore: boolean;
  checkedInStoreId: string | null;
  exchangeFeatureEnabled: boolean;
  reasons: { id: string; reason: string }[];
  transactionLog: {
    storeId: string;
    orderStatus: string;
    paymentStatus: string;
    comment: string;
    createdAt: string;
    payments: { method: string; value: string | null }[];
  }[];
  /** `order_point_cashback` lives on legacy's separate `mysql_db` connection; not readable here. */
  cashback: null;
}
export interface StoreOrderLine {
  id: string;
  productId: string;
  name: string | null;
  erpProduct: string;
  quantity: string;
  amount: number;
  gst: number;
  status: string | null;
  productType: string;
  parentProductId: string;
  giftVoucherId: string;
  returnStatus: number;
}
export interface StoreOrderDetail {
  id: string;
  reference: string | null;
  amount: number;
  orderAmount: number;
  createdAt: string;
  status: string | null;
  isPaid: boolean;
  reader: 'primary';
  fetchedAt: string;
  lines: StoreOrderLine[];
  legacy: StoreOrderLegacyContext;
}

const forbidden = () =>
  new AppError(403, 'ORDER_STORE_FORBIDDEN', 'Unauthorized access to the store order.');
const notFound = () => new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');

/**
 * Legacy `ShowOrderDetailsView.get` (`order/views.py:351-501`), read from the default (primary)
 * database for any order date. `crossAccess` is the legacy `?cr=1` link from an order-ID
 * search: it skips the store-assignment check, as legacy does, and stays read-only.
 */
export function storeOrderDetailReader(
  config: Config,
  db: Databases,
  clock: () => number = Date.now,
) {
  const checkIns = checkInService(db, config);
  async function checkedInStore(reader: Reader, userId: string) {
    // Helpers.get_checkin_store: an active STORE-type check-in (`helpers/helpers.py:1791-1800`).
    const id = await checkIns.checkedInStore(userId);
    if (!id) return null;
    const [store] = await reader
      .select({ id: Store.id, franchise: Store.franchise_id })
      .from(Store)
      .where(and(eq(Store.id, BigInt(id)), eq(Store.is_active, true), eq(Store.type, 'STORE')))
      .limit(1);
    return store ? { id: String(store.id), franchise: store.franchise } : null;
  }
  return async function read(
    user: Principal,
    storeId: string,
    orderId: string,
    crossAccess: boolean,
  ): Promise<StoreOrderDetail> {
    requireStore(user, storeId);
    const reader = db.get('primary');
    return reader.transaction(
      async (tx) => {
        const [header] = await tx
          .select({
            id: Order.id,
            userId: Order.user,
            reference: Order.order_ref_no,
            orderAmount: Order.order_amt,
            payAmount: Order.pay_amt,
            createdAt: Order.created_at,
            statusId: Order.order_statuses,
            status: OrderStatus.order_status,
            statusDisplay: OrderStatus.display_name,
            paymentStatusId: Order.payment_statuses,
            paymentStatus: PaymentStatus.payment_status,
            methodId: Order.payment_methods,
            method: PaymentMethod.name,
            moneyUsed: Order.tss_money_used,
            pointsUsed: Order.tss_points_used,
            voucherUsed: Order.voucher_amt_used,
            couponUsed: Order.coupon_amt_used,
            pgDiscount: Order.pg_disc,
          })
          .from(Order)
          .leftJoin(OrderStatus, eq(OrderStatus.id, Order.order_statuses))
          .leftJoin(PaymentStatus, eq(PaymentStatus.id, Order.payment_statuses))
          .leftJoin(PaymentMethod, eq(PaymentMethod.id, Order.payment_methods))
          .where(eq(Order.id, BigInt(orderId)))
          .limit(1);
        if (!header) throw notFound();
        const mappings = await tx
          .select({
            id: OrderStore.id,
            storeId: OrderStore.store,
            counterId: OrderStore.counter,
            manual: OrderStore.is_manually_paid,
            offline: OrderStore.is_offline_order,
            shopify: OrderStore.is_shopify_order,
            message: OrderStore.message,
            storeName: Store.store_name,
            franchise: Store.franchise_id,
            counterName: StoreCounter.counter_name,
          })
          .from(OrderStore)
          .leftJoin(Store, eq(Store.id, OrderStore.store))
          .leftJoin(StoreCounter, eq(StoreCounter.id, OrderStore.counter))
          .where(eq(OrderStore.order, header.id))
          .orderBy(asc(OrderStore.id));
        // Role 1: every active store; others: user_stores (`order/views.py:355`).
        const allowed =
          user.role === 1
            ? (await tx.select({ id: Store.id }).from(Store).where(eq(Store.is_active, true))).map(
                (row) => String(row.id),
              )
            : (
                await tx
                  .select({ id: UserStore.store_id })
                  .from(UserStore)
                  .where(eq(UserStore.django_user_id, BigInt(user.id)))
              ).map((row) => String(row.id));
        const visible = crossAccess
          ? mappings
          : mappings.filter((row) => allowed.includes(String(row.storeId)));
        if (!visible.length) throw forbidden();
        const first = mappings[0]!;
        const checkIn = await checkedInStore(tx, user.id);
        const [customer] = await tx
          .select({
            id: MUser.id,
            firstName: MUser.firstname,
            lastName: MUser.lastname,
            email: MUser.email,
            telephone: MUser.telephone,
            money: MUser.tss_money,
            points: MUser.tss_points,
          })
          .from(MUser)
          .where(eq(MUser.id, header.userId))
          .limit(1);
        const [membership] = customer
          ? await tx
              .select({ value: ExclusiveUser.value, active: ExclusiveUser.is_active })
              .from(ExclusiveUser)
              .where(
                and(
                  eq(ExclusiveUser.entity, customer.email),
                  eq(ExclusiveUser.attribute, 'EXCLUSIVE_EXPIRY'),
                ),
              )
              .limit(1)
          : [];
        const [lines, terminals, paytms, gifts, vinculum, reasons, logs, placed] =
          await Promise.all([
            tx
              .select({
                id: HasProduct.id,
                productId: HasProduct.product,
                name: Product.product,
                quantity: HasProduct.qty,
                amount: HasProduct.price,
                gst: HasProduct.gst,
                status: HasProduct.status,
                productType: Product.prod_type,
                parentId: Product.parent_prod_id,
                erp: Product.erp_product,
                giftVoucherId: HasProduct.gift_voucher_id,
                returnStatus: HasProduct.return_status,
              })
              .from(HasProduct)
              .leftJoin(Product, eq(Product.id, HasProduct.product))
              .where(eq(HasProduct.order, header.id))
              .orderBy(asc(HasProduct.id)),
            tx
              .select({
                reference: PosTerminalTransaction.plutus_id,
                active: PosTerminalTransaction.is_active,
              })
              .from(PosTerminalTransaction)
              .where(
                and(
                  eq(PosTerminalTransaction.order_id, header.id),
                  eq(PosTerminalTransaction.platform, 'txn_created'),
                ),
              )
              .orderBy(asc(PosTerminalTransaction.id)),
            tx
              .select({
                reference: PosPaytmTransaction.paytm_mid,
                active: PosPaytmTransaction.is_active,
              })
              .from(PosPaytmTransaction)
              .where(
                and(
                  eq(PosPaytmTransaction.order_id, header.id),
                  eq(PosPaytmTransaction.platform, 'txn_created'),
                ),
              )
              .orderBy(asc(PosPaytmTransaction.id)),
            tx
              .select({ id: GiftVoucher.id, srno: GiftVoucher.gift_card_srno })
              .from(GiftVoucher)
              .where(eq(GiftVoucher.order_id, header.id))
              .orderBy(asc(GiftVoucher.id)),
            tx
              .select({
                platform: VinculumAutoDeliveredLog.platform,
                status: VinculumAutoDeliveredLog.status,
                updatedAt: VinculumAutoDeliveredLog.updated_at,
              })
              .from(VinculumAutoDeliveredLog)
              .where(eq(VinculumAutoDeliveredLog.order_id, header.id))
              .orderBy(asc(VinculumAutoDeliveredLog.id)),
            tx
              .select({ id: ReversePickupReason.id, reason: ReversePickupReason.reason })
              .from(ReversePickupReason)
              .orderBy(asc(ReversePickupReason.id)),
            tx
              .select({
                storeId: PosTransactionLog.store_id,
                orderStatus: OrderStatus.order_status,
                paymentStatus: PosTransactionLog.payment_status,
                comment: PosTransactionLog.comment,
                payments: PosTransactionLog.pay_dict,
                createdAt: PosTransactionLog.created_at,
              })
              .from(PosTransactionLog)
              .leftJoin(OrderStatus, eq(OrderStatus.id, PosTransactionLog.order_status))
              .where(eq(PosTransactionLog.order_id, header.id))
              .orderBy(asc(PosTransactionLog.id)),
            tx
              .select({ name: OrderStatus.order_status })
              .from(OrderStatus)
              .where(eq(OrderStatus.id, header.methodId === 14n ? 1n : 3n))
              .limit(1),
          ]);
        // ERP name of the parent product when the line is a child (`helpers.py:1394-1404`).
        const parents = [
          ...new Set(lines.filter((l) => (l.parentId ?? 0n) > 0n).map((l) => l.parentId!)),
        ];
        const parentErp = new Map(
          (parents.length
            ? await tx
                .select({ id: Product.id, erp: Product.erp_product })
                .from(Product)
                .where(inArray(Product.id, parents))
            : []
          ).map((row) => [String(row.id), row.erp]),
        );
        const activeTerminal = terminals.find((row) => Boolean(row.active)),
          activePaytm = paytms.find((row) => Boolean(row.active));
        const vincStatus = Object.fromEntries(
          vincPlatforms.map((platform) => [platform, { status: '-', date: '' }]),
        ) as StoreOrderLegacyContext['vincStatus'];
        for (const row of vinculum)
          if (row.platform && (vincPlatforms as readonly string[]).includes(row.platform))
            vincStatus[row.platform as (typeof vincPlatforms)[number]] = {
              status: row.status,
              date: row.updatedAt,
            };
        if (vincStatus.PACK.status === 'SUCCESS')
          vincStatus.CREATE = { status: 'SUCCESS', date: '' };
        const cash = header.methodId === 14n;
        const now = Temporal.Instant.fromEpochMilliseconds(clock())
          .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
          .toPlainDateTime();
        const exchange = exchangeEnabledStores();
        const statusLabel = (id: bigint | null, label: string | null) =>
          id === null ? null : { id: String(id), label: label || String(id) };
        return {
          id: String(header.id),
          reference: header.reference,
          amount: header.payAmount,
          orderAmount: header.orderAmount,
          createdAt: header.createdAt,
          status: header.statusDisplay,
          isPaid: header.paymentStatusId === 4n,
          reader: 'primary',
          fetchedAt: new Date(clock()).toISOString(),
          lines: lines.map((line) => {
            const parent = line.parentId ?? 0n;
            const erp = parent > 0n ? parentErp.get(String(parent)) : line.erp;
            return {
              id: String(line.id),
              productId: String(line.productId),
              name: line.name,
              erpProduct: erp || '-',
              quantity: String(line.quantity),
              amount: line.amount,
              gst: line.gst,
              status: line.status,
              productType: String(line.productType ?? 0n),
              parentProductId: String(parent),
              giftVoucherId: String(line.giftVoucherId),
              returnStatus: line.returnStatus,
            };
          }),
          legacy: {
            crossAccess,
            customer: customer
              ? {
                  id: String(customer.id),
                  firstName: customer.firstName,
                  lastName: customer.lastName,
                  email: customer.email,
                  telephone: customer.telephone,
                  tssMoney: detailWallet(customer.money),
                  tssPoints: detailWallet(customer.points),
                }
              : null,
            exclusive: legacyExclusive(membership, now),
            paymentStatus: statusLabel(header.paymentStatusId, header.paymentStatus),
            paymentMethod:
              header.methodId === null
                ? null
                : { id: String(header.methodId), name: header.method },
            orderStatus: statusLabel(header.statusId, header.status),
            // Helpers.get_store_location_name (`helpers/helpers.py:1407-1415`).
            storeName:
              first.counterId && first.counterId !== 0n
                ? `${first.storeName ?? ''} (${first.counterName ?? ''})`
                : (first.storeName ?? ''),
            isOfflineOrder: first.offline,
            isShopifyOrder: first.shopify,
            orderMessage: first.message,
            isManuallyPaid: first.manual,
            counterId: String(first.counterId ?? 0n),
            transactionId: legacyTransactionId({
              orderId: String(header.id),
              reference: header.reference,
              terminalInactiveCreated: terminals.filter((row) => !row.active).length,
              paytmInactiveCreated: paytms.filter((row) => !row.active).length,
              paytmActiveCreated: Boolean(activePaytm),
            }),
            isUploaded: Boolean(activeTerminal ?? activePaytm),
            plutusId: activeTerminal ? String(activeTerminal.reference) : '0',
            paytmMid: !activeTerminal && activePaytm ? String(activePaytm.reference) : '0',
            showMarkPaymentPopUp: header.paymentStatusId === 1n && header.statusId === 1n,
            totalItems: lines.reduce((sum, line) => sum + Number(line.quantity), 0),
            giftVouchers: gifts.map((row) => ({
              id: String(row.id),
              giftCardSrno: String(row.srno),
            })),
            vincStatus,
            // Legacy reads stores[0] of the check-in list and fails without a check-in; a
            // missing check-in counts as a non-franchise store here.
            isFranchiseeOrder: (first.franchise ?? 0) > 0 || (checkIn?.franchise ?? 0) > 0,
            isSuperAdmin: user.role === 1,
            isAtStore: Boolean(checkIn),
            checkedInStoreId: checkIn?.id ?? null,
            exchangeFeatureEnabled:
              exchange.all || Boolean(checkIn && exchange.ids.has(checkIn.id)),
            reasons: reasons.map((row) => ({ id: String(row.id), reason: row.reason })),
            // Helpers.get_transaction_log (`helpers/helpers.py:290-354`).
            transactionLog: [
              {
                storeId: String(first.storeId),
                // Helpers.get_order_status_name(1 or 3).
                orderStatus: placed[0]?.name ?? '',
                paymentStatus: cash ? 'Pending' : 'Paid',
                comment: `Order ${cash ? 'Placed' : 'Delivered'} on store using payment method : ${header.method ?? ''}`,
                createdAt: header.createdAt,
                payments: [
                  { method: 'tss money used', value: detailDecimal(header.moneyUsed) },
                  { method: 'tss points used', value: detailDecimal(header.pointsUsed) },
                  {
                    method: 'voucher amt used',
                    value: header.voucherUsed === null ? null : detailDecimal(header.voucherUsed),
                  },
                  { method: 'coupon amt used', value: detailDecimal(header.couponUsed) },
                  {
                    method: 'Payment gateway discount amt used',
                    value: header.pgDiscount === null ? null : detailDecimal(header.pgDiscount),
                  },
                  {
                    method: cash ? 'POC PAY AMT' : 'PAY AMT',
                    value: detailDecimal(header.payAmount),
                  },
                ],
              },
              ...logs.map((log) => ({
                storeId: String(log.storeId),
                orderStatus: log.orderStatus ?? '',
                paymentStatus: String(log.paymentStatus),
                comment: log.comment,
                createdAt: log.createdAt,
                payments: detailPaymentEntries(log.payments),
              })),
            ],
            cashback: null,
          },
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  };
}
