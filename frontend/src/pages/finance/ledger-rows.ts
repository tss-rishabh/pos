import { z } from 'zod';
const money = z.string().nullable();
export const ledgerRowSchema = z.object({
  store_id: z.string(),
  store_name: z.string(),
  date: z.string(),
  opening_cash: money,
  sales_cash: money,
  running_total: money,
  actual_cash: money,
  difference: money,
  banking_amount: money,
  closing_balance: money,
  status: z.string(),
  note: z.string(),
});
export type LedgerRow = z.infer<typeof ledgerRowSchema>;
export const ledgerColumns = [
  ['store_name', 'Store'],
  ['date', 'Date'],
  ['opening_cash', 'Opening cash'],
  ['sales_cash', 'Cash sales'],
  ['running_total', 'Running total'],
  ['actual_cash', 'Actual cash'],
  ['difference', 'Difference'],
  ['banking_amount', 'Banked'],
  ['closing_balance', 'Closing cash'],
  ['status', 'Status'],
  ['note', 'Note'],
] as const;
export type LedgerSort = (typeof ledgerColumns)[number][0] | 'source';
export const ledgerExportHeaders = [
  'Store Name',
  'Date',
  'Opening cash',
  "Today's sales cash",
  "Previous cash balance + today's sale cash",
  'Actual sale cash',
  'Difference',
  'Banking amount',
  'Closing balance',
  'Status',
  'Note',
];
const monetary = new Set<LedgerSort>([
  'opening_cash',
  'sales_cash',
  'running_total',
  'actual_cash',
  'difference',
  'banking_amount',
  'closing_balance',
]);
/** Filter/page only after the complete financial chain has been calculated by the server. */
export function selectLedgerRows(
  rows: readonly LedgerRow[],
  search: string,
  sort: LedgerSort,
  direction: 'asc' | 'desc',
  page: number,
  pageSize: number,
) {
  const special = new Set(['\\', '^', '$', '.', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}']),
    escaped = Array.from(search.trim(), (char) => (special.has(char) ? '\\' + char : char)).join(
      '',
    ),
    words = (escaped.match(/"[^"]+"|[^ ]+/g) || ['']).map((word) => {
      if (word.startsWith('"')) {
        const match = /^"(.*)"$/.exec(word);
        word = match?.[1] ?? word;
      }
      return word.replace('"', '');
    }),
    query = new RegExp('^(?=.*?' + words.join(')(?=.*?') + ').*$', 'i'),
    selected = rows
      .filter((row) =>
        query.test(
          ledgerColumns
            .map(([key]) =>
              key === 'status' && row.status === 'NOT_CLOSED' ? 'Not closed' : (row[key] ?? ''),
            )
            .join('  ')
            .replace(/[\r\n\u2028]/g, ''),
        ),
      )
      .map((row, index) => {
        if (sort === 'source') return { row, index, key: index };
        const value = row[sort],
          key =
            value === null
              ? null
              : monetary.has(sort) && /^-?\d+\.\d{2}$/.test(value)
                ? BigInt(value.replace('.', ''))
                : value.toLocaleLowerCase();
        return { row, index, key };
      });
  selected.sort((left, right) => {
    let result: number;
    if (left.key === right.key) result = 0;
    else if (left.key === null) result = -1;
    else if (right.key === null) result = 1;
    else if (typeof left.key === 'number' && typeof right.key === 'number')
      result = left.key - right.key;
    else if (typeof left.key === 'bigint' && typeof right.key === 'bigint')
      result = left.key < right.key ? -1 : 1;
    else result = String(left.key).localeCompare(String(right.key));
    return (direction === 'desc' ? -result : result) || left.index - right.index;
  });
  const filtered = selected.map((value) => value.row),
    total = selected.length,
    totalPages = Math.ceil(total / pageSize),
    current = page > totalPages ? 1 : page;
  return {
    data: filtered.slice((current - 1) * pageSize, current * pageSize),
    filtered,
    total,
    totalPages,
    page: current,
  };
}
