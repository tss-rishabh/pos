import { AppError } from '../../../domain/errors.js';
export const detailUnavailable = () =>
  new AppError(404, 'ORDER_NOT_FOUND', 'Order not found in this store and order type.');
export const detailInvalid = () =>
  new AppError(
    503,
    'ORDER_DETAIL_DATA_INVALID',
    'Complete order details are temporarily unavailable.',
  );
