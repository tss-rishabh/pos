import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticated } from './routes.js';
import {
  deviceHandoffRevision,
  deviceHandoffVerification,
  type DeviceHandoffService,
} from './device-handoff.js';

export function registerDeviceHandoffs(app: FastifyInstance, service: DeviceHandoffService) {
  const base = '/api/v1/operators/current/device-handoffs',
    trace = (action: string) => ({
      config: { trace: { module: 'identity', resource: 'device-handoff', action } },
    });
  app.get(base + '/capabilities', trace('capabilities'), async (request) =>
    service.capabilities(authenticated(request)),
  );
  app.post(base, trace('create'), async (request) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return service.issue(authenticated(request));
  });
  app.delete(base + '/current', trace('revoke'), async (request) => {
    const input = deviceHandoffRevision.parse(request.body);
    return service.revoke(authenticated(request), input.revision);
  });
  app.post(
    '/api/v1/auth/device-handoff-verifications',
    {
      config: {
        authentication: 'service',
        rateLimit: { max: 30, timeWindow: '1 minute' },
        trace: { module: 'identity', resource: 'device-handoff-verification', action: 'create' },
      },
    },
    async (request) => {
      service.authorizeService(request.headers['x-pos-auth-key']);
      const result = await service.verify(deviceHandoffVerification.parse(request.body));
      if (result.isAuthenticated) request.auditUserId = result.operatorId;
      return result;
    },
  );
}
