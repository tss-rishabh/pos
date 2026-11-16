import { z } from 'zod';

export const historyModel = z.enum(['operator', 'store', 'group']);
const count = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
const sourceId = z
  .string()
  .regex(/^(?:0|-?[1-9]\d{0,18})$/)
  .refine(
    (value) => BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n,
  );
export const historyCapabilities = z.object({
  today: z.iso.date(),
  timeZone: z.string(),
  models: z.array(z.object({ id: historyModel, label: z.string() })).max(3),
  pageSize: z.literal(100),
  dailyConfigured: z.boolean(),
  historyConfigured: z.boolean(),
});
export const historySelection = z
  .object({ model: historyModel, objectId: z.string().min(1).max(36) })
  .strict();
export const historyResult = z
  .object({
    resource: z.object({ model: historyModel, objectId: z.string(), label: z.string() }),
    reader: z.enum(['none', 'data-reader', 'bigquery']),
    today: z.iso.date(),
    timeZone: z.string(),
    provenance: z.literal('django-admin'),
    notice: z.string().nullable(),
    total: count,
    page: count,
    pages: count,
    start: count,
    count: z.number().int().min(0).max(100),
    pageSize: z.literal(100),
    data: z
      .array(
        z.object({
          id: sourceId,
          actionTime: z.string(),
          actionTimeLabel: z.string(),
          actorId: sourceId,
          actor: z.string(),
          actionFlag: z.number().int().min(0).max(65535),
          action: z.string(),
          messageState: z.enum(['available', 'invalid']),
        }),
      )
      .max(100),
  })
  .superRefine((value, context) => {
    const total = BigInt(value.total),
      page = BigInt(value.page),
      pages = total === 0n ? 1n : (total + 99n) / 100n,
      start = (page - 1n) * 100n;
    if (
      page < 1n ||
      page > pages ||
      BigInt(value.pages) !== pages ||
      BigInt(value.start) !== start ||
      value.count !== value.data.length ||
      BigInt(value.count) !== (total - start < 100n ? total - start : 100n)
    )
      context.addIssue({ code: 'custom', message: 'Model history is temporarily unavailable.' });
  });
export type HistoryModel = z.infer<typeof historyModel>;
