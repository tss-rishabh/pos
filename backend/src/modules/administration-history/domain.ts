import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../config.js';
import type { AdministrationHistoryInput, AdministrationHistoryProjection } from './contracts.js';
import { administrationActorName, administrationChangeMessage } from './messages.js';

export const historyPageSize = 100;
const decimalStarts = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6,
  0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50,
  0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0,
  0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x11730,
  0x118e0, 0x11950, 0x11c50, 0x11d50, 0x11da0, 0x16a60, 0x16b50, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec,
  0x1d7f6, 0x1e140, 0x1e2f0, 0x1e950, 0x1fbf0,
];
/** Python int accepts decimal digits and internal underscores; malformed page values use the first page. */
export function sourceHistoryPageNumber(value: string | number): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  const source = value.replace(
    /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
    '',
  );
  let normalized = '';
  for (const character of source) {
    if (character === '+' || character === '-' || character === '_') normalized += character;
    else {
      const code = character.codePointAt(0)!,
        start = decimalStarts.find((first) => code >= first && code < first + 10);
      if (start === undefined) return null;
      normalized += String(code - start);
    }
  }
  return /^[+-]?\d(?:_?\d)*$/.test(normalized) ? BigInt(normalized.replaceAll('_', '')) : null;
}
export function sourceHistoryPage(value: string | number, total: bigint) {
  const pages = total === 0n ? 1n : (total + 99n) / 100n,
    requested = sourceHistoryPageNumber(value);
  const page = requested === null ? 1n : requested < 1n || requested > pages ? pages : requested;
  const start = (page - 1n) * 100n;
  return {
    page: page.toString(),
    pages: pages.toString(),
    start: start.toString(),
    count: Number(total - start < 100n ? total - start : 100n),
  };
}
export function historyReadScope(
  config: Pick<Config, 'BUSINESS_TIMEZONE'>,
  input: AdministrationHistoryInput,
  now: Temporal.Instant,
) {
  const today = now.toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate().toString();
  return {
    today,
    reader:
      input.from === today && input.to === today ? ('data-reader' as const) : ('bigquery' as const),
    from: input.from ? input.from + ' 00:00:00' : null,
    to:
      input.to && input.to !== '9999-12-31'
        ? Temporal.PlainDate.from(input.to).add({ days: 1 }).toString() + ' 00:00:00'
        : null,
  };
}
export function historyRecord(row: AdministrationHistoryProjection) {
  const message = administrationChangeMessage(row.changeMessage);
  return {
    id: row.id,
    actionTime: row.actionTime,
    actionTimeLabel: sourceHistoryDateLabel(row.actionTime),
    actorId: row.actorId,
    actor: administrationActorName(row.actorUsername, row.actorFirstName, row.actorLastName),
    actionFlag: row.actionFlag,
    action: message.text,
    messageState: message.state,
  };
}
/** Source USE_TZ=False/en-us DATETIME_FORMAT. Wall time is never interpreted in the browser's zone. */
export function sourceHistoryDateLabel(raw: string) {
  const value = Temporal.PlainDateTime.from(raw.replace(' ', 'T'));
  const months = [
    'Jan.',
    'Feb.',
    'March',
    'April',
    'May',
    'June',
    'July',
    'Aug.',
    'Sept.',
    'Oct.',
    'Nov.',
    'Dec.',
  ];
  const time =
    value.minute === 0 && value.hour === 0
      ? 'midnight'
      : value.minute === 0 && value.hour === 12
        ? 'noon'
        : String(value.hour % 12 || 12) +
          (value.minute ? ':' + String(value.minute).padStart(2, '0') : '') +
          (value.hour < 12 ? ' a.m.' : ' p.m.');
  return `${months[value.month - 1]} ${value.day}, ${value.year}, ${time}`;
}
