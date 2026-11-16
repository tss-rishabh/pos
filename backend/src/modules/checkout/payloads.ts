import type { CartContext } from '../upstream.js';
import { AppError } from '../../domain/errors.js';
import { minorUnits } from '../../domain/money.js';

export type Payload = Record<string, unknown>;
export function wireId(value: string): number | bigint {
  if (!/^\d+$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n)
    throw new AppError(
      422,
      'UPSTREAM_IDENTIFIER_RANGE',
      'This identifier cannot be represented by the current checkout API.',
    );
  const integer = BigInt(value);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
}
export const cartScope = (context: CartContext) => ({
  is_pos: true,
  store_id: context.storeId,
  ...(!context.endUser ? { tab_id: context.tabId } : {}),
});
export const readCartPayload = (context: CartContext, customData: Payload | null = null) => ({
  ...cartScope(context),
  payload: { operation: 'get' },
  custom_data: customData,
});
export const clearCartPayload = (context: CartContext, cart: Payload) => ({
  ...cartScope(context),
  payload: { operation: 'clear' },
  localcart: cart,
});
export const walletPayload = (
  context: CartContext,
  cart: Payload,
  money: boolean,
  points: boolean,
  appliedMoney: string,
  custom: boolean,
) => ({
  ...cartScope(context),
  localcart: cart || {},
  state: money,
  tss_points_status: points,
  applied_money: Number(appliedMoney),
  custom_tss_money: custom ? 1 : 0,
});
export const pgDiscountPayload = (
  context: CartContext,
  cart: Payload,
  discount: string,
  apply: boolean,
) => ({
  ...cartScope(context),
  localcart: cart || {},
  pg_discount: Number(discount),
  apply: apply ? 1 : 0,
});
export const storeDiscountPayload = (
  context: CartContext,
  cart: Payload,
  discount: string,
  apply: boolean,
) => ({
  ...cartScope(context),
  localcart: cart || {},
  store_discount_pg: Number(discount),
  apply: apply ? 1 : 0,
});
export const couponPayload = (context: CartContext, cart: Payload, coupon: string) => ({
  ...cartScope(context),
  coupon,
  localcart: cart,
});
export const removeBenefitPayload = (
  context: CartContext,
  kind: 'coupon' | 'gift-voucher',
  cart: Payload,
) => ({
  ...cartScope(context),
  payload: {
    operation: 'delete',
    type: 'meta',
    data: { name: kind === 'coupon' ? 'coupon' : 'gift_voucher' },
    ...(kind === 'coupon' ? { localcart: cart } : {}),
  },
});
export const giftVoucherPayload = (context: CartContext, code: string, pin: string) => ({
  ...cartScope(context),
  voucher_code: code,
  gc_pin: pin.replaceAll('_', ''),
});
export const exclusivePayload = (context: CartContext, enabled: boolean) => ({
  ...cartScope(context),
  payload: { operation: 'get' },
  store_exclusive: { operation: enabled ? 'add' : 'remove' },
});
export const syncCartPayload = (context: CartContext, token: string, cart: Payload) => ({
  token,
  localcart: {},
  pos_localcart: cart,
  is_pos: true,
  store_id: context.storeId,
});
export function orderPayload(
  context: CartContext,
  counterId: string,
  adminCustomerId: string,
  salespersonId: string | null,
  total: string,
  giftCards: Payload = {},
  customData: Payload | null = null,
  createdAt: string | null = null,
) {
  return {
    ...cartScope(context),
    payment_method: minorUnits(total) > 0n ? 'coc' : 'prepaid',
    counter_id: wireId(counterId),
    salesperson_id: salespersonId ? wireId(salespersonId) : 0,
    admin_user_id: wireId(adminCustomerId),
    custom_data: customData,
    custom_created_at: createdAt,
    gc_data: giftCards,
  };
}
export const confirmationPayload = (
  order: unknown,
  method: unknown,
  isValid: unknown,
  name: unknown,
  storeId: number | bigint,
) => ({ order, method, isValid, name, is_pos: true, store_id: storeId });
export function returnAmountPayload(
  customerId: string,
  orderId: string,
  productId: string,
  lineId: string,
  toWallet: boolean,
  superAdmin: boolean,
) {
  return {
    user_id: wireId(customerId),
    order_id: wireId(orderId),
    prod_id: wireId(productId),
    has_prod_id: wireId(lineId),
    is_pay_amt_in_tss_money: toWallet,
    is_super_admin: superAdmin ? 1 : 0,
  };
}
export function exchangePayload(input: {
  orderId: string;
  lineId: string;
  oldProductId: string;
  newProductId: string;
  parentId: string;
  size: string;
  storeId: string;
  counterId: string;
  saleable: boolean;
  reasonId: string;
  subReasonId: string | null;
  comment: string;
  adminCustomerId: string;
  salespersonId: string;
}) {
  return {
    order_id: wireId(input.orderId),
    has_prod_id: wireId(input.lineId),
    prod_id: wireId(input.oldProductId),
    exchange_prod_id: wireId(input.newProductId),
    exchange_parent_prod_id: wireId(input.parentId),
    size: input.size,
    store_id: wireId(input.storeId),
    counter_id: wireId(input.counterId),
    saleable: input.saleable,
    reason_id: wireId(input.reasonId),
    sub_reason_id: input.subReasonId ? wireId(input.subReasonId) : 0,
    comment: input.comment,
    admin_user_id: wireId(input.adminCustomerId),
    salesperson_id: wireId(input.salespersonId),
  };
}
export interface PineMachine {
  merchantId: string;
  securityToken: string;
  clientId: string;
  storePosCode: string;
}
export const pineUploadPayload = (
  machine: PineMachine,
  transactionId: string,
  amount: string,
  paymentMode: number,
  operatorId: string,
  autoCancelMinutes: number,
) => ({
  TransactionNumber: transactionId,
  SequenceNumber: 1,
  AllowedPaymentMode: paymentMode,
  StoreId: machine.storePosCode,
  Amount: wireId(minorUnits(amount).toString()),
  UserID: wireId(operatorId),
  MerchantID: machine.merchantId,
  SecurityToken: machine.securityToken,
  ClientID: machine.clientId,
  AutoCancelDurationInMinutes: autoCancelMinutes,
});
export const pineStatusPayload = (machine: PineMachine, reference: string) => ({
  MerchantID: machine.merchantId,
  SecurityToken: machine.securityToken,
  ClientID: machine.clientId,
  StoreID: machine.storePosCode,
  PlutusTransactionReferenceID: reference,
});
export const pineCancelPayload = (
  machine: PineMachine,
  reference: string,
  amount: string,
  force: boolean,
) => ({
  MerchantID: machine.merchantId,
  SecurityToken: machine.securityToken,
  ClientId: machine.clientId,
  StoreId: machine.storePosCode,
  PlutusTransactionReferenceID: reference,
  Amount: wireId(minorUnits(amount).toString()),
  ...(force ? { TakeToHomeScreen: true } : {}),
});
