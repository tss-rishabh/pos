import type { FastifyInstance } from 'fastify';
import { and, asc, eq, like } from 'drizzle-orm';
import { z } from 'zod';
import { authenticated } from '../../auth/routes.js';
import type { Databases } from '../../db/pools.js';
import { Country } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { noQuery, routeSchema, transportHeaders } from '../../domain/route-validation.js';
import { assertCurrentOperatorRole } from './authorization.js';

export const secondaryCountryInput = z
  .object({ search: z.string().max(1000).default('') })
  .strict();
/** The handler treats a missing body as `{}`. */
const secondaryCountryBody = z.union([z.null(), secondaryCountryInput]);
const literalContains = (value: string) => '%' + value.replace(/[\\%_]/g, '\\$&') + '%';
/** The source sec_status directory is distinct from the normal status=1 directory. */
export function secondaryCountryService(db: Databases) {
  const authorize = (user: Principal) =>
    db.get('writer').transaction((tx) => assertCurrentOperatorRole(tx, user.id, [1, 2, 3, 4, 5]));
  return {
    async search(user: Principal, raw: unknown) {
      const input = secondaryCountryInput.parse(raw);
      await authorize(user);
      if (!input.search) return { status: 'success' as const, message: 'Country name', data: {} };
      const rows = await db
        .get('primary')
        .select({ id: Country.id, text: Country.name })
        .from(Country)
        .where(and(eq(Country.sec_status, 1), like(Country.name, literalContains(input.search))))
        .orderBy(asc(Country.id))
        .limit(1001);
      if (rows.length > 1000)
        throw new AppError(422, 'COUNTRY_SEARCH_TOO_WIDE', 'Use a more specific country search.');
      await authorize(user);
      return {
        status: 'success' as const,
        message: 'Country name',
        data: { country: rows.map((row) => ({ id: String(row.id), text: row.text })) },
      };
    },
  };
}
export function registerSecondaryCountrySearch(app: FastifyInstance, db: Databases) {
  const service = secondaryCountryService(db);
  app.post(
    '/api/v1/countries/secondary/search',
    {
      config: {
        trace: { module: 'administration', resource: 'secondary-country', action: 'search' },
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      ...routeSchema({
        querystring: noQuery,
        body: secondaryCountryBody,
        headers: transportHeaders,
      }),
    },
    async (request, reply) => {
      noQuery.parse(request.query);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await service.search(authenticated(request), request.body ?? {}));
    },
  );
  return service;
}
