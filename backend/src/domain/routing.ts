import { Temporal } from '@js-temporal/polyfill';
import { AppError } from './errors.js';

export type Reader = 'primary' | 'data' | 'bigquery';
export interface ReportRange {
  start: string;
  end: string;
}
export type ReadIntent = { kind: 'interactive' } | { kind: 'report'; range: ReportRange };

/** Routes whole reports to one source; operational reads never use stale warehouse state. */
export function routeRead(
  intent: ReadIntent,
  now = Temporal.Now.instant(),
  zone = 'Asia/Kolkata',
): Reader {
  if (intent.kind === 'interactive') return 'primary';
  const { start, end } = validateRange(intent.range);
  const day=now.toZonedDateTimeISO(zone).startOfDay();
  return Temporal.Instant.compare(start,day.toInstant())>=0&&Temporal.Instant.compare(end,day.add({days:1}).toInstant())<=0?'data':'bigquery';
}
export function validateRange(range: ReportRange) {
  let start: Temporal.Instant, end: Temporal.Instant;
  try {
    start = Temporal.Instant.from(range.start);
    end = Temporal.Instant.from(range.end);
  } catch {
    throw new AppError(400, 'INVALID_DATE_RANGE', 'Use ISO timestamps with timezone offsets.');
  }
  if (Temporal.Instant.compare(end, start) <= 0)
    throw new AppError(400, 'INVALID_DATE_RANGE', 'End must follow start.');
  if (end.epochMilliseconds - start.epochMilliseconds > 63 * 86_400_000)
    throw new AppError(400, 'INVALID_DATE_RANGE', 'Select a range of 62 calendar days or less.');
  return { start, end };
}
export function businessRange(date: string, zone = 'Asia/Kolkata'): ReportRange {
  const start = Temporal.PlainDate.from(date).toZonedDateTime({
    timeZone: zone,
    plainTime: '00:00',
  });
  return {
    start: start.toInstant().toString(),
    end: start.add({ days: 1 }).toInstant().toString(),
  };
}
