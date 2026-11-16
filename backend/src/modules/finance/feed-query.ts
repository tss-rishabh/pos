import { sql, type SQL } from 'drizzle-orm';
import { feedSql } from './feed-sql.js';

/** Make the source's per-HP arbitrary projections explicit under ONLY_FULL_GROUP_BY. */
export function strictFeedProjection(query: string): string {
  return query
    .split(/\nUNION ALL\n/)
    .map((part) => {
      const begin = part.indexOf('SELECT') + 6,
        end = part.indexOf('\nFROM\n');
      if (begin < 6 || end < begin) throw new Error('The source feed SELECT shape changed.');
      const text = part.slice(begin, end),
        fields: string[] = [];
      let depth = 0,
        quote = '',
        start = 0;
      for (let index = 0; index < text.length; index++) {
        const char = text[index]!;
        if (quote) {
          if (char === quote) {
            if (text[index + 1] === quote) index++;
            else quote = '';
          } else if (char === '\\') index++;
          continue;
        }
        if (char === "'" || char === '"' || char === '`') {
          quote = char;
          continue;
        }
        if (char === '(') depth++;
        else if (char === ')') depth--;
        else if (char === ',' && depth === 0) {
          fields.push(text.slice(start, index).trim());
          start = index + 1;
        }
      }
      fields.push(text.slice(start).trim());
      const strict = fields.map((field) => {
        if (/^MAX\s*\(/i.test(field)) return field;
        const alias = /\s+AS\s+([A-Za-z_]\w*)\s*$/i.exec(field);
        if (!alias) throw new Error('The source feed projection alias changed.');
        return `ANY_VALUE(${field.slice(0, alias.index)}) AS ${alias[1]}`;
      });
      return part.slice(0, begin) + '\n' + strict.join(',\n') + part.slice(end);
    })
    .join('\nUNION ALL\n');
}
/** Values are always Drizzle-bound; copied SQL is static and never sourced from requests. */
export function bindFeedSql(query: string, args: readonly string[]): SQL {
  const parts = query.split('%s');
  if (parts.length !== args.length + 1) throw new Error('The feed query parameter count changed.');
  return sql.join(
    parts.flatMap((part, index) =>
      index < args.length ? [sql.raw(part), sql`${args[index]}`] : [sql.raw(part)],
    ),
    sql``,
  );
}
export function feedQueries(from: string, end: string, storeCode?: string) {
  const store = storeCode ? ' AND s.location_code = %s' : '',
    dates = [from + ' 00:00:00', end + ' 00:00:00', ...(storeCode ? [storeCode] : [])];
  const sales = `${feedSql.sales} AND o.created_at >= %s AND o.created_at < %s${store} GROUP BY hp.id LIMIT 70001`;
  const returns =
    feedSql.returns
      .replace('{ro_where}', `ro.created_at >= %s AND ro.created_at < %s${store}`)
      .replace('{rr_where}', `rr.created_at >= %s AND rr.created_at < %s${store}`) + ' LIMIT 70001';
  return {
    sales: bindFeedSql(strictFeedProjection(sales), dates),
    returns: bindFeedSql(strictFeedProjection(returns), [...dates, ...dates]),
    source: { sales, returns, args: dates },
  };
}
