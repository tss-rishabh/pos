import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { wholeOrderStatusReceiver } from './receiver.js';
import { registerWholeOrderStatusReceiver } from './receiver-routes.js';
import { readWholeOrderStatusOptions, type WholeOrderStatusOptions } from './options.js';
import { readStatusReceiverOptions, type StatusReceiverOptions } from './receiver-options.js';
import { registerStatusWorkerLoop } from './background.js';
/** Explicit opt-in qualified replacement profile, sharing the original writer/schema. */
export async function registerQualifiedWholeOrderStatusReceiver(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: WholeOrderStatusOptions = readWholeOrderStatusOptions(),
  receiverOptions: StatusReceiverOptions = readStatusReceiverOptions(),
  dependencies: Parameters<typeof wholeOrderStatusReceiver>[4] = {},
) {
  const receiver = wholeOrderStatusReceiver(config, db, options, receiverOptions, {
    ...dependencies,
    event: (value) => {
      app.log.info(value, 'Whole-order STORE worker result.');
      dependencies.event?.(value);
    },
  });
  await registerWholeOrderStatusReceiver(app, options, receiver);
  if (receiverOptions.WHOLE_ORDER_STATUS_RECEIVER_WORKER_ENABLED)
    registerStatusWorkerLoop(
      app,
      'store-status-worker',
      async () => {
        await receiver.expireClaims();
        return (await receiver.runOnce()) !== null;
      },
      receiver.ready,
    );
  return receiver;
}
