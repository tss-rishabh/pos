import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { scalarId } from './report-inputs.js';
import { pythonRound2 } from '../../domain/python-compat.js';
import { pythonFloatString } from './number-format.js';
import { slackText } from '../fulfillment/slack-text.js';
export const scheduledKind = z.enum([
  'hyperlocal-performance',
  'hyperlocal-summary',
  'hyperlocal-availability',
  'hyperlocal-store-status',
  'hyperlocal-delivery-delays',
  'hyperlocal-cancellations',
  'crm-tickets',
]);
export type ScheduledKind = z.infer<typeof scheduledKind>;
export const weekday = z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
export const scheduleDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    try {
      return Temporal.PlainDate.from(value).year >= 1000;
    } catch {
      return false;
    }
  }, 'Use a valid calendar date.');
export const scheduleInput = z
  .object({
    kind: scheduledKind,
    date: scheduleDate.optional(),
    previousDays: z.number().int().min(1).max(62).default(1),
    sendToSlack: z.boolean().default(true),
    includeCompleted: z.boolean().default(false),
  })
  .strict();
export type ScheduleInput = z.infer<typeof scheduleInput>;
export interface ScheduledMessage {
  target: 'main' | 'demo';
  text: string;
}
export interface ScheduledArtifact {
  messages: ScheduledMessage[];
  recordCount: number;
}
export interface SlotFact {
  id: string;
  storeId: string;
  weekday: z.infer<typeof weekday>;
  available: boolean;
  start: string;
  end: string;
}
export interface StoreFact {
  id: string;
  name: string;
  type: string;
}
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function scheduleLabel(date: string) {
  const value = Temporal.PlainDate.from(date);
  return `${String(value.day).padStart(2, '0')} ${months[value.month - 1]} ${value.year}`;
}
export function scheduleWeekday(date: string) {
  return weekday.options[Temporal.PlainDate.from(date).dayOfWeek - 1]!;
}
const pad = (value: number) => String(value).padStart(2, '0'),
  text = (value: string | null) => slackText(value ?? 'None');
