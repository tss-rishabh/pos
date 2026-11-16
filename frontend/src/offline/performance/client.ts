import { z } from 'zod';
import { ApiError, request } from '../../api/client';
import { requireCachedOperatorSession } from '../operator-session';
import {
  performanceValues,
  phaseNames,
  type PerformanceCommand,
  type PerformanceValues,
} from './contracts';

const receiptSchema = z
  .object({
    operationId: z.uuid(),
    checkoutId: z.uuid(),
    orderId: z.string().regex(/^[1-9]\d{0,18}$/),
    status: z.literal('recorded'),
    performance: performanceValues,
    recordedAt: z.iso.datetime(),
  })
  .strict();
export type PerformanceReceipt = z.infer<typeof receiptSchema>;
export interface PerformanceApi {
  read(command: PerformanceCommand, signal: AbortSignal): Promise<PerformanceReceipt | null>;
  write(command: PerformanceCommand, signal: AbortSignal): Promise<PerformanceReceipt>;
}
const endpoint = (command: PerformanceCommand) =>
  `/api/v1/stores/${encodeURIComponent(command.storeId)}/checkout-sessions/${encodeURIComponent(command.checkoutId)}/performance`;
async function call(command: PerformanceCommand, signal: AbortSignal, read: boolean) {
  if (!command.orderId || !command.receiptId)
    throw new Error('Only an existing paid sale can record performance.');
  await requireCachedOperatorSession(command.ownerId, command.storeId, signal);
  const result = await request(
    endpoint(command) + (read ? '/submissions/' + encodeURIComponent(command.operationId) : ''),
    {
      operatorId: command.ownerId,
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
      cache: 'no-store',
      ...(read
        ? {}
        : {
            method: 'POST',
            body: JSON.stringify({
              operationId: command.operationId,
              orderId: command.orderId,
              performance: command.performance,
            }),
          }),
    },
    receiptSchema,
  );
  await requireCachedOperatorSession(command.ownerId, command.storeId, signal);
  return result;
}
export const performanceApi: PerformanceApi = {
  async read(command, signal) {
    try {
      return await call(command, signal, true);
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.status === 404 &&
        cause.code === 'CHECKOUT_PERFORMANCE_NOT_FOUND'
      )
        return null;
      throw cause;
    }
  },
  write: (command, signal) => call(command, signal, false),
};
export function assertPerformanceReceipt(command: PerformanceCommand, raw: PerformanceReceipt) {
  const receipt = receiptSchema.parse(raw);
  const keys: readonly (keyof PerformanceValues)[] = [
    ...phaseNames,
    'overall_performance_time',
    'fast_payment',
  ];
  if (
    receipt.operationId !== command.operationId ||
    receipt.checkoutId !== command.checkoutId ||
    receipt.orderId !== command.orderId ||
    keys.some((key) => receipt.performance[key] !== command.performance[key])
  )
    throw new Error('The recorded timing does not match its original sale.');
  return receipt;
}
