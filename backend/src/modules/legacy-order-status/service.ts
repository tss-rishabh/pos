import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { wholeOrderStatusRepository, publicStatusCommand } from './repository.js';
import { readWholeOrderStatusOptions, type WholeOrderStatusOptions } from './options.js';
import { wholeOrderStatusTransport, type WholeOrderStatusTransport } from './transport.js';
import { wholeOrderStatusWorker } from './worker.js';
import { rejectedReturnRepairs } from './repair-obligations.js';
export function wholeOrderStatusService(
  config: Config,
  db: Databases,
  options: WholeOrderStatusOptions = readWholeOrderStatusOptions(),
  dependencies: {
    transport?: WholeOrderStatusTransport;
    clock?: () => number;
  } = {},
) {
  const repository = wholeOrderStatusRepository(config, db, dependencies.clock),
    transport = dependencies.transport ?? wholeOrderStatusTransport(config, options);
  const configured = () => {
    transport.configured();
  };
  const repairs = rejectedReturnRepairs(config, db, repository, {
    enabled: options.WHOLE_ORDER_STATUS_WORKER_ENABLED && !config.DEMO_MODE,
    configured,
    clock: dependencies.clock,
    readReceipt: (row) => transport.read(row),
  });
  return {
    configured,
    repairs,
    repository,
    worker: wholeOrderStatusWorker(repository, transport),
    async submit(
      user: Principal,
      storeId: string,
      orderId: string,
      input: unknown,
      requestId?: string,
    ) {
      configured();
      return repository.submit(user, storeId, orderId, input, requestId);
    },
    async repair(
      user: Principal,
      storeId: string,
      orderId: string,
      input: { operationId: string; returnOperationId: string },
      requestId?: string,
    ) {
      return repository.repair(user, storeId, orderId, input, requestId);
    },
    async status(user: Principal, storeId: string, orderId: string) {
      const value = await repository.status(user, storeId, orderId);
      let adapterReady = true;
      try {
        configured();
      } catch {
        adapterReady = false;
      }
      return { ...value, adapterReady };
    },
    async read(user: Principal, storeId: string, orderId: string, id: string) {
      const initial = await repository.recoveryContext(user, storeId, orderId, id);
      if (['SENDING', 'UNCERTAIN', 'QUEUED'].includes(initial.row.state)) {
        const receipt = await transport.read(initial.row),
          fresh = await repository.recoveryContext(user, storeId, orderId, id);
        if (fresh.binding !== initial.binding)
          throw new AppError(
            403,
            'WHOLE_ORDER_STATUS_SCOPE_CHANGED',
            'Your status-viewing permissions changed.',
          );
        // A missing remote receipt never proves an in-flight request was not sent.
        if (receipt) await repository.complete(fresh.row, receipt);
      }
      return repository.read(user, storeId, orderId, id);
    },
    publicStatusCommand,
  };
}
export type WholeOrderStatusService = ReturnType<typeof wholeOrderStatusService>;
