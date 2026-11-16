import { Decimal } from 'decimal.js';
import { sql, type SQL } from 'drizzle-orm';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import { AppError } from '../../../domain/errors.js';
import { boundedJson } from '../../../domain/http-json.js';
import { currentRequestTrace } from '../../../observability/context.js';
import {
  cashHash,
  cashIdentifier,
  type CashAuthorization,
  type CashPriceSnapshot,
  type CashReceipt,
} from './contracts.js';
import { cashPhysicalColumns } from './legacy-import-schema.js';
import { refundAllocationContract, refundSourcePatchHash } from '../refund-allocation.js';

const columns = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]*$/),
    z.union([z.string().max(65535), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 150);
const decimalValue = z.string().regex(/^\d{1,32}(?:\.\d{1,24})?$/);
export const cashRefundAllocationSchema = z
  .object({
    lineIndex: z.number().int().min(0).max(999),
    amountToBeRefunded: decimalValue,
    tssPointsUsed: decimalValue,
    tssMoneyUsed: decimalValue,
    giftVoucherAmount: decimalValue,
    couponAmountUsed: decimalValue,
    storeDiscountPg: decimalValue,
  })
  .strict();
export const cashSourceTemplateSchema = z
  .object({
    contract: z.literal('pos-offline-cash-template-v1'),
    sourceCommit: z.literal('2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
    receiptId: z.uuid(),
    receiptHash: cashHash,
    operatorCustomerId: cashIdentifier,
    storeId: cashIdentifier,
    counterId: cashIdentifier,
    businessDate: z.iso.date(),
    lineItemsEnabled: z.boolean(),
    header: columns,
    orderStore: columns,
    lines: z.array(columns).min(1).max(1000),
    refundAllocations: z.array(cashRefundAllocationSchema).min(1).max(1000),
    cancellationMessageId: z.literal('1'),
    refundAllocationContract: z.literal(refundAllocationContract),
    refundSourcePatchHash: z.literal(refundSourcePatchHash),
    flagIds: z
      .array(z.union([z.literal(4), z.literal(13), z.literal(19)]))
      .min(1)
      .max(3)
      .refine((ids) => ids.includes(19) && new Set(ids).size === ids.length),
  })
  .strict();
export type CashSourceTemplate = z.infer<typeof cashSourceTemplateSchema>;
export type CashTemplateColumns = z.infer<typeof columns>;
export type CashTemplateSource = (
  receiptId: string,
  operatorId: string,
) => Promise<CashSourceTemplate>;
const invalid = () =>
  new AppError(
    503,
    'OFFLINE_CASH_TEMPLATE_INVALID',
    'The source-authorized order projection could not be verified. The original cash receipt is preserved.',
  );
const numberString = /^-?\d{1,32}(?:\.\d{1,24})?$/;
export function templateDecimal(value: unknown): Decimal {
  if (typeof value !== 'string' || !numberString.test(value)) throw invalid();
  const result = new Decimal(value);
  if (!result.isFinite()) throw invalid();
  return result;
}

export function cashSourceTemplate(
  config: Pick<Config, 'NODE_ENV'>,
  environment: { url?: string; key?: string; contract?: string },
  fetcher: typeof fetch = fetch,
): CashTemplateSource {
  return async (receiptId, operatorId) => {
    if (
      !environment.url ||
      !environment.key ||
      !/^[\x21-\x7e]{32,4096}$/.test(environment.key) ||
      environment.contract !== 'pos-offline-cash-template-v1'
    )
      throw new AppError(
        503,
        'OFFLINE_CASH_IMPORT_NOT_CONFIGURED',
        'The source order import contract must be configured before reconciling a cash receipt.',
      );
    const url = new URL(environment.url);
    if (
      (url.protocol !== 'https:' &&
        !(
          config.NODE_ENV === 'test' &&
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(url.hostname)
        )) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new AppError(
        503,
        'OFFLINE_CASH_IMPORT_NOT_CONFIGURED',
        'The private order import endpoint requires an approved secure URL.',
      );
    try {
      const response = await fetcher(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-POS-Offline-Key': environment.key,
          'X-POS-Operator-ID': operatorId,
          'X-Request-ID': currentRequestTrace()?.requestId || crypto.randomUUID(),
        },
        body: JSON.stringify({ receiptId }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw invalid();
      }
      const result = cashSourceTemplateSchema.parse(await boundedJson(response, 2_000_000));
      if (result.receiptId !== receiptId) throw invalid();
      return result;
    } catch {
      throw new AppError(
        503,
        'OFFLINE_CASH_TEMPLATE_UNAVAILABLE',
        'The source-authorized order projection is unavailable. No authoritative order was created. Keep the original cash receipt.',
      );
    }
  };
}

export function assertCashSourceTemplate(
  template: CashSourceTemplate,
  scope: {
    receiptHash: string;
    receipt: CashReceipt;
    authorization: CashAuthorization;
    snapshot: CashPriceSnapshot;
    orderCreatedAt: string;
  },
) {
  const { receipt, authorization, snapshot } = scope;
  if (
    template.receiptId !== receipt.id ||
    template.receiptHash !== scope.receiptHash ||
    template.operatorCustomerId !== authorization.operatorCustomerId ||
    template.storeId !== receipt.storeId ||
    template.counterId !== receipt.counterId ||
    template.businessDate !== receipt.businessDate ||
    template.lineItemsEnabled !== snapshot.lineItemsEnabled ||
    template.header.created_at !== scope.orderCreatedAt ||
    template.header.updated_at !== scope.orderCreatedAt ||
    template.header.user_id !== authorization.operatorCustomerId ||
    template.header.payment_method !== '14' ||
    template.header.order_status !== '0' ||
    template.header.payment_status !== '0' ||
    template.orderStore.order_id !== '0' ||
    template.orderStore.store_id !== receipt.storeId ||
    template.orderStore.counter_id !== receipt.counterId ||
    template.orderStore.admin_user_id !== receipt.operatorId ||
    !['1', true].includes(template.orderStore.is_offline_order ?? '')
  )
    throw invalid();
  if (!templateDecimal(template.header.pay_amt).times(100).eq(receipt.payableCents))
    throw invalid();
  for (const field of [
    'cashback_used',
    'tss_money_used',
    'tss_points_used',
    'voucher_used',
    'voucher_amt_used',
    'coupon_used',
    'coupon_amt_used',
    'cod_charges',
    'gifting_charges',
    'shipping_amt',
    'hl_charges',
    'parent_order_id',
    'original_order_id',
    'hl_parent_order_id',
    'store_disc_pg',
    'cashback_earned',
    'cashback_credited',
    'is_parent_express',
    'express_charges',
  ])
    if (!templateDecimal(template.header[field]).isZero()) throw invalid();
  if (template.header.is_express !== false && template.header.is_express !== '0') throw invalid();
  if (
    template.header.location_id !== null &&
    !templateDecimal(template.header.location_id).isZero()
  )
    throw invalid();
  if (
    template.header.flag_id !== '19' ||
    template.header.is_new_calculation !== '3' ||
    !templateDecimal(template.header.fraction_value).times(100).eq(receipt.roundingCents) ||
    !templateDecimal(template.header.order_amt)
      .times(100)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN)
      .eq(receipt.lines.reduce((total, line) => total + line.mainSubtotalCents, 0))
  )
    throw invalid();
  const expected = new Map(receipt.lines.map((line) => [line.productId, line]));
  const actual = new Map<
    string,
    { quantity: number; count: number; subtotal: Decimal; taxable: Decimal; payable: Decimal }
  >();
  for (const line of template.lines) {
    const productId = cashIdentifier.parse(line.prod_id),
      price = expected.get(productId),
      quantity = templateDecimal(line.qty).toNumber();
    if (
      !price ||
      line.order_id !== '0' ||
      line.sub_prod_id !== '0' ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 99 ||
      (snapshot.lineItemsEnabled && quantity !== 1) ||
      line.created_at !== scope.orderCreatedAt ||
      line.updated_at !== scope.orderCreatedAt ||
      !templateDecimal(line.gst).eq(price.invoiceGst) ||
      !['REGULAR', 'JIT', 'PRE_ORDER', 'MTO'].includes(String(line.type))
    )
      throw invalid();
    if (
      Number(line.price) !==
      Number(price.unitPrice) * (snapshot.lineItemsEnabled ? 1 : price.quantity)
    )
      throw invalid();
    for (const field of [
      'disc',
      'wallet_disc',
      'voucher_disc',
      'hp_tss_points_used',
      'store_disc_pg',
      'cashback_earned',
      'exclusive_saving',
    ])
      if (!templateDecimal(line[field]).isZero()) throw invalid();
    const current = actual.get(productId) || {
      quantity: 0,
      count: 0,
      subtotal: new Decimal(0),
      taxable: new Decimal(0),
      payable: new Decimal(0),
    };
    current.quantity += quantity;
    current.count++;
    current.subtotal = current.subtotal.plus(templateDecimal(line.price));
    current.taxable = current.taxable.plus(templateDecimal(line.pre_gst_amt));
    current.payable = current.payable.plus(templateDecimal(line.final_payable));
    actual.set(productId, current);
  }
  if (actual.size !== expected.size) throw invalid();
  for (const [id, line] of expected) {
    const value = actual.get(id);
    if (
      !value ||
      value.quantity !== line.quantity ||
      value.count !== (snapshot.lineItemsEnabled ? line.quantity : 1) ||
      !value.subtotal
        .times(100)
        .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN)
        .eq(line.mainSubtotalCents) ||
      !value.taxable.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).eq(line.taxableCents) ||
      !value.payable
        .times(100)
        .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN)
        .eq(line.mainSubtotalCents)
    )
      throw invalid();
  }
  if (
    template.refundAllocations.length !== template.lines.length ||
    new Set(template.refundAllocations.map((allocation) => allocation.lineIndex)).size !==
      template.lines.length
  )
    throw invalid();
  let refunded = new Decimal(0);
  for (const allocation of template.refundAllocations) {
    const line = template.lines[allocation.lineIndex];
    if (
      !line ||
      !templateDecimal(line.amount_to_be_refunded).eq(allocation.amountToBeRefunded) ||
      !templateDecimal(line.fraction_value).isZero() ||
      !templateDecimal(allocation.amountToBeRefunded).times(100).isInteger()
    )
      throw invalid();
    for (const field of [
      'tssPointsUsed',
      'tssMoneyUsed',
      'giftVoucherAmount',
      'couponAmountUsed',
      'storeDiscountPg',
    ] as const)
      if (!templateDecimal(allocation[field]).isZero()) throw invalid();
    refunded = refunded.plus(allocation.amountToBeRefunded);
  }
  if (!refunded.times(100).eq(receipt.payableCents)) throw invalid();
}

