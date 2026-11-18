import { Temporal } from '@js-temporal/polyfill';
import { AppError } from '../../../domain/errors.js';
import { orderRange, type OrderReadRange } from '../contracts.js';
import type { OrderSearchInput } from './contracts.js';

const stamp = (value: Temporal.PlainDateTime) =>
  value.toString({ smallestUnit: 'second' }).replace('T', ' ');
export function sourceOrderDefaults(now: number, timeZone: string) {
  const instant = Temporal.Instant.fromEpochMilliseconds(now);
  const current = instant.toZonedDateTimeISO(timeZone).toPlainDateTime();
  const minute = current.with({ second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 });
  const placedFrom = stamp(minute.subtract({ days: 5 }));
  return {
    generatedAt: instant.toString(),
    timeZone,
    store: { placedFrom, placedTo: stamp(minute.add({ minutes: 1 })) },
  };
}
export interface SourceSearchReadPlan {
  selected: OrderReadRange;
  historical?: OrderReadRange;
  current?: OrderReadRange;
}
/** Only source search supports its original minute-ahead store endpoint. */
export function sourceSearchReadPlan(
  input: OrderSearchInput,
  timeZone: string,
  now: number,
): SourceSearchReadPlan {
  const defaults = sourceOrderDefaults(now, timeZone);
  const today = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
  const from = input.from ?? input.placedFrom?.slice(0, 10),
    to = input.to ?? input.placedTo?.slice(0, 10);
  const future = Boolean(to && to > today.toString());
  if (
    future &&
    (!input.placedTo ||
      input.placedTo.slice(0, 10) !== to ||
      input.intent === 'report' ||
      Temporal.PlainDateTime.compare(
        Temporal.PlainDateTime.from(input.placedTo.replace(' ', 'T')),
        Temporal.PlainDateTime.from(defaults.store.placedTo.replace(' ', 'T')),
      ) > 0 ||
      !from ||
      from > today.toString() ||
      to !== today.add({ days: 1 }).toString())
  )
    throw new AppError(
      400,
      'INVALID_ORDER_DATE_RANGE',
      'Use the current source order date window.',
    );
  // Ordinary mixed selections retain the existing common-checkpoint contract.
  const selected = orderRange(
    { from, to: future ? today.toString() : to, intent: input.intent },
    timeZone,
    now,
  );
  if (!future)
    return { selected, ...(selected.reader === 'bigquery' ? { historical: selected } : {}) };
  if (Temporal.PlainDate.from(from!).until(Temporal.PlainDate.from(to!)).days > 61)
    throw new AppError(400, 'INVALID_ORDER_DATE_RANGE', 'Select up to 62 calendar days.');
  const tomorrow = today.add({ days: 1 }).toString();
  const exclusiveEnd = Temporal.PlainDateTime.from(input.placedTo!.replace(' ', 'T'))
    .add({ microseconds: 1 })
    .toString({ smallestUnit: 'microsecond' })
    .replace('T', ' ');
  return {
    selected: { ...selected, to: to!, end: exclusiveEnd },
    historical: selected,
    // Only the narrowly admitted future fraction is live; historical/current
    // facts remain on their existing complete common-checkpoint publication.
    current: {
      ...selected,
      from: tomorrow,
      to: tomorrow,
      start: tomorrow + ' 00:00:00',
      end: exclusiveEnd,
      reader: 'primary',
    },
  };
}
