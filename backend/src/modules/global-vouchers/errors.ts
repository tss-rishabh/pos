import { AppError } from '../../domain/errors.js';
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
export const voucherUnconfirmed = () =>
  new AppError(
    409,
    'VOUCHER_OPERATION_UNCONFIRMED',
    'This voucher operation has not been confirmed. Check its result before retrying.',
  );
export const voucherToMoneyDisabled = () =>
  new AppError(403, 'VOUCHER_TO_MONEY_DISABLED', 'Gift voucher check and top-up is not enabled.');
