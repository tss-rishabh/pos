import { AppError } from '../../domain/errors.js';
export const voucherUnavailable = () =>
  new AppError(
    503,
    'GLOBAL_VOUCHERS_UNAVAILABLE',
    'Gift voucher compatibility and shared writer contracts must be configured.',
  );
export const voucherChanged = () =>
  new AppError(
    409,
    'GLOBAL_VOUCHER_SCOPE_CHANGED',
    'The customer or sale changed. Refresh before continuing.',
  );
export const voucherMissing = () =>
  new AppError(404, 'GLOBAL_VOUCHER_OPERATION_NOT_FOUND', 'The voucher operation was not found.');
export const voucherConflict = () =>
  new AppError(
    409,
    'IDEMPOTENCY_CONFLICT',
    'This operation reference belongs to different voucher details.',
  );
export const pinErrorCodes = [
  'GIFT_CARD_PIN_INVALID',
  'GIFT_CARD_PIN_LIMIT',
  'GIFT_CARD_PIN_REQUIRED',
] as const;
export type VoucherPinError = (typeof pinErrorCodes)[number];
export function voucherPinError(code: VoucherPinError) {
  return new AppError(
    code === 'GIFT_CARD_PIN_LIMIT' ? 429 : 422,
    code,
    code === 'GIFT_CARD_PIN_LIMIT'
      ? 'Too many incorrect PIN attempts. Try again later.'
      : code === 'GIFT_CARD_PIN_REQUIRED'
        ? 'Enter the gift card PIN.'
        : 'The gift card PIN is incorrect.',
  );
}
