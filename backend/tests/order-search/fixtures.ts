import type {
  SourceOrder,
  SourceSearchScope,
} from '../../src/modules/order-history/search/contracts.js';
import { readOrderSearchOptions } from '../../src/modules/order-history/search/options.js';
import { sourceSearchContract } from '../../src/modules/order-history/search/contracts.js';
import { sourceIndex, sourceFactHash } from '../../src/modules/order-history/search/reducer.js';
import {
  searchIndexRowsHash,
  type SearchPublication,
} from '../../src/modules/order-history/search/warehouse.js';
export { now, config, generation } from '../order-history/fixtures.js';
import { now, generation } from '../order-history/fixtures.js';
export const options = readOrderSearchOptions({
  ORDER_SEARCH_CONTRACT: sourceSearchContract,
  BQ_ORDER_SEARCH_INDEX_VIEW: 'tssgcp2025.tss_mysql_raw_layer.pos_order_search_index_v1',
  BQ_ORDER_SEARCH_FACTS_VIEW: 'tssgcp2025.tss_mysql_raw_layer.pos_order_search_facts_v1',
  BQ_ORDER_SEARCH_PUBLICATIONS_VIEW:
    'tssgcp2025.tss_mysql_raw_layer.pos_order_search_publications_v1',
  ORDER_SEARCH_CONTACT_KEY: 'synthetic-contact-key-'.repeat(3),
  ORDER_SEARCH_CONTACT_KEY_ID: 'synthetic-key-001',
});
export const scope: SourceSearchScope = {
  contextStoreId: '1',
  checkedInStoreId: '1',
  allowedStores: ['1'],
  internal: false,
  globalReader: true,
  binding: 'synthetic',
  effectiveType: 'ST',
  selectedStores: ['1'],
  explicitIds: false,
  heLocationLabel: null,
};
export const fact: SourceOrder = {
  id: '9007199254740993',
  reference: 'SYNTHETIC',
  userId: '7',
  customer: { id: '7', first: 'Synthetic', last: 'Customer' },
  orderAmount: 120.5,
  payAmount: 100,
  createdAt: '2026-11-16 10:00:00',
  method: { id: '14', name: 'Cash' },
  methodId: '14',
  paymentStatus: { id: '4', label: 'Paid' },
  paymentStatusId: '4',
  status: { id: '3', label: 'Delivered' },
  statusId: '3',
  locationId: null,
  locationType: '',
  locationStoreId: null,
  locationLabel: null,
  transfer: false,
  nextLocations: '',
  global: 0,
  stores: [
    {
      id: '11',
      orderId: '9007199254740993',
      storeId: '1',
      counterId: '1',
      storeName: 'Synthetic store',
      counterName: 'Counter',
      locationCode: 'SYN',
      storeExists: true,
      counterExists: true,
      cash: '100.00',
      onlineOther: '0.00',
      manuallyPaid: true,
      offline: false,
      shopify: false,
    },
  ],
  expressStoreIds: [],
  terminal: { inactiveCreated: 0, activeCreated: null, completedMode: null },
  paytm: { inactiveCreated: 0, activeCreated: null, completedMode: null },
  isRevert: true,
  phoneKey: 'a'.repeat(64),
  userPhoneKey: 'b'.repeat(64),
  emailKey: 'c'.repeat(64),
  userFirstKey: '6162',
  methodKey: '6162',
  paymentKey: '6364',
};
export function fixtures(value: SourceOrder = fact, key = 'store:1') {
  const factJson = JSON.stringify(value),
    factHash = sourceFactHash(factJson),
    indexJson = JSON.stringify(sourceIndex(value, factHash)),
    row = {
      scope_key: key,
      business_date: value.createdAt.slice(0, 10),
      order_id: value.id,
      index_json: indexJson,
      index_hash: sourceFactHash(indexJson),
    };
  const publication: SearchPublication = {
    contract_version: sourceSearchContract,
    generation_id: generation,
    scope_key: key,
    business_date: value.createdAt.slice(0, 10),
    source_complete: true,
    source_snapshot_id: 'synthetic-checkpoint-001',
    source_snapshot_at: new Date(now - 60000).toISOString(),
    source_cdc_watermark: new Date(now - 50000).toISOString(),
    published_at: new Date(now - 40000).toISOString(),
    contact_key_id: options.ORDER_SEARCH_CONTACT_KEY_ID!,
    source_rows: '1',
    warehouse_rows: '1',
    source_hash: searchIndexRowsHash([row]),
    warehouse_hash: searchIndexRowsHash([row]),
  };
  return {
    publication,
    index: row,
    fact: {
      order_id: value.id,
      business_date: value.createdAt.slice(0, 10),
      fact_json: factJson,
      fact_hash: factHash,
    },
  };
}
