import { sql, type SQL } from 'drizzle-orm';
import { orderReportSql, orderReportCategoryJoin } from './order-report-sql.js';
interface Projection {
  expression: string;
  alias: string;
}
/** Inspect only shipped source constants. Request values never enter this parser or sql.raw. */
export function orderReportProjection(query: string): { fields: Projection[]; from: string } {
  const select = /\bSELECT\b/i.exec(query);
  if (!select) throw new Error('The source report SELECT shape changed.');
  const begin = select.index + select[0].length,
    fields: string[] = [];
  let depth = 0,
    quote = '',
    lineComment = false,
    blockComment = false,
    start = begin,
    end = -1;
  for (let index = begin; index < query.length; index++) {
    const char = query[index]!,
      next = query[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) index++;
        else quote = '';
      } else if (char === '\\') index++;
      continue;
    }
    if ((char === '-' && next === '-') || char === '#') {
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') depth--;
    if (depth === 0 && char === ',') {
      fields.push(query.slice(start, index).trim());
      start = index + 1;
    } else if (
      depth === 0 &&
      /^FROM\b/i.test(query.slice(index)) &&
      /\s/.test(query[index - 1] || '')
    ) {
      end = index;
      fields.push(query.slice(start, index).trim());
      break;
    }
  }
  if (end < 0) throw new Error('The source report FROM shape changed.');
  return {
    fields: fields.map((field) => {
      const match =
        /\s+AS\s+(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|`([A-Za-z_]\w*)`|([A-Za-z_]\w*))\s*$/i.exec(
          field,
        );
      if (match)
        return {
          expression: field.slice(0, match.index),
          alias: match[1] || match[2] || match[3] || match[4]!,
        };
      const column = /^(?:[A-Za-z_]\w*\.)?`?([A-Za-z_]\w*)`?$/.exec(field);
      if (column) return { expression: field, alias: column[1]! };
      throw new Error('The source report projection alias changed.');
    }),
    from: query.slice(end),
  };
}
export function strictOrderReportSelect(query: string) {
  const parsed = orderReportProjection(query),
    fields = [...new Map(parsed.fields.map((field) => [field.alias, field])).values()];
  return (
    'SELECT\n' +
    fields
      .map(
        (field) =>
          `${/^(?:[-+]?\d+(?:\.\d+)?|'(?:[^']|'')*'|"(?:[^"]|"")*"|NULL)$/i.test(field.expression.trim()) ? field.expression : `ANY_VALUE(${field.expression})`} AS \`${field.alias}\``,
      )
      .join(',\n') +
    '\n' +
    parsed.from
  );
}
export function combinedOrderQueries(
  source: 'store' | 'online',
  dateType: 'order_date' | 'return_date',
  from: string,
  to: string,
  storeIds: readonly string[],
) {
  const original = orderReportSql[source],
    saleDate = original.saleDate,
    returnDate =
      dateType === 'order_date'
        ? saleDate
        : source === 'online'
          ? 'COALESCE(ro.created_at,rr.created_at,cm.created_at,hp.updated_at)'
          : 'COALESCE(ro.created_at,rr.created_at)',
    storeColumn = source === 'online' ? 'poo.store_id' : 's.id';
  const branch = (query: string, date: string, count = false): SQL =>
    sql`${sql.raw(count ? 'SELECT COUNT(DISTINCT hp.id) AS count\n' + orderReportProjection(query).from.replace(orderReportCategoryJoin, '') : strictOrderReportSelect(query))} AND ${sql.raw(date)} BETWEEN ${from} AND ${to} AND ${sql.raw(storeColumn)} IN (${sql.join(
      storeIds.map((id) => sql`${id}`),
      sql`,`,
    )}) ${count ? sql`` : sql`GROUP BY arl.order_id,arl.prod_id,hp.id`}`;
  return {
    sales: branch(original.sales, saleDate),
    returns: branch(original.returns, returnDate),
    salesCount: branch(original.sales, saleDate, true),
    returnsCount: branch(original.returns, returnDate, true),
  };
}
