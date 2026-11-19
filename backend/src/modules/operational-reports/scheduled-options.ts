import { z } from 'zod';
import { warehouseView } from './report-inputs.js';
const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).max(1024).optional(),
);
const https = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  }, 'Use a credential-free HTTPS service endpoint.')
  .optional();
const webhook = https.refine(
  (value) => !value || new URL(value).hostname === 'hooks.slack.com',
  'Use a Slack webhook endpoint.',
);
export function scheduledReportOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      REPORTS_API_KEY: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.string().min(16).max(1024).optional(),
      ),
      DAYS_BEFORE_FOR_MIN_MAX: z.coerce.number().int().min(1).max(62).default(1),
      SLACK_URL: webhook,
      SLACK_DEMO_URL: webhook,
      FRESHDESK_TICKET_URL: https,
      FRESHDESK_BASIC_AUTH_USERNAME: optionalSecret,
      FRESHDESK_BASIC_AUTH_PASSWORD: optionalSecret,
      SCHEDULED_REPORT_MAX_CRM_TICKETS: z.coerce.number().int().min(1).max(2000).default(200),
      BQ_HYPERLOCAL_ORDER_FACTS_VIEW: warehouseView,
      BQ_HYPERLOCAL_ORDER_LOGS_VIEW: warehouseView,
      BQ_HYPERLOCAL_AVAILABILITY_VIEW: warehouseView,
      BQ_HYPERLOCAL_DELIVERY_ISSUES_VIEW: warehouseView,
      BQ_HYPERLOCAL_CANCELLATIONS_VIEW: warehouseView,
      BQ_HYPERLOCAL_CRM_TICKETS_VIEW: warehouseView,
    })
    .parse(env);
}
export type ScheduledReportOptions = ReturnType<typeof scheduledReportOptions>;
