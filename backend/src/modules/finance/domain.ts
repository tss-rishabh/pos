import { Temporal } from '@js-temporal/polyfill';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Role } from '../../domain/access.js';

export const closeReasonSchema = z.enum([
  '',
  'MANUAL_BILL_MADE',
  'MANUAL_BILL_PUNCHED',
  'CHANGE_SHORT',
  'CHANGE_EXCESS',
  'JUMBLING',
]);
const enteredMoney = z
  .string()
  .regex(
    /^\d{1,12}(?:\.\d{1,2})?$/,
    'Enter a non-negative amount with at most two decimal places.',
  );
export const closeEntriesSchema = z
  .object({
    cash_actual: enteredMoney,
    cash_manual_punched: enteredMoney,
    cash_manual_created: enteredMoney,
    card_actual: enteredMoney,
    card_manual_punched: enteredMoney,
    card_manual_created: enteredMoney,
    cash_reason: closeReasonSchema.default(''),
    card_reason: closeReasonSchema.default(''),
    cash_comment: z.string().trim().max(255).default(''),
    card_comment: z.string().trim().max(255).default(''),
    banking_amount: enteredMoney,
  })
  .strict();
export type CloseEntries = z.infer<typeof closeEntriesSchema>;
export interface CollectionSnapshot {
  order_count: number;
  cash: string;
  cash_refund: string;
  card_upi: string;
  district: string;
  online_other: string;
  total_online: string;
}
export interface ActiveClose {
  status: string;
  closed_at: string;
  version: number;
}

export function money(value: Decimal.Value | null | undefined): string {
  return new Decimal(value || 0).toFixed(2, Decimal.ROUND_HALF_EVEN);
}
export function cashDifference(
  system: Decimal.Value,
  refund: Decimal.Value,
  actual: Decimal.Value,
  punched: Decimal.Value,
  created: Decimal.Value,
): string {
  return money(new Decimal(system).minus(refund).minus(punched).plus(created).minus(actual));
}
export function cardDifference(
  system: Decimal.Value,
  actual: Decimal.Value,
  punched: Decimal.Value,
  created: Decimal.Value,
): string {
  return money(new Decimal(system).minus(punched).plus(created).minus(actual));
}
export function discrepancyErrors(
  snapshot: CollectionSnapshot,
  entries: CloseEntries,
  tolerance: string,
): string[] {
  const errors: string[] = [];
  let allowed: Decimal;
  try {
    allowed = new Decimal(tolerance);
  } catch {
    allowed = new Decimal(1);
  }
  for (const [difference, reason, comment, label] of [
    [
      cashDifference(
        snapshot.cash,
        snapshot.cash_refund,
        entries.cash_actual,
        entries.cash_manual_punched,
        entries.cash_manual_created,
      ),
      entries.cash_reason,
      entries.cash_comment,
      'cash',
    ],
    [
      cardDifference(
        snapshot.total_online,
        entries.card_actual,
        entries.card_manual_punched,
        entries.card_manual_created,
      ),
      entries.card_reason,
      entries.card_comment,
      'online',
    ],
  ] as const) {
    if (new Decimal(difference).abs().lte(allowed)) continue;
    if (!reason) errors.push(`Select a reason for the ${label} difference.`);
    else if (!comment) errors.push(`Add a comment on the ${label} difference.`);
  }
  return errors;
}
type WindowConfig = Pick<
  Config,
  | 'BUSINESS_TIMEZONE'
  | 'DAY_CLOSE_OPEN_TIME'
  | 'DAY_CLOSE_CUTOFF_TIME'
  | 'DAY_CLOSE_CUTOFF_DAYS'
  | 'DAY_CLOSE_NAG_EVENING_START'
  | 'DAY_CLOSE_NAG_MORNING_START'
