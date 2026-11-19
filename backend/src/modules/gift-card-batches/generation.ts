import { randomInt } from 'node:crypto';
import Hashids from 'hashids';
import { AppError } from '../../domain/errors.js';
import { giftCardAlphabet } from '../checkout/gift-cards.js';

export const giftCardCsvHeaders = ['Collection No', 'Serial No', 'Gift Card', 'Pin'] as const;
export const maxGiftCardArchiveBytes = 2 * 1024 * 1024;
export type RandomInteger = (minimum: number, maximum: number) => number;
export interface GeneratedGiftCard {
  collectionId: string;
  serial: string;
  code: string;
  pin: string;
}
export function sourceGiftCardPin(serial: string): string {
  if (!/^\d{6,32}$/.test(serial))
    throw new AppError(400, 'GIFT_CARD_SERIAL_INVALID', 'Gift card serial is invalid.');
  const reversed = Number(serial.slice(0, 2)).toString(8).slice(0, 2).split('').reverse().join('');
  let first = String(Number(reversed + serial.slice(2, 4)) - serial.length);
  if (first.length < 4) first += '0';
  const last = Number(first.slice(0, 1) + first.slice(-1))
    .toString(8)
    .slice(0, 2);
  return (first + last).slice(0, 6);
}
/** Source serial layout and deterministic legacy PIN. No voucher/balance/funding rows are created here. */
export function generateGiftCards(
  collectionId: string,
  size: number,
  salt: string,
  integer: RandomInteger = (min, max) => randomInt(min, max + 1),
): GeneratedGiftCard[] {
  if (
    !/^[1-9]\d{0,8}$/.test(collectionId) ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 10000 ||
    !salt
  )
    throw new AppError(
      503,
      'GIFT_CARD_BATCH_FORMAT_UNSUPPORTED',
      'This batch cannot use the verified gift card format.',
    );
  const hasher = new Hashids(salt, 14, giftCardAlphabet),
    cards: GeneratedGiftCard[] = [];
  const draw = (min: number, max: number) => {
    const value = integer(min, max);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new AppError(
        503,
        'GIFT_CARD_RANDOM_SOURCE_INVALID',
        'Gift card generation is unavailable.',
      );
    return value;
  };
  for (let index = 1; index <= size; index++) {
    const suffix = String(draw(91, 99)) + '0' + collectionId.length + index + collectionId;
    const length = Math.max(14, suffix.length),
      padding = length - suffix.length;
    const prefix = padding
      ? String(draw(10 ** (padding - 1), 10 ** padding - 1)).replaceAll('0', '9')
      : '';
    const serial = prefix + suffix;
    if (BigInt(serial) > 9223372036854775807n)
      throw new AppError(
        503,
        'GIFT_CARD_BATCH_FORMAT_UNSUPPORTED',
        'This batch cannot use the verified gift card format.',
      );
    const code = 'GC' + hasher.encode(BigInt(serial)).toUpperCase();
    if (code.length > 25)
      throw new AppError(
        503,
        'GIFT_CARD_BATCH_FORMAT_UNSUPPORTED',
        'This batch cannot use the verified gift card format.',
      );
    cards.push({ collectionId, serial, code, pin: sourceGiftCardPin(serial) });
  }
  return cards;
}
export function giftCardCsv(cards: readonly GeneratedGiftCard[]): Buffer {
  const text =
    [
      giftCardCsvHeaders.join(','),
      ...cards.map((card) => [card.collectionId, card.serial, card.code, card.pin].join(',')),
    ].join('\r\n') + '\r\n';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > maxGiftCardArchiveBytes)
    throw new AppError(503, 'GIFT_CARD_BATCH_CAPACITY', 'Choose a smaller gift card batch.');
  return bytes;
}
/**
 * `Helpers.clean_email` (helpers/helpers.py:1418-1431): strip one `pos.`/`emp.` prefix (every
 * occurrence, as `str.replace` does), digit runs when the address starts with a digit, then a
 * leading dot. Legacy raises IndexError on an empty result; this returns ''.
 */
export function giftCardRecipient(email: string | null): string {
  let value = email || '';
  if (!value) return '';
  for (const prefix of ['pos.', 'emp.'])
    if (value.startsWith(prefix)) {
      value = value.replaceAll(prefix, '');
      break;
    }
  if (/^\p{Nd}/u.test(value)) value = value.replace(/(^|[^\p{L}\p{N}_])\p{Nd}+/gu, '');
  if (value.startsWith('.')) value = value.slice(1);
  return value;
}
/**
 * Legacy archive password (helpers/helpers.py:1345-1350): `'123456' + collection_no`, or the
 * last six characters of the creator's phone + collection_no when the phone is set.
 * User-mandated (AGENTS.md, 19 November 2026) although it is weak and predictable.
 */
export function giftCardArchivePassword(phone: string | null, collectionId: string): string {
  return (phone ? phone.slice(-6) : '123456') + collectionId;
}
/**
 * Legacy file name (helpers/helpers.py:1323-1340): `GFTCRDS-` + str(datetime.now().timestamp())
 * without the dot + six random digits 1-9. Returns the CSV entry name and the storage key
 * `uploads/csv/giftcards/GFTCRDS-….zip` written to gift_card_collection.filename.
 */
export function giftCardArchiveNames(
  epochMicroseconds: bigint,
  integer: RandomInteger = (min, max) => randomInt(min, max + 1),
) {
  const seconds = epochMicroseconds / 1_000_000n,
    fraction = (epochMicroseconds % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  let random = '';
  for (let index = 0; index < 6; index++) random += String(integer(1, 9));
  const stem = 'GFTCRDS-' + seconds.toString() + (fraction || '0') + random;
  return { entry: stem + '.csv', key: 'uploads/csv/giftcards/' + stem + '.zip' };
}
