import { z } from 'zod';
import type { Config } from '../../config.js';
import type { JobHandler, JobHandlerRegistry, JobName, JobProducer } from '../../jobs/contract.js';
import { tracedFetch } from '../../observability/context.js';
import { outboundAllowlistEnabled, outboundPermitted } from '../../outbound/allowlist.js';

/**
 * Order SMS, legacy Celery task `core.tasks.send_sms` (`core/tasks.py:70-81`), queued with `.delay`
 * by `AjaxOrderView.post` (`order/views.py:2831`) and fast checkout (`order/views.py:3336`) after the
 * payment confirmation succeeded. The handler asks API-v2 `omnichannel-sms` to send; the rewrite
 * never sends SMS itself.
 */
export const ORDER_SMS_JOB = 'core.tasks.send_sms' satisfies JobName;

/** Enqueue after the order's MySQL transaction has committed. Args carry the order ID only. */
export async function enqueueOrderSms(jobs: JobProducer | undefined, orderId: string) {
  if (!jobs) return null;
  return jobs.enqueue(ORDER_SMS_JOB, { order_id: orderIdArgument(orderId) }, { queue: 'core' });
}

function orderIdArgument(orderId: string): number | string {
  const value = BigInt(orderId);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : orderId;
}

export class OrderSmsJobError extends Error {
  constructor(
    readonly code: 'ORDER_SMS_NOT_CONFIGURED' | 'ORDER_SMS_REJECTED' | 'ORDER_SMS_FAILED',
  ) {
    super(code);
  }
}

const argsSchema = z
  .object({
    order_id: z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d{0,19}$/)]),
  })
  .strict();

export function orderSmsHandler(
  config: Pick<Config, 'TSS_API_BASE_URL'>,
  fetcher: typeof fetch = tracedFetch,
): JobHandler {
  return async (args, context) => {
    const { order_id: orderId } = argsSchema.parse(args);
    const base = config.TSS_API_BASE_URL;
    if (!base) throw new OrderSmsJobError('ORDER_SMS_NOT_CONFIGURED');
    // Legacy: `url = (MAIN_API_V2_URL or API_V2_URL) + "omnichannel-sms"`, header Content-Type only,
    // body {"order_id": order_id}, no timeout. A non-200 is only logged; there is no retry.
    const url = new URL('omnichannel-sms', base.endsWith('/') ? base : base + '/');
    // Allowlist guard (w25): API-v2 texts the order's contacts; suppressed = completed job.
    if (
      outboundAllowlistEnabled() &&
      !(await outboundPermitted({
        channel: 'api-v2',
        module: 'checkout',
        flow: 'order-sms',
        targets: [{ kind: 'order', id: orderId }],
      }))
    )
      return;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId }),
        redirect: 'error',
        signal: context.signal,
      });
    } catch {
      throw new OrderSmsJobError('ORDER_SMS_FAILED');
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 200) throw new OrderSmsJobError('ORDER_SMS_REJECTED');
  };
}

/** Worker-side registration of the checkout module's jobs. W8 calls this with the real registry. */
export function registerJobHandlers(
  registry: JobHandlerRegistry,
  options: { config: Pick<Config, 'TSS_API_BASE_URL'>; fetcher?: typeof fetch },
) {
  registry.register(ORDER_SMS_JOB, orderSmsHandler(options.config, options.fetcher));
}
