import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../config.js';
import type { ActivityProjection, ActivitySearchInput } from './contracts.js';

export function sourceActivityPageStart(start: number, length: number, total: bigint) {
  return start < 0 || start % length !== 0 || BigInt(start) >= total ? 0 : start;
}
export const sourceActivityPattern = (search: string) =>
  '%' + search.replaceAll('"', "'").replace(/[\\%_]/g, '\\$&') + '%';
/** The source filters empty comma entries before Python str.strip(), preserving whitespace-only entries. */
export function sourceActivityPlatforms(values: readonly string[]) {
  const whitespace =
    /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
  return [
    ...new Set(
      values
        .join(',')
        .replaceAll('&#x27;', '')
        .split(',')
        .filter((value) => value !== '')
        .map((value) => value.replace(whitespace, '')),
    ),
  ];
}
/** DjangoJSONEncoder truncates native datetime microseconds to milliseconds without adding a zone. */
export function sourceActivityDate(value: string) {
  const parts = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!parts) return value;
  try {
    Temporal.PlainDateTime.from(value.replace(' ', 'T'), { overflow: 'reject' });
  } catch {
    return value;
  }
  const fraction = parts[3] || '';
  return (
    parts[1] +
    'T' +
    parts[2] +
    (fraction && /[1-9]/.test(fraction) ? '.' + fraction.padEnd(6, '0').slice(0, 3) : '')
  );
}
export const activityRecord = (row: ActivityProjection) => ({
  id: row.id,
  addedBy: row.actorExists ? row.firstName + ' ' + row.lastName : 'unknown',
  platform: row.platform,
  comment: row.comment,
  createdAt: sourceActivityDate(row.createdAt),
  recipient: row.recipient || 'NA',
});
export function activityReadScope(
  config: Config,
  input: ActivitySearchInput,
  now: Temporal.Instant,
) {
  const today = now.toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate().toString();
  const reader =
    input.from === today && input.to === today ? ('data-reader' as const) : ('bigquery' as const);
  return {
    today,
    reader,
    from: input.from ? input.from + ' 00:00:00' : null,
    to:
      input.to && input.to !== '9999-12-31'
        ? Temporal.PlainDate.from(input.to).add({ days: 1 }).toString() + ' 00:00:00'
        : null,
  };
}
