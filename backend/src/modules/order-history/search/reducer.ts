import { createHash } from 'node:crypto';
import { z } from 'zod';
import { positiveId, nonnegativeId, sourceDate, hash } from '../contracts.js';
import {
  comparableSourceTime,
  type OrderSearchInput,
  type SourceOrder,
  type SourceSearchScope,
} from './contracts.js';
import { sourceStoreSelection } from './native.js';
import { searchDataInvalid } from './format.js';
const text = z.string().max(255),
  weight = z
    .string()
    .max(8192)
    .regex(/^(?:[a-f0-9]{2})*$/),
  key = z.union([hash, z.literal('')]);
const terminal = z
  .object({
    inactiveCreated: z.number().int().nonnegative().safe(),
    activeCreated: z.object({ reference: text }).strict().nullable(),
    completedMode: z.number().int().nullable(),
  })
  .strict();
const store = z
  .object({
    id: positiveId,
    orderId: positiveId,
    storeId: positiveId,
    counterId: nonnegativeId,
    storeName: text.nullable(),
    counterName: text.nullable(),
    locationCode: text.nullable(),
    storeExists: z.boolean(),
    counterExists: z.boolean(),
    cash: z
      .string()
      .max(100)
      .refine((value) => Number.isFinite(Number(value))),
    onlineOther: z
      .string()
      .max(100)
      .refine((value) => Number.isFinite(Number(value))),
    manuallyPaid: z.boolean(),
    offline: z.boolean(),
    shopify: z.boolean(),
  })
  .strict();
export const sourceFactSchema = z
  .object({
    id: positiveId,
    reference: text,
    userId: nonnegativeId,
    customer: z.object({ id: nonnegativeId, first: text, last: text }).strict().nullable(),
    orderAmount: z.number().finite(),
    payAmount: z.number().finite(),
    createdAt: sourceDate,
    method: z.object({ id: positiveId, name: text.nullable() }).strict().nullable(),
    methodId: nonnegativeId.nullable(),
    paymentStatus: z.object({ id: positiveId, label: text }).strict().nullable(),
    paymentStatusId: nonnegativeId.nullable(),
    status: z.object({ id: positiveId, label: text }).strict().nullable(),
    statusId: nonnegativeId.nullable(),
    locationId: nonnegativeId.nullable(),
    locationType: text,
    locationStoreId: positiveId.nullable(),
    locationLabel: text.nullable(),
    transfer: z.boolean(),
    nextLocations: z.string().max(255),
    global: z.number().int(),
    stores: z.array(store).max(10000),
    expressStoreIds: z.array(positiveId).max(10000),
    terminal,
    paytm: terminal,
    isRevert: z.boolean(),
    phoneKey: key,
    userPhoneKey: key.nullable(),
    emailKey: key.nullable(),
    userFirstKey: weight.nullable(),
    methodKey: weight.nullable(),
    paymentKey: weight.nullable(),
  })
  .strict();
export const sourceIndexSchema = sourceFactSchema
  .pick({
    id: true,
    userId: true,
    orderAmount: true,
    createdAt: true,
    methodId: true,
    paymentStatusId: true,
    statusId: true,
    locationId: true,
    locationType: true,
    locationStoreId: true,
    transfer: true,
    nextLocations: true,
    phoneKey: true,
    userPhoneKey: true,
    emailKey: true,
    userFirstKey: true,
    methodKey: true,
    paymentKey: true,
  })
  .extend({
    customerPresent: z.boolean(),
    stores: z.array(store.pick({ id: true, storeId: true })).max(10000),
    expressStoreIds: z.array(positiveId).max(10000),
    factHash: hash,
  })
  .strict();
