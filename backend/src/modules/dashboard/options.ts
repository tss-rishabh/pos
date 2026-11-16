import { z } from 'zod';
import { warehouseView } from '../operational-reports/report-inputs.js';
export const dashboardPublicationContract = 'pos-dashboard-orders-v1';
export function readDashboardOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      BQ_DASHBOARD_FACTS_VIEW: warehouseView,
      BQ_DASHBOARD_PUBLICATIONS_VIEW: warehouseView,
      BQ_DASHBOARD_CONTRACT: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.literal(dashboardPublicationContract).optional(),
      ),
      DASHBOARD_PUBLICATION_MAX_AGE_SECONDS: z.coerce
        .number()
        .int()
        .min(60)
        .max(86400)
        .default(3600),
    })
    .parse(env);
}
export type DashboardOptions = ReturnType<typeof readDashboardOptions>;
