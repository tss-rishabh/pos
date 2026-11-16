import { sql, type SQL } from 'drizzle-orm';
import { flashSalesSourceSql } from './flash-sales-sql.js';
import { AppError } from '../../domain/errors.js';
const eligible = `WITH eligible_orders AS (SELECT DISTINCT o.id FROM orders o JOIN order_stores selected_os ON selected_os.order_id=o.id WHERE selected_os.store_id IN ({{stores}}) AND o.order_status NOT IN (0,1,4,17) AND o.created_at BETWEEN {{start}} AND {{end}}),cash_summary AS (SELECT os2.order_id,SUM(os2.offline_payment) AS total_cash FROM order_stores os2 JOIN eligible_orders eligible ON eligible.id=os2.order_id GROUP BY os2.order_id),paytm_summary AS (SELECT p.order_id,SUM(CASE WHEN p.payment_mode=1003 THEN p.amount ELSE 0 END) AS total_card,SUM(CASE WHEN p.payment_mode=1004 THEN p.amount ELSE 0 END) AS total_upi FROM pos_paytm_transactions p JOIN eligible_orders eligible ON eligible.id=p.order_id WHERE p.is_active=1 AND p.platform='txn_completed' AND p.payment_mode IN (1003,1004) AND p.store_id IN ({{stores}}) GROUP BY p.order_id) `;
function replaceOnce(source: string, pattern: RegExp, replacement: string) {
  const matches = source.match(
    new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'),
  );
  if (matches?.length !== 1) throw new Error('The inspected flash sales query contract changed.');
  return source.replace(pattern, replacement);
}
function main(source: string) {
  let query = replaceOnce(
    source,
    /order_summary\.id\s+AS\s+id/i,
    'ANY_VALUE(order_summary.id) AS id',
  );
  query = replaceOnce(
    query,
    /\(SELECT\s+store_name\s+FROM\s+stores\s+WHERE\s+id\s*=\s*os\.store_id\)/i,
    'ANY_VALUE(sales_store.store_name)',
  );
  query = replaceOnce(
    query,
    /\(SELECT SUM\(os2\.offline_payment\)[\s\S]*?LIMIT 1\)/i,
    'MAX(cash_summary.total_cash)',
  );
  query = replaceOnce(
    query,
    /COALESCE\(\(\s*SELECT SUM\(ppt\.amount\)[\s\S]*?\),\s*0\) AS total_paytm_card/i,
    'COALESCE(MAX(paytm_summary.total_card),0) AS total_paytm_card',
  );
  query = replaceOnce(
    query,
    /COALESCE\(\(\s*SELECT SUM\(put\.amount\)[\s\S]*?\),\s*0\) AS total_paytm_upi/i,
    'COALESCE(MAX(paytm_summary.total_upi),0) AS total_paytm_upi',
  );
  query = replaceOnce(
    query,
    /WHERE\s+os\.store_id\s+IN/i,
    'LEFT JOIN stores sales_store ON sales_store.id=os.store_id LEFT JOIN cash_summary ON cash_summary.order_id=o.id LEFT JOIN paytm_summary ON paytm_summary.order_id=o.id WHERE os.store_id IN',
  );
  return eligible + query;
}
const templates = {
  interactive: main(flashSalesSourceSql.interactive),
  export: main(flashSalesSourceSql.export),
  refunds: flashSalesSourceSql.refunds
    .replace(/\(@rownum := @rownum \+ 1\) AS id,\s*/i, '')
    .replace(/CROSS JOIN \(SELECT @rownum := 0\) r/i, ''),
};
export type FlashQueryKind = keyof typeof templates;
/** Only inspected shipped SQL enters sql.raw. Every request value is a Drizzle parameter. */
export function flashSalesMysqlQuery(
  kind: FlashQueryKind,
  from: string,
  to: string,
  storeIds: readonly string[],
): SQL {
  if (!storeIds.length)
    throw new AppError(400, 'STORE_SELECTION_REQUIRED', 'Choose the stores to include.');
  const parts = templates[kind].split(/(\{\{(?:start|end|stores)\}\})/g);
  return sql.join(
    parts.map((part) =>
      part === '{{start}}'
        ? sql`${from}`
        : part === '{{end}}'
          ? sql`${to}`
          : part === '{{stores}}'
            ? sql.join(
                storeIds.map((id) => sql`${id}`),
                sql`,`,
              )
            : sql.raw(part),
    ),
    sql``,
  );
}
export const flashSalesWarehouseTables = [
  'orders',
  'order_stores',
  'has_products',
  'stores',
  'pos_paytm_transactions',
  'return_orders',
  'amount_to_be_refunded_log',
  'automated_refund_sic_logs',
] as const;
export type FlashSalesWarehouseTables = Record<(typeof flashSalesWarehouseTables)[number], string>;
/** Warehouse relations must expose the source column/type/join contracts; no schema is guessed. */
export function flashSalesWarehouseQuery(kind: FlashQueryKind, tables: FlashSalesWarehouseTables) {
  return templates[kind]
    .replace(
      /([A-Za-z_]\w*\.store_id)\s+IN\s*\(\{\{stores\}\}\)/gi,
      'CAST($1 AS STRING) IN UNNEST(@stores)',
    )
    .replaceAll('{{start}}', '@start')
    .replaceAll('{{end}}', '@end')
    .replace(
      /\b(FROM|JOIN)\s+(orders|order_stores|has_products|stores|pos_paytm_transactions|return_orders|amount_to_be_refunded_log|automated_refund_sic_logs)\b/gi,
      (_match: string, clause: string, table: string) =>
        `${clause} \`${tables[table.toLowerCase() as keyof FlashSalesWarehouseTables]}\``,
    );
}