const icons = {
  chart: '\u{1f4ca}',
  store: '\u{1f3ea}',
  accepted: '\u2705',
  declined: '\u274c',
  no: '\u{1f6ab}',
  total: '\u{1f4c8}',
  convert: '\u{1f504}',
  shine: '\u2728',
  package: '\u{1f4e6}',
  rocket: '\u{1f680}',
  decline: '\u{1f4c9}',
  building: '\u{1f3ec}',
  id: '\u{1f194}',
  date: '\u{1f4c5}',
  pin: '\u{1f4cc}',
  comment: '\u{1f4ac}',
};
function targets(text: string, demoOnly = false): ScheduledMessage[] {
  return [...(demoOnly ? [] : [{ target: 'main' as const, text }]), { target: 'demo', text }];
}
export interface TimingFact {
  orderId: string;
  createdAt: string;
  storeId: string | null;
  storeName: string | null;
  acceptedAt: string;
}
export function adjustedAcceptanceSeconds(row: TimingFact, slots: readonly SlotFact[]) {
  const start = Temporal.PlainDateTime.from(row.createdAt.replace(' ', 'T')),
    end = Temporal.PlainDateTime.from(row.acceptedAt.replace(' ', 'T')),
    slot = slots.findLast(
      (value) =>
        value.storeId === row.storeId &&
        value.weekday === scheduleWeekday(end.toPlainDate().toString()),
    );
  if (!slot) return 0;
  const opening = start.toPlainDate().toPlainDateTime(Temporal.PlainTime.from(slot.start)),
    effective = Temporal.PlainDateTime.compare(start, opening) < 0 ? opening : start;
  return end.since(effective, { largestUnit: 'days' }).total('seconds');
}
export function performanceMessages(
  date: string,
  rows: readonly TimingFact[],
  slots: readonly SlotFact[],
): ScheduledArtifact {
  let output = `Store Hyperlocal Performance - ${scheduleLabel(date)}\n-------------------------------------------\n`;
  if (!rows.length)
    return { messages: targets(output + 'There is no order yesterday', true), recordCount: 0 };
  const stores = new Map<string | null, { min: number; max: number }>();
  for (const row of rows) {
    const seconds = adjustedAcceptanceSeconds(row, slots),
      value = stores.get(row.storeName);
    stores.set(row.storeName, {
      min: Math.min(value?.min ?? seconds, seconds),
      max: Math.max(value?.max ?? seconds, seconds),
    });
  }
  const duration = (raw: number) => {
    const seconds = Math.trunc(raw),
      hours = Math.floor(seconds / 3600),
      rest = seconds - hours * 3600,
      minutes = Math.floor(rest / 60);
    return `${hours}H ${minutes}M ${rest - minutes * 60}S`;
  };
  output += '\n';
  for (const [name, values] of stores)
    output += `${text(name)} - ${duration(values.min)} - ${duration(values.max)}\n`;
  return { messages: targets(output), recordCount: rows.length };
}
export function storeStatusMessages(
  date: string,
  stores: readonly StoreFact[],
  slots: readonly SlotFact[],
): ScheduledArtifact {
  const eligible = stores.filter(
      (value) => value.id !== '1' && ['STORE', 'CORE_WAREHOUSE'].includes(value.type),
    ),
    configured = slots.filter(
      (value) => value.storeId !== '1' && value.weekday === scheduleWeekday(date),
    ),
    mapped = new Map(eligible.map((value) => [value.id, value])),
    closed = configured.filter((value) => !value.available && mapped.has(value.storeId));
  let output = `${icons.shine} *Stores Availability Status - ${scheduleLabel(date)}* ${icons.shine}\n----------------------------------------------\n- *Total stores eligible for hyperlocal configuration:* \`${eligible.length}\`\n- *Stores successfully configured for hyperlocal orders:* \`${configured.length}\`\n- *Stores pending hyperlocal configuration:* \`${eligible.length - configured.length}\`\n- *Stores currently closed for hyperlocal operations:* \`${closed.length}\`\n- *Stores open and accepting hyperlocal orders today:* \`${configured.length - closed.length}\`\n\n`;
  output += closed.length
    ? `${icons.no} *The following stores are CLOSED for hyperlocal orders today:*\n` +
      closed
        .map((value, index) => `${index + 1}. ${slackText(mapped.get(value.storeId)!.name)}\n`)
        .join('')
    : `${icons.accepted} *All stores are OPEN for hyperlocal orders today.*\n`;
  return { messages: [{ target: 'main', text: output }], recordCount: configured.length };
}
export interface SummaryFact {
  orderId: string;
  storeId: string;
  action: string;
  isTransfer: boolean;
  mainStoreId: string | null;
  nextStoreIds: string[];
}
export function summaryMessages(
  date: string,
  rows: readonly SummaryFact[],
  stores: readonly StoreFact[],
  slots: readonly SlotFact[],
): ScheduledArtifact {
  const counts = new Map<
      string,
      { accepted: number; decline: number; converted: number; nonConverted: number }
    >(),
    fresh = () => ({ accepted: 0, decline: 0, converted: 0, nonConverted: 0 });
  let acceptedTotal = 0,
    convertedTotal = 0,
    nonConvertedTotal = 0;
  const decline = (id: string) => {
    const value = counts.get(id) || fresh();
    value.decline++;
    counts.set(id, value);
  };
  for (const row of rows) {
    const delta = fresh();
    if (row.action === 'ACCEPTED') {
      acceptedTotal++;
      delta.accepted++;
      if (row.isTransfer && row.mainStoreId && row.mainStoreId !== '0') decline(row.mainStoreId);
    } else if (row.action === 'CONVERT_ONLINE') {
      convertedTotal++;
      delta.converted++;
      delta.decline++;
      if (row.isTransfer) row.nextStoreIds.forEach(decline);
    } else if (row.action === 'DECLINED') {
      nonConvertedTotal++;
      delta.nonConverted++;
      delta.decline++;
      if (row.isTransfer) row.nextStoreIds.forEach(decline);
    }
    const value = counts.get(row.storeId) || fresh();
    for (const key of ['accepted', 'decline', 'converted', 'nonConverted'] as const)
      value[key] += delta[key];
    counts.set(row.storeId, value);
  }
  let output = `*${icons.chart} Store-wise Order Summary & Acceptance Stats - ${scheduleLabel(date)}:*\n---------------------------------------------------------------------------\n`;
  const names = new Map(stores.map((value) => [value.id, value.name]));
  for (const slot of slots.filter(
    (value) => value.weekday === scheduleWeekday(date) && value.storeId !== '1',
  )) {
    const value = counts.get(slot.storeId) || fresh();
    if (value.accepted > 0 || value.decline > 0) {
      const rate = (value.accepted / (value.accepted + value.decline)) * 100;
      output += `*${icons.store} ${slackText(names.get(slot.storeId) || '')}*\n   ${icons.accepted} Accepted: \` ${value.accepted} \` |  ${icons.declined} Declined: \` ${value.decline}\` |  ${icons.chart} Acceptance Rate: *${rate.toFixed(2)}%* ${rate <= 0 ? icons.no : ''}\n\n\n`;
    }
  }
  const total = acceptedTotal + convertedTotal + nonConvertedTotal,
    rate = total ? (acceptedTotal / total) * 100 : 0;
  output += `------------------------------------------------\n*${icons.total} Total Orders:* \` ${total} \`\n*${icons.accepted} Accepted Orders:* \` ${acceptedTotal} \`\n*${icons.convert} Converted Orders:* \` ${convertedTotal} \`\n*${icons.declined} Conversion Failed:* \` ${nonConvertedTotal} \`\n\n*${icons.chart} Overall Accepted Rate:* *${rate.toFixed(2)}%*\n`;
  return { messages: [{ target: 'main', text: output }], recordCount: rows.length };
}
export interface AvailabilityFact {
  orderId: string;
  cartType: string;
  stockThreshold: string;
  storeAvailability: string;
  slotVisible: boolean;
  isApp: boolean;
  slotGroup?: string;
}
export interface OrderPlatformFact {
  orderId: string;
  isApp: boolean;
}
export function availabilityMessages(
  date: string,
  rows: readonly AvailabilityFact[],
  orders: readonly OrderPlatformFact[],
): ScheduledArtifact {
  const legacyGroups = new Map<string, number>();
  for (const row of rows) {
    const key = JSON.stringify([
        row.cartType,
        row.stockThreshold,
        row.storeAvailability,
        row.slotGroup ?? String(Number(row.slotVisible)),
      ]),
      before = legacyGroups.get(key),
      bytes =
        (before ?? 0) +
        (before === undefined ? 0 : 1) +
        Buffer.byteLength(BigInt(row.orderId).toString());
    if (bytes > 100000)
      throw new AppError(
        503,
        'LEGACY_REPORT_RECONCILIATION_REQUIRED',
        'Report source groups require reconciliation before delivery.',
      );
    legacyGroups.set(key, bytes);
  }
  let buffer = 0,
    mixed = 0,
    valid = 0,
    invalid = 0;
  const validOrders = new Map<string, boolean>();
  for (const row of rows) {
    if (
      row.cartType === 'VALID' &&
      row.storeAvailability === 'NOT_GUILTY' &&
      row.stockThreshold === 'NOT_GUILTY' &&
      row.slotVisible
    ) {
      valid++;
      validOrders.set(row.orderId, row.isApp);
    } else if (['VALID', 'MIXED'].includes(row.cartType) && row.stockThreshold === 'GUILTY')
      buffer++;
    else if (row.cartType === 'VALID' && row.storeAvailability === 'GUILTY') {
    } else if (row.cartType === 'MIXED' && row.stockThreshold === 'NOT_GUILTY') mixed++;
    else if (row.cartType === 'INVALID') invalid++;
  }
  const all = new Map(orders.map((row) => [row.orderId, row.isApp])),
    app = [...all.values()].filter(Boolean).length,
    validApp = [...validOrders.values()].filter(Boolean).length,
    optin = valid ? pythonRound2((all.size / valid) * 100) : 0,
    output = `${icons.shine} *Hyperlocal Conversion Stats - ${scheduleLabel(date)}* ${icons.shine}\n---------------------------------------------------\n${icons.no} *Orders not eligible for express delivery:* \`${invalid}\`\n${icons.convert} *Mixed orders not eligible for express delivery:* \`${mixed}\`\n${icons.decline} *Valid/Mixed orders not eligible because of buffer inventory:* \`${buffer}\`\n\n${icons.rocket} *Express delivery option shown to customers (A):* \`${valid}\` | *APP:* \`${validApp}\` | *WEB:* \`${validOrders.size - validApp}\`\n${icons.package} *Total hyperlocal orders received (B):* \`${all.size}\` | *APP:* \`${app}\` | *WEB:* \`${all.size - app}\`\n${icons.chart} *Opt-in rate (B/A):* \`${valid ? pythonFloatString(optin) : '0'}%\`\n\n`;
  return { messages: [{ target: 'main', text: output }], recordCount: rows.length };
}
export interface DelayFact {
  orderId: string;
  totalDelay: string;
}
export function delayMessages(date: string, rows: readonly DelayFact[]): ScheduledArtifact {
  let output = `Borzo delivery issues - ${scheduleLabel(date)}\n-------------------------------------------\n`;
  if (!rows.length)
    return { messages: targets(output + 'There is no delay in delivery', true), recordCount: 0 };
  output += '\nOrder ID   \u2502 Total Delay      \n';
  for (const row of rows) {
    const parsed = /^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(row.totalDelay);
    if (!parsed)
      throw new AppError(
        503,
        'REPORT_DATA_INVALID',
        'Some delivery delay values could not be processed.',
      );
    const delay = Number(parsed[1]) ? `${parsed[1]}:${parsed[2]} hours` : `${parsed[2]} minutes`;
    output += `${row.orderId.padEnd(11)}| ${delay.padEnd(17)}\n`;
  }
  return { messages: targets(output + '\n'), recordCount: rows.length };
}
export interface CancellationFact {
  storeName: string | null;
  orderId: string;
  reason: string | null;
  comment: string | null;
  convertedAt: string;
}
export function cancellationMessages(
  date: string,
  rows: readonly CancellationFact[],
): ScheduledArtifact {
  let output = `${icons.shine} *Hyperlocal Daily Cancellation (Convert Online) - ${scheduleLabel(date)}* ${icons.shine}\n-----------------------------------------------------------\n`;
  if (!rows.length) output += 'There is no cancellation in hyperlocal orders';
  else {
    output += '\n';
    for (const row of rows)
      output += `${icons.building} *Store Name:* ${text(row.storeName)}\n${icons.id} *Order ID:* ${row.orderId}  |  ${icons.date} *Date:* ${row.convertedAt.replace('T', ' ')} \n${icons.pin} *Dropdown Selected:* ${text(row.reason)}\n${icons.comment} *Comment:* ${text(row.comment)}\n\n`;
    output += '\n';
  }
  return { messages: [{ target: 'main', text: output }], recordCount: rows.length };
}
export interface CrmFact {
  orderId: string | null;
  ticketId: string;
  status: string;
  createdAt: string;
}
export function crmAge(createdAt: string, now: Temporal.Instant) {
  const created = Temporal.Instant.from(createdAt),
    milliseconds = Number(now.epochMilliseconds - created.epochMilliseconds),
    days = Math.floor(milliseconds / 86400000),
    remainder = milliseconds - days * 86400000,
    hours = Math.floor(remainder / 3600000),
    minutes = Math.floor((remainder % 3600000) / 60000);
  return {
    milliseconds: String(Math.trunc(milliseconds)),
    label: `${days ? days + 'D ' : ''}${hours}H ${pad(minutes)}M`,
  };
}
export function crmMessages(
  date: string,
  previousDays: number,
  sendToSlack: boolean,
  includeCompleted: boolean,
  rows: readonly CrmFact[],
  now: Temporal.Instant,
): ScheduledArtifact {
  if (!sendToSlack) return { messages: [], recordCount: rows.length };
  const header = `CRM Hyperlocal open tickets - ${scheduleLabel(date)}\n-----------------------------------------------------\n`,
    selected = rows.filter((row) => includeCompleted || row.status !== 'CLOSED');
  if (!selected.length)
    return {
      messages: targets(header + `There is no open ticket for last ${previousDays} days`, true),
      recordCount: rows.length,
    };
  let output =
    header + '\nOrder ID   \u2502 Ticket ID  \u2502 Status           \u2502 Ticket Age  \n';
  for (const row of selected)
    output += `${(row.orderId ?? 'None').padEnd(11)}| ${row.ticketId.padEnd(11)}| ${row.status.padEnd(17)}| ${crmAge(row.createdAt, now).label.padEnd(12)}\n`;
  return { messages: targets(output + '\n'), recordCount: rows.length };
}
/** Native JSON reviver source text retains long IDs in legacy next_location_ids arrays. */
export function nextStoreIds(value: string | null) {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(
      value,
      (_key: string, item: unknown, context?: { source?: string }) =>
        typeof item === 'number' && context?.source && /^\d+$/.test(context.source)
          ? context.source
          : item,
    );
    return z
      .array(z.union([identifier, z.literal('0')]))
      .max(1000)
      .parse(parsed);
  } catch {
    throw new AppError(
      503,
      'REPORT_DATA_INVALID',
      'Some transfer store identifiers could not be processed.',
    );
  }
}
export const scheduleScalar = scalarId;
