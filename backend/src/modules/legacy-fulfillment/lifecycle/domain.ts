import { Temporal } from '@js-temporal/polyfill';
import { createHash } from 'node:crypto';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { providerRequest, type ProviderRequest } from './contracts.js';
export const movementContract = 'pos-local-delivery-movement-v1';
export function reconciliation() {
  return new AppError(
    409,
    'LOCAL_DELIVERY_RECONCILIATION_REQUIRED',
    'This delivery requires reconciliation before continuing.',
  );
}
export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function eventId(namespace: string, ...parts: string[]) {
  const hex = hash([namespace, ...parts]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function backupStores(raw: string): string[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length > 40) throw reconciliation();
  const result = parsed.map((value: unknown) =>
    identifier.parse(
      typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value,
    ),
  );
  if (new Set(result).size !== result.length) throw reconciliation();
  return result;
}
export function scheduleArrival(input: {
  now: Temporal.Instant;
  zone: string;
  orderStart: string | null;
  slotStart: string | null;
  cutoff: boolean;
  cutoffTime: string;
  bufferSeconds: number;
}) {
  if (!input.orderStart || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(input.orderStart))
    throw reconciliation();
  const now = input.now.toZonedDateTimeISO(input.zone),
    start = sourceDateTime(input.orderStart),
    date =
      Temporal.PlainDate.compare(start.toPlainDate(), now.toPlainDate()) > 0
        ? start.toPlainDate()
        : now.toPlainDate(),
    slot = input.slotStart
      ? date.toPlainDateTime(Temporal.PlainTime.from(input.slotStart)).toZonedDateTime(input.zone)
      : null,
    seconds = (target: Temporal.ZonedDateTime) =>
      Math.trunc(Number(target.epochNanoseconds - now.epochNanoseconds) / 1e9),
    advance = !!slot && Temporal.ZonedDateTime.compare(slot, now) > 0,
    notificationAt = advance
      ? now.epochMilliseconds + Math.max(0, seconds(slot!)) * 1000
      : now.epochMilliseconds,
    cutoffAt = date
      .toPlainDateTime(Temporal.PlainTime.from(input.cutoffTime))
      .toZonedDateTime(input.zone),
    transferSeconds = input.cutoff
      ? seconds(cutoffAt)
      : input.bufferSeconds + (advance ? seconds(slot!) : 0);
  if (
    !Number.isSafeInteger(input.bufferSeconds) ||
    input.bufferSeconds < 0 ||
    input.bufferSeconds > 604800
  )
    throw reconciliation();
  return {
    advance,
    successTimestamp: advance
      ? slot!.toPlainDateTime().toString({ smallestUnit: 'second' }).replace('T', ' ')
      : null,
    notificationAt,
    transferAt: now.epochMilliseconds + Math.max(0, transferSeconds) * 1000,
    weekday: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'][date.dayOfWeek - 1]!,
  };
}
export function sourceDateTime(value: string) {
  try {
    return Temporal.PlainDateTime.from(value.replace(' ', 'T'));
  } catch {
    throw reconciliation();
  }
}
export function passDecision(input: {
  nextStoreIds: string[];
  isTransferred: boolean;
  automatic: boolean;
  cutoff: boolean;
}) {
  return !input.isTransferred && input.nextStoreIds.length > 0 && !(input.cutoff && input.automatic)
    ? ('transfer' as const)
    : ('convert' as const);
}
export function providerRequestHash(request: ProviderRequest) {
  // Native MySQL JSON reorders object keys. Validate/rebuild the DTO before hashing.
  return hash(providerRequest.parse(request));
}
