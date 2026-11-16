import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { giftCardBatchService, type GiftCardBatchDependencies } from './service.js';
import { giftCardBatchHistory } from './history.js';
import { readGiftCardBatchOptions, type GiftCardBatchOptions } from './options.js';
import {
  blockGiftCardBatchInput,
  createGiftCardBatchInput,
  giftCardBatchId,
  giftCardBatchSearchInput,
  printGiftCardBatchInput,
  retryGiftCardBatchInput,
} from './contracts.js';

export { readGiftCardBatchOptions } from './options.js';
export { giftCardBatchWorker } from './worker.js';
export { giftCardBatchService } from './service.js';
export function registerGiftCardBatches(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: GiftCardBatchOptions = readGiftCardBatchOptions(),
  dependencies: GiftCardBatchDependencies = {},
) {
  const service = giftCardBatchService(config, db, options, dependencies);
  const history = giftCardBatchHistory(service);
  const empty = (value: unknown) =>
    z
      .object({})
      .strict()
      .parse(value ?? {});
  const id = (value: unknown) =>
    z.object({ batchId: giftCardBatchId }).strict().parse(value).batchId;
  const trace = (resource: string, action: string, max = 30) => ({
    config: {
      trace: { module: 'gift-card-batches', resource, action },
      rateLimit: { max, timeWindow: '1 minute' },
    },
    onRequest: async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer');
    },
  });
  app.addHook('onClose', async () => service.close());
  app.get(
    '/api/v1/gift-card-batches/current-jobs',
    trace('generation-job', 'read', 60),
    async (request) => {
      empty(request.query);
      return service.currentJobs(authenticated(request));
    },
  );
  app.get(
    '/api/v1/gift-card-batches/capabilities',
    trace('batch', 'capabilities'),
    async (request) => {
      empty(request.query);
      return service.capabilities(authenticated(request));
    },
  );
  app.post(
    '/api/v1/gift-card-batches/search',
    trace('batch-history', 'search'),
    async (request) => {
      empty(request.query);
      return history.search(authenticated(request), giftCardBatchSearchInput.parse(request.body));
    },
  );
  app.post('/api/v1/gift-card-batches', trace('batch', 'create', 3), async (request) => {
    empty(request.query);
    return service.create(authenticated(request), createGiftCardBatchInput.parse(request.body));
  });
  app.get('/api/v1/gift-card-batches/:batchId', trace('batch', 'read', 60), async (request) => {
    empty(request.query);
    return service.details(authenticated(request), id(request.params));
  });
  app.put(
    '/api/v1/gift-card-batches/:batchId/print-status',
    trace('batch-print-status', 'update'),
    async (request) => {
      empty(request.query);
      return service.markPrinted(
        authenticated(request),
        id(request.params),
        printGiftCardBatchInput.parse(request.body),
      );
    },
  );
  app.put(
    '/api/v1/gift-card-batches/:batchId/block-status',
    trace('batch-block-status', 'update'),
    async (request) => {
      empty(request.query);
      return service.setBlocked(
        authenticated(request),
        id(request.params),
        blockGiftCardBatchInput.parse(request.body),
      );
    },
  );
  app.post(
    '/api/v1/gift-card-batches/:batchId/retries',
    trace('batch-delivery', 'retry', 10),
    async (request) => {
      empty(request.query);
      return service.retry(
        authenticated(request),
        id(request.params),
        retryGiftCardBatchInput.parse(request.body),
      );
    },
  );
  app.post(
    '/api/v1/gift-card-batches/:batchId/artifact-access',
    trace('batch-archive-password', 'read', 10),
    async (request) => {
      empty(request.query);
      empty(request.body);
      return service.artifactAccess(authenticated(request), id(request.params));
    },
  );
  app.get(
    '/api/v1/gift-card-batches/:batchId/archive',
    trace('batch-archive', 'download', 10),
    async (request, reply) => {
      empty(request.query);
      const batchId = id(request.params),
        controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      let archive: Buffer;
      try {
        archive = await service.archive(authenticated(request), batchId, controller.signal);
      } finally {
        request.raw.off('aborted', abort);
        reply.raw.off('close', abort);
      }
      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Length', archive.length)
        .header('Content-Disposition', `attachment; filename="gift-cards-${batchId}.zip"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(archive);
    },
  );
  return { ...service, history };
}
