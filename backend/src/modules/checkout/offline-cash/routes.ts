import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { authenticated } from '../../../auth/routes.js';
import {
  cashIdentifier,
  cashTimestamp,
  devicePublicKeySchema,
  signedCashReceiptSchema,
} from './contracts.js';
import { offlineCashService, type OfflineCashServiceOptions } from './service.js';
import { cashImportApprovalInputSchema, cashOrderImportInputSchema } from './attribution.js';

const base = '/api/v1/stores/:storeId',
  storeScope = z.object({ storeId: cashIdentifier }),
  receiptScope = storeScope.extend({ receiptId: z.uuid() });
const trace = (resource: string, action: string) => ({
  config: { trace: { module: 'checkout', resource, action } },
});
export function registerOfflineCash(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: OfflineCashServiceOptions = {},
) {
  const service = offlineCashService(config, db, options);
  app.post(
    base + '/offline-cash-devices',
    trace('offline-cash-device', 'register'),
    async (request, reply) => {
      const user = authenticated(request),
        { storeId } = storeScope.parse(request.params),
        body = z
          .object({
            deviceId: z.uuid(),
            counterId: cashIdentifier,
            publicKey: devicePublicKeySchema,
          })
          .strict()
          .parse(request.body);
      return reply
        .code(201)
        .send(
          await service.repository.registerDevice(
            user,
            storeId,
            body.counterId,
            body.deviceId,
            body.publicKey,
          ),
        );
    },
  );
  app.post(
    base + '/offline-cash-authorizations',
    trace('offline-cash-authorization', 'create'),
    async (request, reply) => {
      const user = authenticated(request),
        { storeId } = storeScope.parse(request.params),
        body = z
          .object({
            deviceId: z.uuid(),
            counterId: cashIdentifier,
            productIds: z
              .array(cashIdentifier)
              .min(1)
              .max(1000)
              .refine((values) => new Set(values).size === values.length),
          })
          .strict()
          .parse(request.body);
      return reply.code(201).send(await service.authorize(user, storeId, body));
    },
  );
  app.post(
    base + '/offline-cash-receipts',
    trace('offline-cash-receipt', 'accept'),
    async (request, reply) => {
      const user = authenticated(request),
        { storeId } = storeScope.parse(request.params),
        body = signedCashReceiptSchema.parse(request.body);
      const { replayed: _replayed, ...result } = await service.repository.accept(
        user,
        storeId,
        body,
      );
      return reply.code(201).send(result);
    },
  );
  app.get(
    base + '/offline-cash-receipts',
    trace('offline-cash-receipt', 'list'),
    async (request) => {
      const user = authenticated(request),
        { storeId } = storeScope.parse(request.params),
        query = z
          .object({
            status: z
              .enum(['accepted', 'conflicted', 'importing', 'imported'])
              .default('conflicted'),
            limit: z.coerce.number().int().min(1).max(100).default(25),
            after: cashTimestamp.optional(),
            afterId: z.uuid().optional(),
          })
          .strict()
          .refine((value) => Boolean(value.after) === Boolean(value.afterId))
          .parse(request.query);
      return service.repository.list(
        user,
        storeId,
        query.status,
        query.after && query.afterId ? { acceptedAt: query.after, receiptId: query.afterId } : null,
        query.limit,
      );
    },
  );
  app.get(
    base + '/offline-cash-receipts/:receiptId',
    trace('offline-cash-receipt', 'read'),
    async (request) => {
      const user = authenticated(request),
        scope = receiptScope.parse(request.params);
      return service.repository.get(user, scope.storeId, scope.receiptId);
    },
  );
  app.post(
    base + '/offline-cash-receipts/:receiptId/order-imports',
    trace('offline-cash-order-import', 'create'),
    async (request) => {
      const user = authenticated(request),
        scope = receiptScope.parse(request.params);
      return service.importReceipt(
        user,
        scope.storeId,
        scope.receiptId,
        cashOrderImportInputSchema.parse(request.body),
      );
    },
  );
  app.post(
    base + '/offline-cash-receipts/:receiptId/import-approvals',
    trace('offline-cash-import-approval', 'create'),
    async (request) => {
      const user = authenticated(request),
        scope = receiptScope.parse(request.params);
      return service.repository.approveImport(
        user,
        scope.storeId,
        scope.receiptId,
        cashImportApprovalInputSchema.parse(request.body),
      );
    },
  );
  app.post(
    base + '/offline-cash-receipts/:receiptId/manager-reviews',
    trace('offline-cash-manager-review', 'acknowledge'),
    async (request) => {
      const user = authenticated(request),
        scope = receiptScope.parse(request.params),
        body = z
          .object({
            operationId: z.uuid(),
            expectedVersion: z.number().int().positive(),
            reason: z.string().trim().min(1).max(500),
          })
          .strict()
          .parse(request.body);
      return service.repository.acknowledge(user, scope.storeId, scope.receiptId, body);
    },
  );
}
