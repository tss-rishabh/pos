import type { FastifyInstance } from 'fastify';
/** Bounded background work; errors emit a static event and never an SDK/error object. */
export function registerStatusWorkerLoop(
  app: FastifyInstance,
  resource: string,
  run: () => Promise<boolean>,
  prepare: () => void,
) {
  let timer: ReturnType<typeof setInterval> | undefined,
    running: Promise<void> | undefined,
    closing = false;
  const tick = () => {
    if (running || closing) return;
    const runId = crypto.randomUUID();
    running = (async () => {
      try {
        for (let count = 0; count < 10 && !closing; count++) if (!(await run())) break;
      } catch {
        app.log.error(
          {
            module: 'whole-order-status',
            resource,
            eventId: `whole-order-status.${resource}.worker-failure`,
            eventInstanceId: runId,
            requestId: runId,
            userId: null,
            errorCode: 'STATUS_WORKER_FAILED',
          },
          'Status worker needs attention.',
        );
      }
    })().finally(() => {
      running = undefined;
    });
  };
  app.addHook('onReady', async () => {
    prepare();
    timer = setInterval(tick, 1000);
    timer.unref();
    tick();
  });
  app.addHook('onClose', async () => {
    closing = true;
    if (timer) clearInterval(timer);
    await running;
  });
}
