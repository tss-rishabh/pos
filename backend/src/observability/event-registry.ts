import type { FastifyBaseLogger } from 'fastify';

/**
 * Registered resource events of the backend processes (`server` and `worker` run the same module
 * code, so they share one registry). Every `eventId` a module logs is listed here; the loggers
 * below only accept these IDs, so a free-form or templated value does not type-check.
 *
 * Two families are derived rather than listed: request completion events
 * (`<module>.<resource>.<action>.completed|failed`, from the route event catalog in events.ts) and
 * the `<module>.<resource>.log` fallback for a line that names no event.
 */
export const backendEventIds = [
  // runtime (server.ts) and job worker (jobs/worker*.ts)
  'runtime.server.startup.failed',
  'runtime.server.shutdown.failed',
  'jobs.worker.startup-failed',
  'jobs.worker.job-skipped',
  'jobs.worker.heartbeat-failed',
  'jobs.worker.promote-failed',
  'jobs.worker.claim-failed',
  'jobs.worker.started',
  'jobs.worker.stopped',
  'jobs.job.start-unrecorded',
  'jobs.job.started',
  'jobs.job.finish-unrecorded',
  'jobs.job.succeeded',
  'jobs.job.failed',
  // identity (auth/events.ts keeps its own subset for the auth event logger)
  'identity.login.password-rehashed',
  'identity.login.unverifiable-password-hash',
  'identity.login-otp.issued',
  'identity.login-otp.fixed-issued',
  'identity.login-otp.contact-missing',
  'identity.login-otp.email-failed',
  'identity.login-otp.sms-failed',
  'identity.login-otp.whatsapp-failed',
  'identity.login-otp.locked',
  'identity.login-otp.verification-failed',
  'identity.login-otp.totp-unavailable',
  'identity.login-otp.alert-failed',
  'identity.session.logout-check-in-cleanup-failed',
  // outbound allowlist
  'outbound.allowlist.active',
  'outbound.suppressed',
  // administration
  'administration.documentation-media.delete-failed',
  'administration.ecommerce-inventory-sync.completed',
  'administration.ecommerce-inventory-sync.enqueue-failed',
  'administration.ecommerce-inventory-sync.failed',
  'administration.product-sync.failed',
  'administration.product-sync.unconfigured',
  'administration.settings-effect.failed',
  'administration.inventory-import.already-imported',
  'administration.inventory-import.already-running',
  'administration.inventory-import.completed',
  'administration.inventory-import.interrupted',
  'administration.inventory-import.missing',
  'administration.inventory-import.paused',
  'administration.inventory-import.stock-procedure-failed',
  // catalog details
  'catalog-details.inventory-pull.failed',
  'catalog-details.inventory-pull.not-acknowledged',
  'catalog-details.product-troubleshoot.completed',
  'catalog-details.product-troubleshoot.failed',
  // checkout
  'checkout.customer-registration.self-verify-accepted',
  'checkout.customer-registration.self-verify-registered',
  'checkout.exchange-operation.invoice-failed',
  'checkout.order-copy.partial',
  'checkout.order-engagement.sent',
  'checkout.order-engagement.failed',
  'checkout.order-engagement.unconfigured',
  'checkout.order-kinesis.sent',
  'checkout.order-kinesis.failed',
  'checkout.order-kinesis.unconfigured',
  'checkout.pending-order-cancellation.refund-log-missing',
  'checkout.pending-order-cancellation.stock-log-failed',
  'checkout.pending-order-cancellation.outcome-unknown',
  'checkout.pending-order-cancellation.local-update-failed',
  'checkout.pending-order-cancellation.product-sync-unavailable',
  'checkout.pending-order-cancellation.product-sync-failed',
  'checkout.return-mail.skipped',
  'checkout.return-mail.rejected',
  'checkout.return-mail.failed',
  'checkout.exchange-mail.rejected',
  'checkout.exchange-mail.failed',
  'checkout.exchange-alert.rejected',
  'checkout.exchange-alert.failed',
  'checkout.return-operation.vinculum-push-unqueued',
  // finance, orders, invoices, reports
  'finance.pending-close-alert.sent',
  'orders.cross-store-lookup.read.completed',
  'invoice-documents.whatsapp-invoice.not-sent',
  'operational-reports.report-export.completed',
  'operational-reports.scheduled-report-delivery.sent',
  'operational-reports.scheduled-report-delivery.not-sent',
  'whole-order-status.sync-repo.not-sent',
  // gift-card batches (job)
  'gift-card-batches.batch.missing',
  'gift-card-batches.batch.already-completed',
  'gift-card-batches.batch.not-eligible',
  'gift-card-batches.batch.generation-failed',
  'gift-card-batches.batch.upload-failed',
  'gift-card-batches.batch.storage-failed',
  'gift-card-batches.batch.email-failed',
  'gift-card-batches.batch.generated',
  // fulfillment
  'fulfillment.auto-reject.allocation-check',
  'fulfillment.auto-reject.not-enqueued',
  'fulfillment.concurrency-sync.sent',
  'fulfillment.concurrency-sync.dropped',
  'fulfillment.concurrency-sync.failed',
  'fulfillment.concurrency-sync.skipped',
  'fulfillment.notification.publish-failed',
  'fulfillment.out-for-delivery-mail.skipped',
  'fulfillment.out-for-delivery-mail.sent',
  'fulfillment.out-for-delivery-mail.rejected',
  'fulfillment.out-for-delivery-mail.failed',
  'fulfillment.vinculum-rto.skipped',
  'fulfillment.vinculum-rto.sent',
  'fulfillment.vinculum-rto.rejected',
  'fulfillment.vinculum-rto.failed',
  'fulfillment.slack.failed',
  'fulfillment.slack.not-sent',
  'fulfillment.slack.sent',
  'fulfillment.slack.skipped',
  'fulfillment.sync-repo-status.sent',
  'fulfillment.sync-repo-status.skipped-unconfigured',
  'fulfillment.sync-repo-status.failed',
  'fulfillment.warehouse-conversion.failed',
  'fulfillment.warehouse-conversion.rejected',
  'fulfillment.warehouse-conversion.sent',
  'fulfillment.warehouse-conversion.skipped',
  'notifications.redis.connection.failed',
  // legacy fulfillment (hyperlocal)
  'legacy-fulfillment.arrival-hold.failed',
  'legacy-fulfillment.arrival-log.failed',
  'legacy-fulfillment.arrival-notice.failed',
  'legacy-fulfillment.borzo.sent',
  'legacy-fulfillment.buffer-time.failed',
  'legacy-fulfillment.cancel-refund.sent',
  'legacy-fulfillment.cancel-restock.failed',
  'legacy-fulfillment.hold-stock.failed',
  'legacy-fulfillment.job.enqueue-failed',
  'legacy-fulfillment.new-order-communication.sent',
  'legacy-fulfillment.notification.publish-failed',
  'legacy-fulfillment.od-ticket.sent',
  'legacy-fulfillment.online-order.sent',
  'legacy-fulfillment.order-producer.sent',
  'legacy-fulfillment.product-sync.failed',
  'legacy-fulfillment.product-sync.skipped',
  'legacy-fulfillment.slack.sent',
  'legacy-fulfillment.slack.skipped',
  'legacy-fulfillment.split-charges.sent',
  'legacy-fulfillment.transfer-stock.failed',
  'legacy-fulfillment.unhold-stock.failed',
] as const;

