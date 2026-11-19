import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { noQuery, requestHeaders, routeSchema } from '../../domain/route-validation.js';
import { secretMatches } from '../fulfillment/options.js';
import { scheduleInput, type ScheduleInput, type ScheduledArtifact } from './scheduled-domain.js';
import type { ScheduledReportOptions } from './scheduled-options.js';
import { postSlackText, type SlackPoster } from './slack.js';

export type ScheduledBuilder = (
  input: ScheduleInput & { date: string },
) => Promise<ScheduledArtifact>;
export type ScheduledLogger = (
  level: 'info' | 'warn',
  event: Readonly<Record<string, string | number | boolean | null>>,
  message: string,
) => void;
/**
 * The seven legacy scheduler-called report views (report/views.py:810-1876, URLs
 * report/urls.py:40-45,84) run synchronously in the request: build the Slack text, post it
 * inline (main channel and/or demo channel), then answer `{"status":"success","message":...}`.
 */
export function scheduledReportRunner(
  config: Config,
  options: ScheduledReportOptions,
  builder: ScheduledBuilder,
  post: SlackPoster = postSlackText,
  clock = () => Temporal.Now.instant(),
) {
  return async (value: unknown, log?: ScheduledLogger, requestId: string | null = null) => {
    const input = scheduleInput.parse(value),
      today = clock().toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate(),
      selected = Temporal.PlainDate.from(
        input.date ||
          (input.kind === 'hyperlocal-store-status'
            ? today.toString()
            : today
                .subtract({
                  days:
                    input.kind === 'hyperlocal-performance' ? options.DAYS_BEFORE_FOR_MIN_MAX : 1,
                })
                .toString()),
      ),
      span = today.since(selected, { largestUnit: 'days' }).days;
    if (span > 62 || (input.kind === 'hyperlocal-store-status' ? span !== 0 : span < 1))
      throw new AppError(
        400,
        'INVALID_DATE_RANGE',
        'Choose a completed report day from the preceding 62 days; store availability uses today.',
      );
    if (
      input.kind !== 'crm-tickets' &&
      (input.previousDays !== 1 || !input.sendToSlack || input.includeCompleted)
    )
      throw new AppError(
        400,
        'INVALID_REPORT_OPTIONS',
        'Ticket refresh options apply only to CRM reports.',
      );
    const artifact = await builder({ ...input, date: selected.toString() });
    for (const message of artifact.messages) {
      const delivered = await post(
        message.target === 'main' ? options.SLACK_URL : options.SLACK_DEMO_URL,
        message.text,
      );
      log?.(
        delivered ? 'info' : 'warn',
        {
          module: 'operational-reports',
          resource: 'scheduled-report-delivery',
          eventId: `operational-reports.scheduled-report-delivery.${delivered ? 'sent' : 'not-sent'}`,
          eventInstanceId: randomUUID(),
          requestId,
          userId: 'service-reports',
          kind: input.kind,
          target: message.target,
        },
        delivered ? 'Scheduled report posted' : 'Scheduled report post failed',
      );
    }
    return {
      status: 'success' as const,
      message: artifact.messages.length
        ? 'Data Sent'
        : input.kind === 'crm-tickets' && !input.sendToSlack
          ? 'Data Updated In DB'
          : 'Data Not Found',
      recordCount: artifact.recordCount,
    };
  };
}
/** Legacy `Helpers.check_report_api_key` reads the `apikey` header (helpers/helpers.py:1713-1717). */
export function reportApiKeyGuard(apiKey: string | undefined) {
  return async (request: FastifyRequest) => {
    if (!secretMatches(apiKey, request.headers.apikey))
      throw new AppError(401, 'SERVICE_AUTHENTICATION_REQUIRED', 'Invalid or missing API key');
  };
}
const deliveryBody = z.object({ input: scheduleInput }).strict();
export async function registerScheduledReportRoutes(
  app: FastifyInstance,
  run: ReturnType<typeof scheduledReportRunner>,
  options: ScheduledReportOptions,
) {
  app.post(
    '/api/v1/report-deliveries',
    {
      config: {
        authentication: 'service' as const,
        trace: {
          module: 'operational-reports',
          resource: 'scheduled-report-delivery',
          action: 'create',
        },
      },
      preValidation: reportApiKeyGuard(options.REPORTS_API_KEY),
      ...routeSchema({
        querystring: noQuery,
        body: deliveryBody,
        // The guard compares `apikey` and answers its absence with 401.
        headers: requestHeaders({ apikey: z.string().max(4096).optional() }),
      }),
    },
    async (request) => {
      const body = deliveryBody.parse(request.body);
      return run(body.input, (level, event, message) => app.log[level](event, message), request.id);
    },
  );
}
