import { AppError } from '../../domain/errors.js';
import type { WholeOrderStatusRepository } from './repository.js';
import type { WholeOrderStatusTransport } from './transport.js';
export function wholeOrderStatusWorker(
  repository: WholeOrderStatusRepository,
  transport: WholeOrderStatusTransport,
) {
  return {
    async runOnce() {
      transport.configured();
      const row = await repository.claim();
      if (!row) return null;
      let dispatched = false;
      try {
        await repository.authorizeDispatch(row);
        dispatched = true;
        const receipt = await transport.send(row),
          state = await repository.complete(row, receipt);
        return {
          eventId: 'whole-order-status.dispatch',
          eventInstanceId: row.id,
          requestId: row.requestId ?? row.id,
          userId: row.operatorId,
          state,
        };
      } catch (error: unknown) {
        const notSent =
          !dispatched ||
          (error instanceof AppError && error.code === 'WHOLE_ORDER_STATUS_NOT_SENT');
        await repository.failure(row, notSent);
        return {
          eventId: 'whole-order-status.dispatch',
          eventInstanceId: row.id,
          requestId: row.requestId ?? row.id,
          userId: row.operatorId,
          state: notSent ? 'BLOCKED' : 'UNCERTAIN',
        };
      }
    },
  };
}
