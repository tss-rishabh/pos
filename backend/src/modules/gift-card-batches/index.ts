import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { giftCardBatchService, type GiftCardBatchDependencies } from './service.js';
import { readGiftCardBatchOptions, type GiftCardBatchOptions } from './options.js';
import { noBody, noQuery, routeSchema, transportHeaders } from '../../domain/route-validation.js';
import {
  blockGiftCardBatchInput,
  createGiftCardBatchInput,
  giftCardBatchId,
  giftCardBatchListInput,
} from './contracts.js';

const batchScope = z.object({ batchId: giftCardBatchId }).strict();

export { readGiftCardBatchOptions } from './options.js';
export { giftCardBatchService } from './service.js';

/**
 * Legacy routes (core/urls.py:103-107): page, list, generate, print, block. Generation runs on
 * the Redis job queue (`pos.gift_card_batches.generate`, approved divergence).
 */
export function registerGiftCardBatches(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: GiftCardBatchOptions = readGiftCardBatchOptions(),
  dependencies: GiftCardBatchDependencies,
) {
  const service = giftCardBatchService(config, db, options, dependencies);
  const empty = (value: unknown) => noQuery.parse(value ?? {});
  const id = (value: unknown) => batchScope.parse(value).batchId;
  const trace = (resource: string, action: string, max = 30) => ({
    config: {
      trace: { module: 'gift-card-batches', resource, action },
      rateLimit: { max, timeWindow: '1 minute' },
    },
    onRequest: async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer');
    },
  });
  app.get(
    '/api/v1/gift-card-batches/capabilities',
    {
      ...trace('batch', 'capabilities'),
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    },
    async (request) => {
      empty(request.query);
      return service.capabilities(authenticated(request));
    },
  );
  app.post(
    '/api/v1/gift-card-batches/search',
    {
      ...trace('batch-history', 'search', 60),
      ...routeSchema({
        querystring: noQuery,
        body: giftCardBatchListInput,
        headers: transportHeaders,
      }),
    },
    async (request) => {
      empty(request.query);
      return service.list(authenticated(request), request.body);
    },
  );
  app.post(
    '/api/v1/gift-card-batches',
    {
      ...trace('batch', 'create', 10),
      ...routeSchema({
        querystring: noQuery,
        body: createGiftCardBatchInput,
        headers: transportHeaders,
      }),
    },
    async (request) => {
      empty(request.query);
      return service.create(authenticated(request), request.body);
    },
  );
  app.put(
    '/api/v1/gift-card-batches/:batchId/print-status',
    {
      ...trace('batch-print-status', 'update'),
      ...routeSchema({
        params: batchScope,
        querystring: noQuery,
        body: noBody,
        headers: transportHeaders,
      }),
    },
    async (request) => {
      empty(request.query);
      empty(request.body);
      return service.markPrinted(authenticated(request), id(request.params));
    },
  );
  app.put(
    '/api/v1/gift-card-batches/:batchId/block-status',
    {
      ...trace('batch-block-status', 'update'),
      ...routeSchema({
        params: batchScope,
        querystring: noQuery,
        body: blockGiftCardBatchInput,
        headers: transportHeaders,
      }),
    },
    async (request) => {
      empty(request.query);
      return service.setBlocked(authenticated(request), id(request.params), request.body);
    },
  );
  return service;
}
