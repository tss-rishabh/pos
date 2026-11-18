/** Complete literal publications derived only from this workflow's native snapshot. */
import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { sourceSearchContract, type SourceOrder } from '../../../src/modules/order-history/search/contracts.js';
import { sourceIndex, sourceFactHash } from '../../../src/modules/order-history/search/reducer.js';
import { searchIndexRowsHash } from '../../../src/modules/order-history/search/warehouse.js';
import { orderHistoryContract, type HistoryHeader, type HistoryLine, type HistoryStore } from '../../../src/modules/order-history/contracts.js';
import { historyCopyHash, historyOrderHash } from '../../../src/modules/order-history/hashes.js';
import { fixtureManifestSchema, type FixtureManifest } from './fixture-sql.js';
import { allowedOrderStatements } from './query-shapes.js';
import { readOrderSearchOptions } from '../../../src/modules/order-history/search/options.js';
import { readOrderHistoryOptions } from '../../../src/modules/order-history/options.js';

export const workflowViews = {
  ORDER_SEARCH_CONTRACT: sourceSearchContract,
  BQ_ORDER_SEARCH_INDEX_VIEW: 'tssgcp2025.synthetic_order_ui.search_index',
  BQ_ORDER_SEARCH_FACTS_VIEW: 'tssgcp2025.synthetic_order_ui.search_facts',
  BQ_ORDER_SEARCH_PUBLICATIONS_VIEW: 'tssgcp2025.synthetic_order_ui.search_publications',
  ORDER_HISTORY_CONTRACT: orderHistoryContract,
  BQ_ORDER_HISTORY_HEADERS_VIEW: 'tssgcp2025.synthetic_order_ui.history_headers',
  BQ_ORDER_HISTORY_STORES_VIEW: 'tssgcp2025.synthetic_order_ui.history_stores',
  BQ_ORDER_HISTORY_LINES_VIEW: 'tssgcp2025.synthetic_order_ui.history_lines',
  BQ_ORDER_HISTORY_PUBLICATIONS_VIEW: 'tssgcp2025.synthetic_order_ui.history_publications',
} as const;
type Row = Record<string, string | boolean | null>;
type Table = FixtureManifest['tables'][number];
export interface NativeOrderSnapshot {
  facts: SourceOrder[];
  headers: HistoryHeader[];
  stores: HistoryStore[];
  lines: HistoryLine[];
}
export function workflowPublications(
  nativeSchema: string,
  snapshot: NativeOrderSnapshot,
  now: number,
  contactKey: string,
  contactKeyId: string,
): FixtureManifest {
  if (new Set(snapshot.facts.map(row => row.id)).size !== snapshot.facts.length)
    throw new Error('DUPLICATE_NATIVE_ORDER_SNAPSHOT');
  const search = readOrderSearchOptions({ ...workflowViews, ORDER_SEARCH_CONTACT_KEY: contactKey, ORDER_SEARCH_CONTACT_KEY_ID: contactKeyId });
  const history = readOrderHistoryOptions(workflowViews);
  const generation = randomUUID();
  const checkpoint = 'owned-order-ui-snapshot-' + randomUUID();
  const at = new Date(now - 60000).toISOString();
  const common = {
    generation_id: generation, source_complete: true, source_snapshot_id: checkpoint,
    source_snapshot_at: at, source_cdc_watermark: at, published_at: at,
  };
  function table(logicalView: string, cte: string, columns: Table['columns'], rows: Row[]): Table {
    return { logicalView, cte, columns, rows };
  }
  const indexes: Row[] = [], facts: Row[] = [], publications: Row[] = [];
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO('Asia/Kolkata').toPlainDate();
  const days = Array.from({length:6}, (_, index) => today.subtract({days:5-index}).toString());
  const scopes = ['store:1', 'store:2', 'global:0', ...snapshot.facts.map(fact => 'order:'+fact.id)];
  for (const scope of scopes) for (const day of days) {
    const selected = snapshot.facts.filter(fact => fact.createdAt.slice(0,10) === day && (
      scope === 'global:0' || scope === 'order:'+fact.id ||
      fact.stores.some(store => scope === 'store:'+store.storeId) ||
      (fact.locationStoreId !== null && scope === 'store:'+fact.locationStoreId) ||
      fact.expressStoreIds.some(store => scope === 'store:'+store)));
    const rows = selected.map(fact => {
      const factHash = sourceFactHash(JSON.stringify(fact));
      const indexJson = JSON.stringify(sourceIndex(fact, factHash));
      return {scope_key:scope,business_date:day,order_id:fact.id,index_json:indexJson,index_hash:sourceFactHash(indexJson)};
    });
    indexes.push(...rows.map(row => ({...row,contract_version:sourceSearchContract,generation_id:generation})));
    const hash = searchIndexRowsHash(rows);
    publications.push({...common,contract_version:sourceSearchContract,scope_key:scope,
      scope_shard:String(scope.startsWith('store:')||scope.startsWith('order:')?BigInt(scope.split(':')[1]!)%1024n:0n),
      business_date:day,contact_key_id:contactKeyId,source_rows:String(rows.length),warehouse_rows:String(rows.length),source_hash:hash,warehouse_hash:hash});
  }
  for (const fact of snapshot.facts) {
    const json = JSON.stringify(fact);
    facts.push({contract_version:sourceSearchContract,generation_id:generation,order_id:fact.id,
      business_date:fact.createdAt.slice(0,10),order_shard:String(BigInt(fact.id)%8192n),fact_json:json,fact_hash:sourceFactHash(json)});
  }
  const pointPublications: Row[] = [];
  for (const fact of snapshot.facts) {
    const headers = snapshot.headers.filter(header => header.id === fact.id);
    const stores = snapshot.stores.filter(store => store.orderId === fact.id);
    const lines = snapshot.lines.filter(line => line.orderId === fact.id);
    if (headers.length !== 1) throw new Error('INCOMPLETE_NATIVE_HEADER_SNAPSHOT');
    const hash = historyOrderHash(headers,stores,lines), copyHash=historyCopyHash(headers,stores,lines);
    const counts = { rows:String(1+stores.length+lines.length),orders:'1',stores:String(stores.length),lines:String(lines.length) };
    pointPublications.push({...common,contract_version:orderHistoryContract,kind:'order',scope_id:fact.id,
      scope_shard:String(BigInt(fact.id)%1024n),business_date:fact.createdAt.slice(0,10),
      ...Object.fromEntries(Object.entries(counts).flatMap(([key,value])=>[['source_'+key,value],['warehouse_'+key,value]])),
      source_hash:hash,warehouse_hash:hash,source_copy_hash:copyHash,warehouse_copy_hash:copyHash});
  }
  const timestampColumns = {source_snapshot_at:'TIMESTAMP',source_cdc_watermark:'TIMESTAMP',published_at:'TIMESTAMP'} as const;
  const columns = (names: string[], special: Table['columns'] = {}) => Object.fromEntries(names.map(name=>[name,special[name]??'STRING'])) as Table['columns'];
  const manifestNames = ['generation_id','contract_version','kind','scope_id','scope_shard','business_date','source_complete','source_snapshot_id','source_snapshot_at','source_cdc_watermark','published_at','source_rows','warehouse_rows','source_orders','warehouse_orders','source_stores','warehouse_stores','source_lines','warehouse_lines','source_hash','warehouse_hash','source_copy_hash','warehouse_copy_hash'];
  const base = {contract_version:orderHistoryContract,generation_id:generation};
  const publicHeaders = snapshot.headers.map(header=>({...base,order_id:header.id,customer_id:header.customerId,reference:header.reference,first_name:header.first,last_name:header.last,amount:header.amount,status:header.status,payment_status:header.paymentStatus,payment_status_id:header.paymentStatusId,created_at:header.createdAt}));
  const publicStores = snapshot.stores.map(store=>({...base,order_store_id:store.id,order_id:store.orderId,store_id:store.storeId,counter_id:store.counterId,business_date:snapshot.headers.find(header=>header.id===store.orderId)!.createdAt.slice(0,10)}));
  const publicLines = snapshot.lines.map(line=>({...base,line_id:line.id,order_id:line.orderId,product_id:line.productId,name:line.name,quantity:line.quantity,amount:line.amount,gst:line.gst,status:line.status,business_date:snapshot.headers.find(header=>header.id===line.orderId)!.createdAt.slice(0,10)}));
  return fixtureManifestSchema.parse({version:1,project:'tssgcp2025',location:'asia-south1',nativeSchema,
    nativeSnapshotSha256:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),maximumBytesBilled:'10000000',maximumRequests:512,
    allowedStatements:allowedOrderStatements(search,history).statements,
    tables:[
      table(workflowViews.BQ_ORDER_SEARCH_INDEX_VIEW,'fixture_search_index',columns(['scope_key','business_date','order_id','index_json','index_hash','contract_version','generation_id'],{business_date:'DATE'}),indexes),
      table(workflowViews.BQ_ORDER_SEARCH_FACTS_VIEW,'fixture_search_facts',columns(['contract_version','generation_id','order_id','business_date','order_shard','fact_json','fact_hash'],{business_date:'DATE',order_shard:'INT64'}),facts),
      table(workflowViews.BQ_ORDER_SEARCH_PUBLICATIONS_VIEW,'fixture_search_publications',columns(['generation_id','source_complete','source_snapshot_id','source_snapshot_at','source_cdc_watermark','published_at','contract_version','scope_key','scope_shard','business_date','contact_key_id','source_rows','warehouse_rows','source_hash','warehouse_hash'],{...timestampColumns,business_date:'DATE',scope_shard:'INT64',source_complete:'BOOL',source_rows:'INT64',warehouse_rows:'INT64'}),publications),
      table(workflowViews.BQ_ORDER_HISTORY_PUBLICATIONS_VIEW,'fixture_history_publications',columns(manifestNames,{...timestampColumns,business_date:'DATE',scope_shard:'INT64',source_complete:'BOOL',...Object.fromEntries(manifestNames.filter(name=>/^(?:source|warehouse)_(?:rows|orders|stores|lines)$/.test(name)).map(name=>[name,'INT64' as const]))}),pointPublications),
      table(workflowViews.BQ_ORDER_HISTORY_HEADERS_VIEW,'fixture_history_headers',columns(['contract_version','generation_id','order_id','customer_id','reference','first_name','last_name','amount','status','payment_status','payment_status_id','created_at'],{created_at:'DATETIME'}),publicHeaders),
      table(workflowViews.BQ_ORDER_HISTORY_STORES_VIEW,'fixture_history_stores',columns(['contract_version','generation_id','order_store_id','order_id','store_id','counter_id','business_date'],{business_date:'DATE'}),publicStores),
      table(workflowViews.BQ_ORDER_HISTORY_LINES_VIEW,'fixture_history_lines',columns(['contract_version','generation_id','line_id','order_id','product_id','name','quantity','amount','gst','status','business_date'],{business_date:'DATE'}),publicLines),
    ]});
}
