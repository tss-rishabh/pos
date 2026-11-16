import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

export const administrationHistoryModels = ['operator', 'store', 'group'] as const;
const date = z.iso.date().refine((value) => {
  try {
    return Temporal.PlainDate.from(value).year >= 1000;
  } catch {
    return false;
  }
});
const view = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/,
  );
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export const historySourceContract = 'django-admin-log-en-us-v1' as const;
export function readAdministrationHistoryOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      POS_ADMINISTRATION_HISTORY_MYSQL_CONTRACT: optional(z.literal(historySourceContract)),
      POS_ADMINISTRATION_HISTORY_MYSQL_ACTOR: optional(z.enum(['auth-user', 'pos-user'])),
      BQ_ADMINISTRATION_HISTORY_VIEW: optional(view),
      BQ_ADMINISTRATION_HISTORY_MATCH_UDF: optional(view),
      BQ_ADMINISTRATION_HISTORY_CONTRACT: optional(z.literal(historySourceContract)),
    })
    .parse(env);
}
export type AdministrationHistoryOptions = ReturnType<typeof readAdministrationHistoryOptions>;
const numericId = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const logId = z
  .string()
  .regex(/^(?:0|-?[1-9]\d{0,9})$/)
  .refine((value) => BigInt(value) >= -2147483648n && BigInt(value) <= 2147483647n);
export const historyInput = z
  .object({
    model: z.enum(administrationHistoryModels),
    objectId: z.string().min(1).max(36),
    from: date.nullable().default(null),
    to: date.nullable().default(null),
    page: z
      .union([
        z.string().max(80),
        z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
      ])
      .default('1'),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.model === 'group'
        ? !z.uuid().safeParse(value.objectId).success
        : !numericId.safeParse(value.objectId).success
    )
      context.addIssue({
        code: 'custom',
        path: ['objectId'],
        message: 'Choose an existing model object.',
      });
    if (
      (value.from === null) !== (value.to === null) ||
      (value.from && value.to && value.from > value.to)
    )
      context.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'Choose both dates in order, or all history.',
      });
  });
export type AdministrationHistoryInput = z.infer<typeof historyInput>;
export const historyCount = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 18446744073709551615n);
export const historyTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/)
  .refine((value) => {
    try {
      return (
        Temporal.PlainDateTime.from(value.replace(' ', 'T'), { overflow: 'reject' }).year >= 1000
      );
    } catch {
      return false;
    }
  });
export const historyProjection = z.object({
  id: logId,
  actionTime: historyTimestamp,
  actorId: logId,
  actorUsername: z.string().max(150),
  actorFirstName: z.string().max(150),
  actorLastName: z.string().max(150),
  actionFlag: z.number().int().min(0).max(65535),
  changeMessage: z.string().max(4 * 1024 * 1024),
});
export type AdministrationHistoryProjection = z.infer<typeof historyProjection>;
