import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ResourceTrace } from '../fastify-extensions.js';
export type { ResourceTrace } from '../fastify-extensions.js';
export interface ResourceRoute extends ResourceTrace {
  method: string;
  path: string;
  authentication: 'session' | 'service';
}
const manifests = new WeakMap<FastifyInstance, ResourceRoute[]>();
export function resourceRoutes(app: FastifyInstance): ResourceRoute[] {
  return [...(manifests.get(app) || [])];
}
const resources: Record<string, ResourceTrace> = {
  'GET /api/v1/reports/daily-store-sales': {
    module: 'reports',
    resource: 'daily-store-sales',
    action: 'read',
  },
  'GET /health/live': { module: 'system', resource: 'liveness', action: 'read' },
  'GET /health/ready': { module: 'system', resource: 'readiness', action: 'read' },
  'GET /api/v1/auth/capabilities': {
    module: 'identity',
    resource: 'authentication',
    action: 'capabilities',
  },
  'POST /api/v1/auth/sessions': { module: 'identity', resource: 'session', action: 'create' },
  'GET /api/v1/auth/sessions/current': { module: 'identity', resource: 'session', action: 'read' },
  'DELETE /api/v1/auth/sessions/current': {
    module: 'identity',
    resource: 'session',
    action: 'delete',
  },
  'GET /api/v1/stores': { module: 'stores', resource: 'store', action: 'list' },
  'GET /api/v1/stores/:storeId/counters': { module: 'stores', resource: 'counter', action: 'list' },
  'GET /api/v1/stores/:storeId/catalog/products': {
    module: 'catalog',
    resource: 'product',
    action: 'list',
  },
  'GET /api/v1/stores/:storeId/orders': { module: 'orders', resource: 'order', action: 'list' },
  'GET /api/v1/stores/:storeId/orders/:orderId': {
    module: 'orders',
    resource: 'order',
    action: 'read',
  },
  'GET /api/v1/stores/:storeId/cart-drafts': {
    module: 'checkout',
    resource: 'cart-draft',
    action: 'list',
  },
  'PUT /api/v1/stores/:storeId/cart-drafts/:draftId': {
    module: 'checkout',
    resource: 'cart-draft',
    action: 'save',
  },
};
export function registerEventCatalog(app: FastifyInstance) {
  const manifest: ResourceRoute[] = [];
  manifests.set(app, manifest);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const primary = methods.find((method) => method !== 'HEAD') || 'GET';
    const trace =
      route.config?.trace || resources[`${primary === 'HEAD' ? 'GET' : primary} ${route.url}`];
    if (trace && !Object.values(trace).every((value) => /^[a-z][a-z0-9-]*$/.test(value)))
      throw new Error('Trace metadata must contain static resource identifiers.');
    if (!trace && route.url.startsWith('/api/v1'))
      throw new Error(`Missing event catalog entry: ${primary} ${route.url}`);
    if (trace) route.config = { ...route.config, trace };
    if (trace && route.url.startsWith('/api/v1'))
      for (const method of methods.filter((method) => method !== 'HEAD' && method !== 'OPTIONS'))
        manifest.push({
          ...trace,
          method,
          path: route.url,
          authentication: route.config?.authentication || 'session',
        });
  });
}
export function requestEvent(request: FastifyRequest, reply: FastifyReply, errorCode?: string) {
  const trace = request.routeOptions.config.trace || {
    module: 'system',
    resource: 'http-request',
    action: 'handle',
  };
  const outcome = reply.statusCode >= 400 ? 'failed' : 'completed';
  return {
    eventId: `${trace.module}.${trace.resource}.${trace.action}.${outcome}`,
    eventInstanceId: randomUUID(),
    module: trace.module,
    resource: trace.resource,
    requestId: request.id,
    userId: request.principal?.id || request.auditUserId || null,
    method: request.method,
    status: reply.statusCode,
    durationMs: Math.round(reply.elapsedTime * 100) / 100,
    ...(errorCode ? { errorCode } : {}),
  };
}