>;
function timeSetting(value: string): Temporal.PlainTime {
  try {
    return Temporal.PlainTime.from(value);
  } catch {
    return Temporal.PlainTime.from('00:00');
  }
}
export function closeWindow(date: string, config: WindowConfig) {
  const day = Temporal.PlainDate.from(date);
  return {
    opensAt: day.toZonedDateTime({
      timeZone: config.BUSINESS_TIMEZONE,
      plainTime: timeSetting(config.DAY_CLOSE_OPEN_TIME),
    }),
    closesAt: day.add({ days: config.DAY_CLOSE_CUTOFF_DAYS }).toZonedDateTime({
      timeZone: config.BUSINESS_TIMEZONE,
      plainTime: timeSetting(config.DAY_CLOSE_CUTOFF_TIME),
    }),
  };
}
export function windowState(
  date: string,
  now: Temporal.Instant,
  config: WindowConfig,
): 'PENDING' | 'OPEN' | 'EXPIRED' {
  const { opensAt, closesAt } = closeWindow(date, config);
  return Temporal.Instant.compare(now, opensAt.toInstant()) < 0
    ? 'PENDING'
    : Temporal.Instant.compare(now, closesAt.toInstant()) > 0
      ? 'EXPIRED'
      : 'OPEN';
}
function legacyDateTime(time: Temporal.ZonedDateTime) {
  return `${String(time.day).padStart(2, '0')}-${String(time.month).padStart(2, '0')}-${time.year} ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
}
export function canClose(
  role: Role,
  date: string,
  now: Temporal.Instant,
  enabled: boolean,
  active: ActiveClose | null,
  config: WindowConfig,
): { allowed: boolean; override: 'REVISION' | 'WINDOW' | null; message: string } {
  if (!enabled)
    return {
      allowed: false,
      override: null,
      message: 'Day Close is not switched on for this store yet.',
    };
  const state = windowState(date, now, config),
    window = closeWindow(date, config);
  if (state === 'PENDING')
    return {
      allowed: false,
      override: null,
      message: `This day can be closed from ${legacyDateTime(window.opensAt)}.`,
    };
  const elevated = [1, 2, 3].includes(role),
    filed = active?.status === 'CLOSED';
  if (filed && !elevated) {
    const closed = Temporal.PlainDateTime.from(active.closed_at.replace(' ', 'T')).toZonedDateTime(
      config.BUSINESS_TIMEZONE,
    );
    return {
      allowed: false,
      override: null,
      message: `This day was already closed at ${legacyDateTime(closed)}. Only an OPM or above can revise it.`,
    };
  }
  if (state === 'EXPIRED' && !elevated)
    return {
      allowed: false,
      override: null,
      message: `The window for this day closed on ${legacyDateTime(window.closesAt)}. An OPM can still close it.`,
    };
  return {
    allowed: true,
    override: filed ? 'REVISION' : state === 'EXPIRED' ? 'WINDOW' : null,
    message: '',
  };
}
export function nagTargetDate(now: Temporal.Instant, config: WindowConfig): string | null {
  const current = now.toZonedDateTimeISO(config.BUSINESS_TIMEZONE),
    at = current.toPlainTime();
  if (Temporal.PlainTime.compare(at, timeSetting(config.DAY_CLOSE_NAG_EVENING_START)) >= 0)
    return current.toPlainDate().toString();
  if (
    Temporal.PlainTime.compare(at, timeSetting(config.DAY_CLOSE_NAG_MORNING_START)) >= 0 &&
    Temporal.PlainTime.compare(at, timeSetting(config.DAY_CLOSE_CUTOFF_TIME)) <= 0
  )
    return current.toPlainDate().subtract({ days: 1 }).toString();
  return null;
}
export function defaultCloseDate(now: Temporal.Instant, config: WindowConfig): string {
  const today = now.toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate();
  for (const offset of [0, 1]) {
    const day = today.subtract({ days: offset }).toString();
    if (windowState(day, now, config) === 'OPEN') return day;
  }
  return today.toString();
}
export function lastExpiredDate(now: Temporal.Instant, config: WindowConfig): string {
  let candidate = now
    .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
    .toPlainDate()
    .subtract({ days: config.DAY_CLOSE_CUTOFF_DAYS });
  for (let attempt = 0; attempt < 30; attempt++) {
    if (windowState(candidate.toString(), now, config) === 'EXPIRED') break;
    candidate = candidate.subtract({ days: 1 });
  }
  return candidate.toString();
}
export function snapshotDrift(
  close: {
    snap_order_count: number;
    cash_system: string;
    card_system: string;
    cash_refund_system: string;
  },
  snapshot: CollectionSnapshot,
): boolean {
  return (
    close.snap_order_count !== snapshot.order_count ||
    !new Decimal(close.cash_system).eq(snapshot.cash) ||
    !new Decimal(close.card_system).eq(snapshot.total_online) ||
    !new Decimal(close.cash_refund_system).eq(snapshot.cash_refund)
  );
}
