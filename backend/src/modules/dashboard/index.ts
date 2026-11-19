import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { authenticated } from '../../auth/routes.js';
import { noQuery, routeSchema, transportHeaders } from '../../domain/route-validation.js';
import { dashboardAuthority, recheckDashboardAuthority } from './authority.js';
import { dashboardBounds, dashboardCount } from './domain.js';
import { currentDashboardQuery, dailyDashboardQuery } from './queries.js';
import { dashboardWarehouse } from './warehouse.js';
import { readDashboardOptions, type DashboardOptions } from './options.js';
export { readDashboardOptions } from './options.js';
export function dashboardService(
  config: Config,
  db: Databases,
  options: DashboardOptions = readDashboardOptions(),
  dependencies: {
    history?: ReturnType<typeof dashboardWarehouse>;
    clock?: () => Temporal.Instant;
  } = {},
) {
  const history = dependencies.history || dashboardWarehouse(config, options),
    clock = dependencies.clock || (() => Temporal.Now.instant());
  return {
    async overview(user: Principal) {
      const scope = await dashboardAuthority(db, user),
        now = clock(),
        bounds = dashboardBounds(now, config.BUSINESS_TIMEZONE),
        raw = await db.get('primary').execute(currentDashboardQuery()),
        [counts] = z
          .array(
            z
              .object({
                active_stores: dashboardCount,
                active_operators: dashboardCount,
                parent_products: dashboardCount,
              })
              .strict(),
          )
          .length(1)
          .parse(raw[0]);
      await recheckDashboardAuthority(db, user, scope);
      return {
        reader: 'primary' as const,
        asOf: now.toString(),
        businessDate: bounds.today,
        year: bounds.year,
        activeStores: counts!.active_stores,
        activeOperators: counts!.active_operators,
        parentProducts: counts!.parent_products,
        stores: scope.graphStores,
      };
    },
    async today(user: Principal) {
      const scope = await dashboardAuthority(db, user),
        now = clock(),
        bounds = dashboardBounds(now, config.BUSINESS_TIMEZONE),
        raw = await db
          .get('data')
          .execute(dailyDashboardQuery(scope.orderStoreIds, bounds.dayStart, bounds.dayEnd)),
        [counts] = z
          .array(z.object({ order_count: dashboardCount }).strict())
          .length(1)
          .parse(raw[0]);
      await recheckDashboardAuthority(db, user, scope);
      return {
        reader: 'data' as const,
        asOf: now.toString(),
        businessDate: bounds.today,
        orderAssociations: counts!.order_count,
      };
    },
    async history(user: Principal) {
      const scope = await dashboardAuthority(db, user),
        now = clock(),
        bounds = dashboardBounds(now, config.BUSINESS_TIMEZONE),
        result = await history.read(scope, bounds.year, bounds.yearStart, now);
      await recheckDashboardAuthority(db, user, scope);
      return result;
    },
  };
}
export function registerDashboard(
  app: FastifyInstance,
  config: Config,
  db: Databases,
  options: DashboardOptions = readDashboardOptions(),
) {
  const service = dashboardService(config, db, options),
    trace = (resource: string) => ({
      config: { trace: { module: 'dashboard', resource, action: 'read' } },
      ...routeSchema({ querystring: noQuery, headers: transportHeaders }),
    });
  app.get('/api/v1/dashboard/overview', trace('current-summary'), async (request, reply) => {
    noQuery.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.overview(authenticated(request)));
  });
  app.get('/api/v1/dashboard/orders/today', trace('daily-orders'), async (request, reply) => {
    noQuery.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.today(authenticated(request)));
  });
  app.get('/api/v1/dashboard/orders/history', trace('order-history'), async (request, reply) => {
    noQuery.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send(await service.history(authenticated(request)));
  });
  return service;
}