/**
 * UI error events reported by the renderer (desktop over IPC, web through the beacon route).
 * Same IDs as `frontend/src/observability/ui-events.ts`; the beacon accepts nothing else.
 */
export const clientEventIds = [
  'ui.render.failed',
  'ui.window.error',
  'ui.promise.unhandled',
] as const;

export type BackendEventId = (typeof backendEventIds)[number];
export type ClientEventId = (typeof clientEventIds)[number];
export type EventId = BackendEventId | ClientEventId;
const registered: ReadonlySet<string> = new Set<string>([...backendEventIds, ...clientEventIds]);
export function isRegisteredEventId(value: unknown): value is EventId {
  return typeof value === 'string' && registered.has(value);
}

/** Processes that write structured logs (`process` on every line). */
export const logProcesses = ['server', 'worker', 'main', 'preload', 'renderer'] as const;
export type LogProcess = (typeof logProcesses)[number];

/** Scalar log fields: identifiers, codes, counts and timings, never objects or free text. */
export type LogScalar = string | number | boolean | null;
/** A registered event: a registered `eventId` plus scalar fields. */
export type RegisteredEvent = Readonly<{ eventId: EventId } & Record<string, LogScalar>>;
export type EventLevel = 'info' | 'warn' | 'error';
/**
 * Logger typed to the registry. `msg` is a fixed sentence for the event (the `details` of the
 * log schema): it never interpolates values.
 */
export type EventLogger = (level: EventLevel, event: RegisteredEvent, message: string) => void;
export function eventLogger(log: Pick<FastifyBaseLogger, EventLevel>): EventLogger {
  return (level, event, message) => log[level]({ ...event }, message);
}
