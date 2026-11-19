import { Temporal } from '@js-temporal/polyfill';

const stamp = (value: Temporal.PlainDateTime) =>
  value.toString({ smallestUnit: 'second' }).replace('T', ' ');
/** Legacy `OrdersView.get` default window: now - 5 days to now + 1 minute, minute precision. */
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
