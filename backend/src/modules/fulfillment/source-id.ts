import { AppError } from '../../domain/errors.js';
/** Verified signed INT fields use explicit bounds; BIGINT fields must keep BigInt/string IDs. */
export function sourceIntId(value: string): number {
  if (!/^\d+$/.test(value))
    throw new AppError(
      400,
      'INVALID_IDENTIFIER',
      'This identifier is outside the source table range.',
    );
  const id = BigInt(value);
  if (id < 1n || id > 2147483647n)
    throw new AppError(
      400,
      'INVALID_IDENTIFIER',
      'This identifier is outside the source table range.',
    );
  return Number(id);
}
