import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../../domain/errors.js';

/** Schema-free leaves must not import the financial schema/crypto graph. */
export const importFinancialError = (code: string, status = 409) =>
  new AppError(
    status,
    code,
    'The original import needs review. Keep its operation reference; no new order or payment should be dispatched.',
  );
export function equalImportHash(left: string, right: string) {
  return (
    /^[a-f0-9]{64}$/.test(left) &&
    /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  );
}