type PhysicalColumn = {
  name: string;
  type: string;
  nullable: boolean;
  extra: string;
  default?: string | number | null;
  collation?: string | null;
};
type SourceInsert<T extends MySqlTable> = { [K in keyof T['$inferInsert']]: SQL };
/** Complete physical-column validation is the sole cast boundary; values remain bound SQL parameters. */
export function mapCashSourceRow<T extends MySqlTable>(
  table: T,
  supplied: CashTemplateColumns,
): SourceInsert<T> {
  const name = getTableConfig(table).name;
  if (!Object.hasOwn(cashPhysicalColumns, name)) throw invalid();
  const metadata: Record<string, PhysicalColumn> =
    cashPhysicalColumns[name as keyof typeof cashPhysicalColumns];
  const result: Record<string, SQL> = {};
  for (const key of Object.keys(supplied))
    if (!Object.hasOwn(metadata, key) || metadata[key]!.extra.includes('auto_increment'))
      throw invalid();
  for (const [key, column] of Object.entries(metadata)) {
    if (column.extra.includes('auto_increment')) continue;
    if (!Object.hasOwn(supplied, key)) {
      if (!column.nullable && column.default === null) throw invalid();
      continue;
    }
    let value: string | boolean | null = supplied[key] ?? null;
    // Reviewed source sentinel compatibility; financial values never enter this branch.
    if (
      name === 'orders' &&
      ['ship_date', 'ret_ex_request_date', 'pg_disc_platform'].includes(key) &&
      value === ''
    )
      value = null;
    if (name === 'orders' && key === 'courier' && value === '') value = '0';
    if (value === null) {
      if (!column.nullable) throw invalid();
      result[key] = sql`${null}`;
      continue;
    }
    if (typeof value === 'boolean') value = value ? '1' : '0';
    const kind = column.type;
    if (/^(bigint|int|tinyint)/.test(kind)) {
      if (!/^-?\d{1,20}$/.test(value)) throw invalid();
      const number = BigInt(value),
        bits = kind.startsWith('bigint') ? 64n : kind.startsWith('tinyint') ? 8n : 32n;
      if (number < -(1n << (bits - 1n)) || number > (1n << (bits - 1n)) - 1n) throw invalid();
    } else if (/^(double|float|decimal)/.test(kind)) {
      const number = templateDecimal(value);
      if (!Number.isFinite(number.toNumber())) throw invalid();
      const decimal = /^decimal\((\d+),(\d+)\)$/.exec(kind);
      if (
        decimal &&
        number
          .toDecimalPlaces(Number(decimal[2]), Decimal.ROUND_HALF_UP)
          .abs()
          .gte(new Decimal(10).pow(Number(decimal[1]) - Number(decimal[2])))
      )
        throw invalid();
    } else if (kind === 'datetime') {
      try {
        if (
          !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ||
          Number(value.slice(0, 4)) < 1000
        )
          throw invalid();
        Temporal.PlainDateTime.from(value.replace(' ', 'T'));
      } catch {
        throw invalid();
      }
    } else if (kind.startsWith('enum(')) {
      const allowed = [...kind.matchAll(/'([^']*)'/g)].map((match) => match[1]);
      if (!allowed.includes(value)) throw invalid();
    } else {
      const varchar = /^varchar\((\d+)\)$/.exec(kind);
      if (
        (varchar && [...value].length > Number(varchar[1])) ||
        (!varchar && Buffer.byteLength(value) > 65535)
      )
        throw invalid();
    }
    if (
      column.collation?.startsWith('latin1_') &&
      [...value].some((character) => character.codePointAt(0)! > 255)
    )
      throw invalid();
    result[key] = sql`${value}`;
  }
  return result as SourceInsert<T>;
}