export type SourceIndex = z.infer<typeof sourceIndexSchema>;
export function sourceFactHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function sourceIndex(
  fact: SourceOrder,
  factHash = sourceFactHash(JSON.stringify(fact)),
): SourceIndex {
  return sourceIndexSchema.parse(parsedSourceIndex(fact, factHash));
}
export function parsedSourceIndex(fact: SourceOrder, factHash: string): SourceIndex {
  // Explicit projection avoids silent field stripping in the warehouse contract.
  return {
    id: fact.id,
    userId: fact.userId,
    orderAmount: fact.orderAmount,
    createdAt: fact.createdAt,
    methodId: fact.methodId,
    paymentStatusId: fact.paymentStatusId,
    statusId: fact.statusId,
    locationId: fact.locationId,
    locationType: fact.locationType,
    locationStoreId: fact.locationStoreId,
    transfer: fact.transfer,
    nextLocations: fact.nextLocations,
    phoneKey: fact.phoneKey,
    userPhoneKey: fact.userPhoneKey,
    emailKey: fact.emailKey,
    userFirstKey: fact.userFirstKey,
    methodKey: fact.methodKey,
    paymentKey: fact.paymentKey,
    customerPresent: fact.customer !== null,
    stores: fact.stores.map((row) => ({ id: row.id, storeId: row.storeId })),
    expressStoreIds: fact.expressStoreIds,
    factHash,
  };
}
export const compareIds = (left: string, right: string) =>
  BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
