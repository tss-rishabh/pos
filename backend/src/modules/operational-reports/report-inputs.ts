import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { routeRead } from '../../domain/routing.js';
import type { Principal } from '../../domain/access.js';
import { requireStore } from '../../domain/access.js';
export const businessTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/)
  .refine((value) => {
    try {
      return Temporal.PlainDateTime.from(value).year >= 1000;
    } catch {
      return false;
    }
  }, 'Use a valid local date and time.');
export const warehouseView = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z_][A-Za-z0-9_]{0,1023}\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/,
  )
  .optional();
export const scalarId = z
  .union([z.string().regex(/^\d+$/), z.number().int().refine(Number.isSafeInteger), z.bigint()])
  .transform(String);
/** A SQL COUNT without GROUP BY always has exactly one non-null result row. */
export function warehouseReportCount(value: unknown): number {
  const count = z.union([
    z.number().int().safe().nonnegative(),
    z.string().regex(/^\d+$/).transform(Number).refine(Number.isSafeInteger),
  ]);
  const result = z.array(z.object({ count })).length(1).safeParse(value);
  if (!result.success)
    throw new AppError(
      503,
      'REPORT_VIEW_INVALID',
      'The report count does not match the required data contract.',
    );
  return result.data[0]!.count;
}
/** Restricted operator type retains its assigned-store boundary even with role 1. */
export function staffReportScope(user: Principal, requested: readonly string[]) {
  const ids = [...new Set(requested)];
  if (user.userType === 2 && ids.some((id) => !user.storeIds.includes(id)))
    throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
  return { ids, empty: user.userType === 2 && !ids.length };
}
/** Order reports require explicit store selection in the original API. */
export function orderReportScope(user: Principal, requested: readonly string[]) {
  const ids = [...new Set(requested)];
  ids.forEach((id) => {
    requireStore(user, id);
    if (user.userType === 2 && !user.storeIds.includes(id))
      throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
  });
  return ids;
}
export function timestampReportBounds(
  config: Pick<Config, 'BUSINESS_TIMEZONE'>,
  from: string,
  to: string,
  now = Temporal.Now.instant(),
) {
  const start = Temporal.PlainDateTime.from(from),
    end = Temporal.PlainDateTime.from(to);
  if (Temporal.PlainDateTime.compare(start, end) > 0)
    throw new AppError(400, 'INVALID_DATE_RANGE', 'The To time precedes the From time.');
  const reader = routeRead(
    {
      kind: 'report',
      range: {
        start: start.toZonedDateTime(config.BUSINESS_TIMEZONE).toInstant().toString(),
        end: end
          .add({ seconds: 1 })
          .toZonedDateTime(config.BUSINESS_TIMEZONE)
          .toInstant()
          .toString(),
      },
    },
    now,
    config.BUSINESS_TIMEZONE,
  );
  return {
    reader,
    from: start.toString({ smallestUnit: 'second' }).replace('T', ' '),
    to: end.toString({ smallestUnit: 'second' }).replace('T', ' '),
  };
}
