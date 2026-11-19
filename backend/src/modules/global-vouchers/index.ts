import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { identifier } from '../../domain/validation.js';
import { noQuery, routeSchema, transportHeaders } from '../../domain/route-validation.js';
import {
  voucherCancellationSchema,
  voucherCheckSchema,
  voucherConversionSchema,
  voucherIssuanceSchema,
  voucherLookupSchema,
} from './contracts.js';
import { readGlobalVoucherOptions, type GlobalVoucherOptions } from './options.js';
import { globalVoucherService, type GlobalVoucherDependencies } from './service.js';

export { readGlobalVoucherOptions, globalVoucherService };
export type { GlobalVoucherOptions, GlobalVoucherDependencies };
const trace = (resource: string, action: string) => ({
  config: { trace: { module: 'global-vouchers', resource, action } },
});
const operationScope = z.object({ operationId: z.uuid() }).strict();
const checkoutScope = z.object({ storeId: identifier, checkoutId: z.uuid() }).strict();
function privateResponse(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store');
}
export async function registerGlobalVouchers(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: GlobalVoucherOptions = readGlobalVoucherOptions(),
  dependencies: GlobalVoucherDependencies = {},
) {
  const service = globalVoucherService(config, db, options, dependencies);
  app.get(
    '/api/v1/gift-vouchers/capabilities',
    {
      ...trace('gift-voucher-capability', 'read'),
      ...routeSchema({
        querystring: noQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      privateResponse(reply);
      return service.capabilities(authenticated(request));
    },
  );
  app.post(
    '/api/v1/gift-voucher-customer-lookups',
    {
      ...trace('gift-voucher-customer-lookup', 'create'),
      ...routeSchema({
        querystring: noQuery,
        body: voucherLookupSchema,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      privateResponse(reply);
      return service.lookup(authenticated(request), voucherLookupSchema.parse(request.body));
    },
  );
  app.post(
    '/api/v1/gift-voucher-issuances',
    {
      ...trace('gift-voucher-issuance', 'create'),
      ...routeSchema({
        querystring: noQuery,
        body: voucherIssuanceSchema,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      privateResponse(reply);
      return service.issue(authenticated(request), voucherIssuanceSchema.parse(request.body));
    },
  );
  app.get(
    '/api/v1/gift-voucher-operations/:operationId',
    {
      ...trace('gift-voucher-operation', 'read'),
      ...routeSchema({
        params: operationScope,
        querystring: noQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      privateResponse(reply);
      const parameters = operationScope.parse(request.params);
      return service.get(authenticated(request), parameters.operationId);
    },
  );
  app.post(
    '/api/v1/gift-voucher-operations/:operationId/cancellations',
    {
      ...trace('gift-voucher-operation-cancellation', 'create'),
      ...routeSchema({
        params: operationScope,
        querystring: noQuery,
        body: voucherCancellationSchema,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      privateResponse(reply);
      const parameters = operationScope.parse(request.params);
      return service.cancel(
        authenticated(request),
        parameters.operationId,
        voucherCancellationSchema.parse(request.body),
      );
    },
  );
  app.post(
    '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/voucher-checks',
    {
      ...trace('gift-voucher-check', 'create'),
      ...routeSchema({
        params: checkoutScope,
        querystring: noQuery,
        body: voucherCheckSchema,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      privateResponse(reply);
      const parameters = checkoutScope.parse(request.params);
      return service.check(
        authenticated(request),
        parameters.storeId,
        parameters.checkoutId,
        voucherCheckSchema.parse(request.body),
      );
    },
  );
  app.post(
    '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/voucher-conversions',
    {
      ...trace('gift-voucher-conversion', 'create'),
      ...routeSchema({
        params: checkoutScope,
        querystring: noQuery,
        body: voucherConversionSchema,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      privateResponse(reply);
      const parameters = checkoutScope.parse(request.params);
      return service.convert(
        authenticated(request),
        parameters.storeId,
        parameters.checkoutId,
        voucherConversionSchema.parse(request.body),
      );
    },
  );
  app.get(
    '/api/v1/stores/:storeId/checkout-sessions/:checkoutId/voucher-conversions/capabilities',
    {
      ...trace('gift-voucher-conversion-capability', 'read'),
      ...routeSchema({
        params: checkoutScope,
        querystring: noQuery,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      privateResponse(reply);
      const parameters = checkoutScope.parse(request.params);
      return service.conversionCapabilities(
        authenticated(request),
        parameters.storeId,
        parameters.checkoutId,
      );
    },
  );
}
