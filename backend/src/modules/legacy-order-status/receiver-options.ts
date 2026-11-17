import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import type { Config } from '../../config.js';
import { qualifiedStatusEndpoint, type WholeOrderStatusOptions } from './options.js';
const optional = <T extends z.ZodType>(value: T) =>
  z.preprocess((input) => (input === '' ? undefined : input), value.optional());
export function readStatusReceiverOptions(env: NodeJS.ProcessEnv = process.env) {
  const delay = z.coerce.number().int().min(0).max(900),
    rate = z.coerce.number().int().min(0).max(100000),
    window = z.coerce.number().int().min(1).max(3600);
  return z
    .object({
      WHOLE_ORDER_STATUS_RECEIVER_ENABLED: z.preprocess(
        (value) =>
          value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
        z.boolean(),
      ),
      WHOLE_ORDER_STATUS_RECEIVER_WORKER_ENABLED: z.preprocess(
        (value) =>
          value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
        z.boolean(),
      ),
      WHOLE_ORDER_STATUS_VENDOR_SHIPPED_URL: optional(z.url()),
      WHOLE_ORDER_STATUS_VENDOR_DELIVERED_URL: optional(z.url()),
      WHOLE_ORDER_STATUS_VENDOR_API_OWNER: optional(z.string().min(1).max(1024)),
      WHOLE_ORDER_STATUS_VENDOR_API_KEY: optional(z.string().min(16).max(1024)),
      TSS_EVENTS_URL: optional(z.url()),
      TSS_EVENTS_APP_ID: optional(z.string().min(1).max(1024)),
      TSS_EVENTS_APP_KEY: optional(z.string().min(16).max(1024)),
      SQS_STORE_ORDER_PACK_INITIAL_DELAY_SECONDS: delay.default(300),
      SQS_STORE_ORDER_SHIP_INITIAL_DELAY_SECONDS: delay.default(60),
      SQS_STORE_ORDER_DELIVER_INITIAL_DELAY_SECONDS: delay.default(60),
      SQS_STORE_ORDER_PACK_RETRY_DELAY_SECONDS: delay.default(60),
      SQS_STORE_ORDER_SHIP_RETRY_DELAY_SECONDS: delay.default(60),
      SQS_STORE_ORDER_DELIVER_RETRY_DELAY_SECONDS: delay.default(60),
      WHOLE_ORDER_STATUS_MAX_STAGE_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
      WHOLE_ORDER_STATUS_DEFINITE_REJECTION_CONTRACT: optional(
        z.literal('vinculum-status-no-effect-v1'),
      ),
      WHOLE_ORDER_STATUS_RETRY_RESPONSE_CODES: z.preprocess(
        (value) => {
          if (value === undefined || value === '') return [];
          if (typeof value !== 'string') return value;
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        },
        z
          .array(
            z
              .number()
              .int()
              .safe()
              .refine((value) => value !== 0 && value !== 1),
          )
          .max(50)
          .refine((value) => new Set(value).size === value.length),
      ),
      VINCULUM_PACK_RATE_LIMIT_MAX: rate.default(0),
      VINCULUM_SHIP_RATE_LIMIT_MAX: rate.default(0),
      VINCULUM_DELIVER_RATE_LIMIT_MAX: rate.default(100),
      VINCULUM_PACK_RATE_LIMIT_WINDOW_SECONDS: window.default(300),
      VINCULUM_SHIP_RATE_LIMIT_WINDOW_SECONDS: window.default(300),
      VINCULUM_DELIVER_RATE_LIMIT_WINDOW_SECONDS: window.default(300),
    })
    .superRefine((value, ctx) => {
      if (
        value.WHOLE_ORDER_STATUS_RETRY_RESPONSE_CODES.length &&
        !value.WHOLE_ORDER_STATUS_DEFINITE_REJECTION_CONTRACT
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Retryable response codes require the verified no-effect vendor contract.',
        });
    })
    .parse(env);
}
export type StatusReceiverOptions = ReturnType<typeof readStatusReceiverOptions>;
export function receiverEndpoints(
  config: Pick<Config, 'NODE_ENV' | 'DEMO_MODE'>,
  options: WholeOrderStatusOptions,
  receiver: StatusReceiverOptions,
) {
  qualifiedStatusEndpoint(config, options);
  if (
    !receiver.WHOLE_ORDER_STATUS_RECEIVER_ENABLED ||
    !receiver.WHOLE_ORDER_STATUS_VENDOR_SHIPPED_URL ||
    !receiver.WHOLE_ORDER_STATUS_VENDOR_DELIVERED_URL ||
    !receiver.WHOLE_ORDER_STATUS_VENDOR_API_OWNER ||
    !receiver.WHOLE_ORDER_STATUS_VENDOR_API_KEY ||
    !receiver.TSS_EVENTS_URL ||
    !receiver.TSS_EVENTS_APP_ID ||
    !receiver.TSS_EVENTS_APP_KEY
  )
    throw new AppError(
      503,
      'WHOLE_ORDER_STATUS_RECEIVER_NOT_READY',
      'The qualified STORE worker is not configured.',
    );
  const checked = (raw: string) => {
    const url = new URL(raw),
      local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          local &&
          (config.NODE_ENV !== 'production' || config.DEMO_MODE)
        ))
    )
      throw new AppError(
        503,
        'WHOLE_ORDER_STATUS_RECEIVER_NOT_READY',
        'The STORE worker requires private HTTPS service endpoints.',
      );
    return url.href.replace(/\/$/, '');
  };
  return {
    shipped: checked(receiver.WHOLE_ORDER_STATUS_VENDOR_SHIPPED_URL),
    delivered: checked(receiver.WHOLE_ORDER_STATUS_VENDOR_DELIVERED_URL),
    events: checked(receiver.TSS_EVENTS_URL),
  };
}
