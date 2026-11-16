import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import type { Databases } from '../../db/pools.js';
import { Country } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { requireRole } from '../../domain/access.js';
import { deliverablePincodes, locationZones } from './location-schema.js';
import { sourceCityTitle } from './location-title.js';

export const postalLookupInput = z
  .object({
    postalCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9 -]{0,30}[A-Za-z0-9])?$/),
  })
  .strict();
export function locationLookupService(db: Databases) {
  return {
    async find(user: Principal, input: z.infer<typeof postalLookupInput>) {
      requireRole(user, [1, 2, 3, 4, 5]);
      const [row] = await db
        .get('primary')
        .select({
          postalCode: deliverablePincodes.pincode,
          city: deliverablePincodes.city,
          state: locationZones.name,
          country: Country.name,
          countryId: deliverablePincodes.countryId,
          stateId: deliverablePincodes.stateId,
          latitude: deliverablePincodes.latitude,
          longitude: deliverablePincodes.longitude,
        })
        .from(deliverablePincodes)
        .innerJoin(locationZones, eq(locationZones.id, deliverablePincodes.stateId))
        .innerJoin(Country, eq(Country.id, deliverablePincodes.countryId))
        .where(eq(deliverablePincodes.pincode, input.postalCode))
        .orderBy(asc(deliverablePincodes.id))
        .limit(1);
      return {
        status: 'success' as const,
        message: 'location fetched',
        data: row
          ? {
              ...row,
              city: sourceCityTitle(row.city),
              countryId: String(row.countryId),
              stateId: String(row.stateId),
            }
          : null,
      };
    },
  };
}
export function registerLocationLookups(
  app: FastifyInstance,
  service: ReturnType<typeof locationLookupService>,
) {
  app.post(
    '/api/v1/locations/postal-code-lookups',
    {
      config: {
        trace: { module: 'administration', resource: 'postal-code-location', action: 'read' },
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      z.object({}).strict().parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.find(authenticated(request), postalLookupInput.parse(request.body)));
    },
  );
}
