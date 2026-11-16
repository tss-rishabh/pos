import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import {
  importHistoryInput,
  importIdInput,
  importListInput,
  importRowListInput,
  stockCsv,
} from '../import-domain.js';
import { parentStoreInput, parentStoreTemplate } from './domain.js';
import { parentStoreImportService, type ParentStoreImportOptions } from './service.js';
export {
  parentStoreImportService,
  readParentStoreImportOptions,
  type ParentStoreImportOptions,
} from './service.js';
export function registerParentStoreImports(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: ParentStoreImportOptions = {},
) {
  const service = parentStoreImportService(config, db, options),
    base = '/api/v1/admin/parent-store-imports',
    trace = (action: string) => ({
      config: {
        trace: { module: 'administration', resource: 'parent-store-import', action },
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    }),
    none = z.object({}).strict();
  app.get(base + '/capabilities', trace('capabilities'), async (request, reply) => {
    none.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.capabilities(authenticated(request)));
  });
  app.get(base + '/template', trace('template'), async (request, reply) => {
    none.parse(request.query);
    await service.capabilities(authenticated(request));
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', 'attachment; filename="ProductStore-template.csv"')
      .type('text/csv; charset=utf-8')
      .send(stockCsv(parentStoreTemplate, true));
  });
  app.post(base + '/preview', trace('preview'), async (request, reply) => {
    none.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.preview(authenticated(request), parentStoreInput.parse(request.body)));
  });
  app.post(base, trace('create'), async (request, reply) => {
    none.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.create(authenticated(request), parentStoreInput.parse(request.body)));
  });
  app.get(base, trace('list'), async (request, reply) =>
    reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.list(authenticated(request), importListInput.parse(request.query))),
  );
  app.get(base + '/history', trace('history'), async (request, reply) =>
    reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.history(authenticated(request), importHistoryInput.parse(request.query))),
  );
  app.get(base + '/:importId', trace('read'), async (request, reply) => {
    none.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(
        await service.detail(authenticated(request), importIdInput.parse(request.params).importId),
      );
  });
  app.get(base + '/:importId/rows', trace('records'), async (request, reply) =>
    reply
      .header('Cache-Control', 'private, no-store')
      .send(
        await service.rows(
          authenticated(request),
          importIdInput.parse(request.params).importId,
          importRowListInput.parse(request.query),
        ),
      ),
  );
  app.get(base + '/:importId/failures.csv', trace('failures'), async (request, reply) => {
    none.parse(request.query);
    const { importId } = importIdInput.parse(request.params);
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename="ProductStore-${importId}-failed.csv"`)
      .type('text/csv; charset=utf-8')
      .send(Readable.from(await service.failedCsv(authenticated(request), importId)));
  });
  for (const action of ['resume', 'cancel'] as const)
    app.post(base + '/:importId/' + action, trace(action), async (request, reply) => {
      none.parse(request.query);
      none.parse(request.body ?? {});
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(
          await service.control(
            authenticated(request),
            importIdInput.parse(request.params).importId,
            action,
          ),
        );
    });
  return service;
}
