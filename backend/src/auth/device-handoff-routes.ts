import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticated } from './routes.js';
import {
  deviceHandoffRevision,
  deviceHandoffVerification,
  type DeviceHandoffService,
} from './device-handoff.js';
import { requestHeaders, routeSchema } from '../domain/route-validation.js';

const none = z.object({}).strict();
const headers = requestHeaders({
  cookie: z.string().max(16384).optional(),
  'x-pos-auth-key': z.string().max(4096).optional(),
});
function validate(request: FastifyRequest) {
  none.parse(request.params ?? {});
  none.parse(request.query ?? {});
  return headers.parse(request.headers);
}
export function registerDeviceHandoffs(app: FastifyInstance, service: DeviceHandoffService) {
  const base = '/api/v1/operators/current/device-handoffs',
    trace = (action: string, body?: z.ZodType) => ({
      config: { trace: { module: 'identity', resource: 'device-handoff', action } },
      ...routeSchema({ querystring: none, headers, ...(body ? { body } : {}) }),
    });
  app.get(base + '/capabilities', trace('capabilities'), async (request) => {
    validate(request);
    return service.capabilities(authenticated(request));
  });
  app.post(base, trace('create', none.nullable()), async (request) => {
    validate(request);
    none.parse(request.body ?? {});
    return service.issue(authenticated(request));
  });
  app.delete(base + '/current', trace('revoke', deviceHandoffRevision), async (request) => {
    validate(request);
    const input = deviceHandoffRevision.parse(request.body);
    return service.revoke(authenticated(request), input.revision);
  });
  app.post(
    '/api/v1/auth/device-handoff-verifications',
    {
      config: {
        authentication: 'service',
        trace: { module: 'identity', resource: 'device-handoff-verification', action: 'create' },
      },
      ...routeSchema({ querystring: none, body: deviceHandoffVerification, headers }),
    },
    async (request) => {
      const { 'x-pos-auth-key': key } = validate(request);
      service.authorizeService(key);
      const result = await service.verify(deviceHandoffVerification.parse(request.body));
      if (result.isAuthenticated) request.auditUserId = result.operatorId;
      return result;
    },
  );
}