export function sourceScopeMatches(value: SourceIndex, scope: SourceSearchScope) {
  const stores = sourceStoreSelection(scope);
  if (scope.effectiveType === 'ST') return value.stores.some((row) => stores.includes(row.storeId));
  if (scope.effectiveType === 'HE') return value.expressStoreIds.some((id) => stores.includes(id));
  if (scope.effectiveType === 'N')
    return scope.globalReader && !value.stores.length && value.locationId === null;
  return (
    !value.stores.length &&
    value.locationId !== null &&
    ((scope.internal && scope.explicitIds) ||
      (value.locationStoreId !== null && stores.includes(value.locationStoreId))) &&
    (scope.explicitIds || value.locationId === scope.checkedInStoreId)
  );
}
function compareNullable(left: string | null, right: string | null, numeric = false) {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return numeric ? compareIds(left, right) : left < right ? -1 : 1;
}
export interface ContactSelection {
  orderPhone: string;
  userPhone: string;
  email: string;
}
export function sourceSelect(
  indexes: readonly SourceIndex[],
  scope: SourceSearchScope,
  input: OrderSearchInput,
  contacts: ContactSelection,
  queueIds?: ReadonlySet<string>,
) {
  let selected = indexes.filter(
    (value) =>
      (queueIds ? queueIds.has(value.id) : sourceScopeMatches(value, scope)) &&
      value.statusId !== '0' &&
      (!scope.explicitIds || !input.orderIds.length || input.orderIds.includes(value.id)) &&
      (!(input.inQueue || input.notPacked) && input.placedFrom
        ? comparableSourceTime(value.createdAt) >= comparableSourceTime(input.placedFrom)
        : true) &&
      (!(input.inQueue || input.notPacked) && input.placedTo
        ? comparableSourceTime(value.createdAt) <= comparableSourceTime(input.placedTo)
        : true) &&
      (!input.paymentMethodIds.length ||
        (value.methodId !== null && input.paymentMethodIds.includes(value.methodId))) &&
      (!input.paymentStatusIds.length ||
        (value.paymentStatusId !== null &&
          input.paymentStatusIds.includes(value.paymentStatusId))) &&
      (!input.orderStatusIds.length ||
        (value.statusId !== null && input.orderStatusIds.includes(value.statusId))),
  );
  if (input.mobile) {
    const direct = selected.some((value) => value.phoneKey === contacts.orderPhone);
    selected = selected.filter(
      (value) =>
        (direct ? value.phoneKey : value.userPhoneKey) ===
        (direct ? contacts.orderPhone : contacts.userPhone),
    );
  }
  if (input.email) selected = selected.filter((value) => value.emailKey === contacts.email);
  if (input.search)
    selected = selected.filter(
      (value) => value.id.includes(input.search) || value.userId.includes(input.search),
    );
  const expansion = (value: SourceIndex) =>
    scope.effectiveType === 'ST'
      ? BigInt(value.stores.length) *
        BigInt(
          scope.explicitIds
            ? 1
            : value.stores.filter((row) => scope.selectedStores.includes(row.storeId)).length,
        )
      : 1n;
  const count = selected.reduce((sum, row) => sum + expansion(row), 0n).toString(),
    page = BigInt(input.page - 1) * BigInt(input.pageSize) >= BigInt(count) ? 1 : input.page,
    sign = input.sort.direction === 'asc' ? 1 : -1;
  function primary(a: SourceIndex, b: SourceIndex) {
    switch (input.sort.field) {
      case 'id':
        return compareIds(a.id, b.id);
      case 'user_id':
        return compareIds(a.userId, b.userId);
      case 'user__firstname':
        return compareNullable(a.userFirstKey, b.userFirstKey);
      case 'payment_statuses__payment_status':
        return compareNullable(a.paymentKey, b.paymentKey);
      case 'payment_methods__name':
        return compareNullable(a.methodKey, b.methodKey);
      case 'order_statuses':
        return compareNullable(a.statusId, b.statusId, true);
      case 'order_amt':
        return a.orderAmount - b.orderAmount;
      case 'created_at':
        return comparableSourceTime(a.createdAt) < comparableSourceTime(b.createdAt)
          ? -1
          : comparableSourceTime(a.createdAt) > comparableSourceTime(b.createdAt)
            ? 1
            : 0;
    }
  }
  selected.sort((a, b) => sign * primary(a, b) || compareIds(a.id, b.id));
  if (input.sort.field === 'user__firstname')
    selected = selected.filter((row) => row.customerPresent);
  let skip = BigInt(page - 1) * BigInt(input.pageSize);
  const rows: { index: SourceIndex; rowKey: string; any: string; matched: string }[] = [];
  for (const index of selected) {
    const size = expansion(index);
    if (skip >= size) {
      skip -= size;
      continue;
    }
    if (scope.effectiveType !== 'ST') {
      rows.push({ index, rowKey: `${index.id}:0:0`, any: '0', matched: '0' });
    } else {
      const ordered = [...index.stores].sort((a, b) => compareIds(a.id, b.id)),
        matched = scope.explicitIds
          ? [{ id: '0' }]
          : ordered.filter((row) => scope.selectedStores.includes(row.storeId));
      const width = BigInt(matched.length);
      if (!width) continue;
      let position = skip;
      while (position < size && rows.length < input.pageSize) {
        const a = ordered[Number(position / width)]!,
          b = matched[Number(position % width)]!;
        rows.push({ index, rowKey: `${index.id}:${a.id}:${b.id}`, any: a.id, matched: b.id });
        position++;
      }
    }
    skip = 0n;
    if (rows.length === input.pageSize) break;
  }
  return { count, page, rows };
}
export function assertFact(value: SourceOrder) {
  const parsed = sourceFactSchema.safeParse(value);
  if (!parsed.success) throw searchDataInvalid();
  for (const [raw, related] of [
    [value.methodId, value.method],
    [value.paymentStatusId, value.paymentStatus],
    [value.statusId, value.status],
  ] as const)
    if (
      (raw !== null && raw !== '0' && related?.id !== raw) ||
      ((raw === null || raw === '0') && related !== null)
    )
      throw searchDataInvalid();
  if (
    (value.customer && value.customer.id !== value.userId) ||
    new Set(value.stores.map((row) => row.id)).size !== value.stores.length ||
    value.stores.some((row) => row.orderId !== value.id) ||
    new Set(value.expressStoreIds).size !== value.expressStoreIds.length
  )
    throw searchDataInvalid();
  return value;
}
