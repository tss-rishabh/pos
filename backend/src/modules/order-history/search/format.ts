import { AppError } from '../../../domain/errors.js';
import type { SourceOrder, SourceOrderRow, SourceSearchScope, SourceStore } from './contracts.js';
export const searchDataInvalid = () =>
  new AppError(
    503,
    'ORDER_SEARCH_DATA_INVALID',
    'Some order-list evidence requires reconciliation before it can be shown.',
  );
const numeric = (left: string, right: string) =>
  BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
export function sourceTransactionId(fact: SourceOrder) {
  const count =
    (fact.terminal.inactiveCreated ? fact.terminal.inactiveCreated + 1 : 0) +
    (fact.paytm.inactiveCreated ? fact.paytm.inactiveCreated + 1 : 0);
  let reference = fact.reference;
  if (fact.paytm.activeCreated) {
    // Legacy Helpers.get_transaction_id (helpers.py:730) calls order_ref_no.replace()
    // here, which raises for NULL and fails the datatable request.
    if (reference === null) throw searchDataInvalid();
    reference = reference.replaceAll('-', '');
  }
  if (count) {
    const suffix = fact.paytm.activeCreated ? String(count) : '-' + count;
    return (reference || fact.id) + suffix;
  }
  const result = reference || fact.id;
  return result.replaceAll('-', '').length >= 8 ? result : fact.id;
}
export function sourceMethodName(
  fact: SourceOrder,
  type: SourceSearchScope['effectiveType'],
  store: SourceStore | undefined,
) {
  const method = fact.method?.name ?? (fact.method ? null : '');
  if (type !== 'ST') return method;
  let cash = '',
    other = '',
    online = '';
  if (store && Number(store.cash) > 0) cash = 'CASH';
  if (store && Number(store.onlineOther) > 0) {
    if (Number(store.cash) > 0) cash += ' +';
    other = 'Online (Other)';
  }
  if (fact.terminal.completedMode !== null) {
    if (cash) online = '+';
    online += fact.terminal.completedMode === 10 ? 'UPI' : 'CARD';
  } else if (fact.paytm.completedMode !== null) {
    if (cash) online = '+';
    online += fact.paytm.completedMode === 1004 ? 'UPI' : 'CARD';
  }
  if (cash || online || other)
    return `${method === null ? 'None' : method}: ${cash} ${other} ${online}`;
  if (!fact.method) throw searchDataInvalid();
  if (['3', '16'].includes(fact.method.id)) return method;
  if (method === null) throw searchDataInvalid();
  return method + ' (Pending)';
}
export function formatSourceOrder(
  fact: SourceOrder,
  scope: SourceSearchScope,
  rowKey: string,
): SourceOrderRow {
  const stores = [...fact.stores].sort((a, b) => numeric(a.id, b.id));
  // The source takes the first global association. Scope it for non-global
  // viewers so a split order cannot substitute another store's counter/action.
  const first = stores.find(
    (store) => scope.internal || scope.allowedStores.includes(store.storeId),
  );
  if (first && (!first.storeExists || (first.counterId !== '0' && !first.counterExists)))
    throw searchDataInvalid();
  let storeName = first ? first.storeName : '';
  if (first && first.counterId !== '0')
    storeName = `${storeName === null ? 'None' : storeName} (${first.counterName === null ? 'None' : first.counterName})`;
  let location: string | null =
    fact.locationId && fact.locationId !== '0' && ['SW', 'NW'].includes(fact.locationType)
      ? fact.locationLabel
      : 'Unknown';
  if (fact.locationId !== (scope.checkedInStoreId ?? '0'))
    location = 'Transferred from ' + (location === null ? 'None' : location);
  if (scope.effectiveType === 'HE') {
    // This selected-store label is the exact source HE presentation rule.
    location = scope.heLocationLabel;
  }
  const uploaded = fact.terminal.activeCreated ?? fact.paytm.activeCreated;
  return {
    rowKey,
    id: fact.id,
    user_id: fact.customer?.id ?? '0',
    user__firstname: fact.customer ? `${fact.customer.first} ${fact.customer.last}` : 'Not defined',
    payment_statuses__payment_status: fact.paymentStatus?.label ?? '',
    payment_methods__name: sourceMethodName(fact, scope.effectiveType, first),
    payment_methods__id: fact.method?.id ?? '0',
    order_amt: fact.orderAmount,
    order_statuses: fact.status?.label ?? '',
    created_at: fact.createdAt.slice(0, 19),
    store_name: storeName,
    counter_id: first?.counterId ?? '0',
    location_code: location,
    is_manually_paid: first?.manuallyPaid ?? true,
    is_offline_order: first?.offline ?? false,
    is_shopify_order: first?.shopify ?? false,
    is_uploaded: uploaded ? 1 : 0,
    transaction_id: sourceTransactionId(fact),
    plutus_id: fact.terminal.activeCreated?.reference ?? '0',
    paytm_mid: fact.terminal.activeCreated ? '0' : (fact.paytm.activeCreated?.reference ?? '0'),
    pay_amount: fact.payAmount,
    is_revert: fact.isRevert,
    DT_RowId: fact.id,
    is_global_order: fact.global,
    actionStoreId:
      first?.storeId ??
      (scope.effectiveType === 'HE'
        ? (scope.selectedStores[0] ?? scope.checkedInStoreId)
        : scope.effectiveType === 'HL'
          ? scope.checkedInStoreId
          : scope.effectiveType === 'N'
            ? scope.contextStoreId
            : null),
  };
}
