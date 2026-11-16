import { z } from 'zod';
import { csvCell } from '../reports';

export const activityCapabilitiesSchema = z.object({
  today: z.iso.date(),
  platforms: z.array(z.string()),
  historyConfigured: z.boolean(),
});
const sourceId = z
  .string()
  .regex(/^(?:0|-?[1-9]\d{0,18})$/)
  .refine(
    (value) => BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n,
  );
const count = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
export const activityResultSchema = z.object({
  reader: z.enum(['data-reader', 'bigquery']),
  today: z.iso.date(),
  draw: z.number().int(),
  recordsTotal: count,
  recordsFiltered: count,
  start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  length: z.number().int().min(1).max(500),
  data: z
    .array(
      z.object({
        id: sourceId,
        addedBy: z.string(),
        platform: z.string(),
        comment: z.string().nullable(),
        createdAt: z.string(),
        recipient: z.string(),
      }),
    )
    .max(500),
});
export type ActivityRow = z.infer<typeof activityResultSchema>['data'][number];
export const activityColumns = [
  ['platform', 'Platform'],
  ['recipient', 'Recipient'],
  ['addedBy', 'Added by'],
  ['comment', 'Comment'],
  ['createdAt', 'Created at'],
] as const;
export type ActivityColumn = (typeof activityColumns)[number][0];

/** Server-side DataTables exported the loaded page and visible columns. */
export function activityPageCsv(rows: readonly ActivityRow[], selected: readonly ActivityColumn[]) {
  const visible = activityColumns.filter(([key]) => selected.includes(key));
  return (
    '\uFEFF' +
    [visible.map(([, label]) => label), ...rows.map((row) => visible.map(([key]) => row[key]))]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n')
  );
}
