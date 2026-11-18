/**
 * Shared contract for the Redis-backed job queue that replaces legacy Celery.
 * Design: backend/parity/phase-c-legacy-jobs.md §4.
 *
 * Producers (checkout, orders, reports, administration) depend only on this file.
 * The implementation lives in backend/src/jobs/queue.ts, which is owned by the jobs workstream.
 *
 * Semantics, matching legacy Celery:
 * - At-most-once delivery. No automatic retry.
 * - A delayed job survives worker restarts until it is due.
 * - Enqueue only after the caller's MySQL transaction has committed.
 * - Job args carry IDs only: no request bodies, PII, credentials or tokens.
 */

/** Legacy Celery queue names, kept verbatim so runbooks map one to one. */
export const JOB_QUEUES = [
  'core',
  'store',
  'order',
  'order_create',
  'export_queue',
  'report_queue',
  'sales_queue',
] as const;
export type JobQueue = (typeof JOB_QUEUES)[number];

/** Legacy task names (phase-c-legacy-jobs.md §4.7), plus approved additions. */
export const JOB_NAMES = [
  'core.tasks.parse_csv_product_store',
  'core.tasks.parse_csv_product_stock',
  'core.tasks.send_sms',
  'core.tasks.new_order_create_communication',
  'core.tasks.sync_ecom_inventory',
  'core.tasks.push_vinc_order_for_all',
  'order.tasks.auto_reject_timed_out_for_store',
  'order.views.auto_hl_order_transfer',
  'order.views.auto_hl_order_to_online',
  'order.views.advance_order_notification',
  'report.datatables.return_orders_datatable.do_return_export',
  'report.datatables.return_orders_datatable.do_order_export',
  'report.datatables.cash_balance_datatable.do_cash_balance_export',
  'report.datatables.sales_data.do_sales_export',
  'report.datatables.day_close_datatable.do_day_close_export',
  'report.datatables.hyperlocal_daily_datatable.do_hyperlocal_daily_export',
  /** Approved divergence (user, 19 November 2026): legacy generates gift-card batches inline. */
  'pos.gift_card_batches.generate',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** JSON-serialisable job arguments: IDs and scalar options only. */
export type JobScalar = string | number | boolean | null;
export type JobArgs = Readonly<Record<string, JobScalar | readonly JobScalar[]>>;

export interface EnqueueOptions {
  queue: JobQueue;
  /** Legacy `countdown`, in seconds. Omit to run as soon as a worker is free. */
  delaySeconds?: number;
}

export interface EnqueuedJob {
  jobId: string;
  name: JobName;
  queue: JobQueue;
  /** Epoch milliseconds when the job becomes runnable. */
  dueAt: number;
}

/**
 * Producer-side port. The implementation records requestId/userId from the current trace context
 * (observability/context.ts) on the job, so worker logs carry the originating trace.
 */
export interface JobProducer {
  enqueue(name: JobName, args: JobArgs, options: EnqueueOptions): Promise<EnqueuedJob>;
}

/** Context passed to a handler. The handler must not log args or results. */
export interface JobContext {
  jobId: string;
  name: JobName;
  requestId: string | null;
  userId: string | null;
  signal: AbortSignal;
}

export type JobHandler = (args: JobArgs, context: JobContext) => Promise<void>;

/** Worker-side registry. Each module registers the handlers for the jobs it owns. */
export interface JobHandlerRegistry {
  register(name: JobName, handler: JobHandler): void;
}
