import Hashids from 'hashids';
import { AppError } from '../../domain/errors.js';
import type { CheckoutRepository } from './contracts.js';

export const giftCardAlphabet = 'abcdefghjkmnpqrstuvwxyz1234567890';
export function giftCardCode(serial: string, salt: string | undefined): string {
  if (!salt)
    throw new AppError(
      503,
      'GIFT_CARD_ISSUANCE_UNAVAILABLE',
      'Gift card issuance is not configured.',
    );
  return 'GC' + new Hashids(salt, 14, giftCardAlphabet).encode(BigInt(serial));
}
export function decodeGiftCardSerial(raw: string): {
  serial: string;
  collectionId: string;
  serialDigits: string;
} {
  const serial = raw.replaceAll('_', '');
  if (!/^\d{6,32}$/.test(serial))
    throw new AppError(422, 'INVALID_GIFT_CARD_SERIAL', 'Invalid No.(Validation Err 01)');
  const zero = serial.indexOf('0');
  if (zero < 0)
    throw new AppError(422, 'INVALID_GIFT_CARD_SERIAL', 'Invalid No.(Validation Err 01)');
  const before = serial.slice(0, zero),
    after = serial.slice(zero + 1);
  if (before.length < 2)
    throw new AppError(422, 'INVALID_GIFT_CARD_SERIAL', 'Invalid No.(Validation Err 02)');
  if (!before.slice(-2).startsWith('9') || after.length < 3)
    throw new AppError(422, 'INVALID_GIFT_CARD_SERIAL', 'Invalid No.(Validation Err 03)');
  const collectionLength = Number(after[0]);
  if (!collectionLength || after.length <= collectionLength + 1)
    throw new AppError(422, 'INVALID_GIFT_CARD_SERIAL', 'Invalid No.(Validation Err 03)');
  return {
    serial,
    collectionId: String(BigInt(after.slice(-collectionLength))),
    serialDigits: after.slice(1, -collectionLength),
  };
}
export async function validateGiftCardSerial(
  repository: CheckoutRepository,
  raw: string,
  salt: string | undefined,
) {
  const parsed = decodeGiftCardSerial(raw),
    collection = await repository.giftCardCollection(parsed.collectionId);
  if (BigInt(parsed.serial) > 9223372036854775807n)
    throw new AppError(
      422,
      'INVALID_GIFT_CARD_SERIAL',
      'This card number exceeds the verified storage limit.',
    );
  if (!collection)
    throw new AppError(422, 'INVALID_GIFT_CARD_COLLECTION', 'Invalid No.(Validation Err 07)');
  if (collection.blocked)
    throw new AppError(
      422,
      'GIFT_CARD_COLLECTION_BLOCKED',
      'Collection is blocked.(Validation Err 04)',
    );
  if (!collection.printed)
    throw new AppError(
      422,
      'GIFT_CARD_COLLECTION_UNPRINTED',
      'Collection not printed yet.(Validation Err 05)',
    );
  if (
    !Number.isSafeInteger(collection.size) ||
    collection.size < 1 ||
    !/^[1-9]\d*$/.test(parsed.serialDigits) ||
    BigInt(parsed.serialDigits) > BigInt(collection.size)
  )
    throw new AppError(422, 'INVALID_GIFT_CARD_SERIAL', 'Invalid No.(Validation Err 06)');
  if (!(await repository.giftCardAvailable(giftCardCode(parsed.serial, salt))))
    throw new AppError(
      409,
      'GIFT_CARD_ALREADY_ISSUED',
      'This card is already issued. Use another card.',
    );
  return parsed.serial;
}
