import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { AppError } from '../../../domain/errors.js';
import { stringifyNumericJson } from '../../upstream.js';
import { wireId } from '../payloads.js';
import { paymentOutbox } from './schema.js';
import { Order } from '../../../db/legacy-schema.js';
import type { LocalOrderMessageDelivery } from '../order-messages/service.js';
import type { DeliveryObserver } from '../delivery.js';
import { boundedText } from '../../../domain/http-json.js';
import { randomBytes } from 'node:crypto';
import { feedbackProofContract } from '../feedback-proof.js';
import {
  orderMessageContract,
  orderMessageResponseProof,
  assertOrderMessageResponseProof,
  type OrderMessageScope,
} from '../order-message-proof.js';

export interface PaymentDeliveryEnvironment {
  orderProducerUrl: string;
  orderProducerAppId: string;
  orderProducerAppKey: string;
  engagementUrl: string;
  orderSmsUrl?: string;
  orderSmsContract?: string;
  orderSmsKey?: string;
}
export function paymentDeliveryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): PaymentDeliveryEnvironment {
  const value = z
    .object({
      TSS_ORDER_PRODUCER_URL: z.url(),
      TSS_ORDER_PRODUCER_APP_ID: z.string().min(1),
      TSS_ORDER_PRODUCER_APP_KEY: z.string().min(16),
      TSS_ORDER_ENGAGEMENT_URL: z.url(),
      TSS_ORDER_SMS_URL: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.url().optional(),
      ),
      UPSTREAM_POS_ORDER_SMS_CONTRACT: z.string().optional(),
      TSS_POS_ORDER_SMS_KEY: z.string().optional(),
    })
    .parse(env);
  return {
    orderProducerUrl: value.TSS_ORDER_PRODUCER_URL,
    orderProducerAppId: value.TSS_ORDER_PRODUCER_APP_ID,
    orderProducerAppKey: value.TSS_ORDER_PRODUCER_APP_KEY,
    engagementUrl: value.TSS_ORDER_ENGAGEMENT_URL,
    orderSmsUrl: value.TSS_ORDER_SMS_URL,
    orderSmsContract: value.UPSTREAM_POS_ORDER_SMS_CONTRACT,
    orderSmsKey: value.TSS_POS_ORDER_SMS_KEY,
  };
}
export function paymentOutboxDispatcher(
  db: Databases,
  config: Config,
  environment: PaymentDeliveryEnvironment,
  fetcher: typeof fetch = fetch,
  observe?: DeliveryObserver,
  localSms?: LocalOrderMessageDelivery,
) {
  const messageUrl = environment.orderSmsUrl ? new URL(environment.orderSmsUrl) : null;
  const messageKey = environment.orderSmsKey ?? '';
  const smsEnabled = Boolean(
    messageUrl &&
    messageUrl.pathname === '/internal/pos/order-messages' &&
    !messageUrl.search &&
    !messageUrl.hash &&
    environment.orderSmsContract === orderMessageContract &&
    /^[!-~]{32,4096}$/.test(messageKey) &&
    messageKey !== environment.orderProducerAppKey,
  );
  if (localSms && smsEnabled)
    throw new AppError(
      503,
      'ORDER_MESSAGE_DELIVERY_AMBIGUOUS',
      'Select one configured order-message delivery adapter.',
    );
  for (const raw of [
    environment.orderProducerUrl,
    environment.engagementUrl,
    ...(environment.orderSmsUrl ? [environment.orderSmsUrl] : []),
  ]) {
    const url = new URL(raw);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    )
      throw new AppError(
        503,
        'PAYMENT_DELIVERY_UNAVAILABLE',
        'Payment delivery integrations require HTTPS.',
      );
  }
  return async function dispatch(limit = 10) {
    const batchSize = z.number().int().min(1).max(100).parse(limit),
      summary = { delivered: 0, rejected: 0, uncertain: 0 };
    for (let index = 0; index < batchSize; index++) {
      const claimed = await db.get('writer').transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(paymentOutbox)
          .where(
            and(
              eq(paymentOutbox.status, 'pending'),
              or(
                inArray(paymentOutbox.kind, ['order-kinesis', 'order-engagement']),
                ...(localSms || smsEnabled
                  ? [
                      and(
                        eq(paymentOutbox.kind, 'order-sms'),
                        sql`EXISTS (SELECT 1 FROM ${Order} WHERE ${Order.id}=CAST(${paymentOutbox.orderId} AS UNSIGNED) AND ${Order.payment_statuses}=4)`,
                      ),
                    ]
                  : []),
              ),
            ),
          )
          .orderBy(asc(paymentOutbox.createdAt), asc(paymentOutbox.id))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!row) return null;
        let prepared: Awaited<ReturnType<LocalOrderMessageDelivery['prepare']>> | null = null;
        if (row.kind === 'order-sms' && localSms) {
          try {
            prepared = await localSms.prepare(tx, {
              id: row.id,
              orderId: row.orderId,
              storeId: row.storeId,
              operatorId: row.operatorId ?? '',
              requestId: row.requestId ?? row.id,
            });
          } catch (error) {
            observe?.({
              id: row.id,
              resource: 'order-sms',
              outcome: 'blocked',
              requestId: row.requestId,
              operatorId: row.operatorId,
            });
            throw error;
          }
        }
        await tx
          .update(paymentOutbox)
          .set({ status: 'processing' })
          .where(eq(paymentOutbox.id, row.id));
        return { row, prepared };
      });
      if (!claimed) break;
      const job = claimed.row;
      let status: 'delivered' | 'rejected' | 'uncertain' = 'uncertain';
      try {
        if (claimed.prepared) {
          await claimed.prepared.send();
          status = 'delivered';
        } else {
          const producer = job.kind === 'order-kinesis',
            sms = job.kind === 'order-sms';
          const messageScope: OrderMessageScope | null = sms
            ? {
                eventId: job.id,
                orderId: job.orderId,
                operatorId: job.operatorId ?? '',
                requestId: job.requestId ?? job.id,
                nonce: randomBytes(24).toString('base64url'),
              }
            : null;
          // Validate the durable initiating actor/scope before any external dispatch.
          if (messageScope) {
            orderMessageResponseProof(messageScope, '', messageKey);
          }
          const response = await fetcher(
            producer
              ? environment.orderProducerUrl
              : sms
                ? environment.orderSmsUrl!
                : environment.engagementUrl,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': job.id,
                ...(job.requestId ? { 'X-Request-ID': job.requestId } : {}),
                ...(messageScope
                  ? {
                      'X-POS-Order-SMS-Key': messageKey,
                      'X-POS-Order-SMS-Contract': orderMessageContract,
                      'X-POS-Feedback-Contract': feedbackProofContract,
                      'X-POS-Order-SMS-Nonce': messageScope.nonce,
                      'X-POS-Operator-ID': messageScope.operatorId,
                      'X-Request-ID': messageScope.requestId,
                    }
                  : {}),
                ...(producer
                  ? {
                      'ar-app-id': environment.orderProducerAppId,
                      'ar-app-key': environment.orderProducerAppKey,
                    }
                  : {}),
              },
              body: stringifyNumericJson(
                producer ? { payload: wireId(job.orderId) } : { order_id: wireId(job.orderId) },
              ),
              signal: AbortSignal.timeout(10000),
              redirect: 'error',
            },
          );
          status = sms
            ? 'uncertain'
            : response.ok
              ? 'delivered'
              : response.status >= 400 && response.status < 500
                ? 'rejected'
                : 'uncertain';
          if (messageScope && response.ok) {
            const body = await boundedText(response);
            assertOrderMessageResponseProof(response, messageScope, body, messageKey);
            const result = z
              .object({ message: z.literal('SMS Sent') })
              .strict()
              .safeParse(JSON.parse(body) as unknown);
            status = result.success ? 'delivered' : 'uncertain';
          }
          await response.body?.cancel();
        }
      } catch {
        status = 'uncertain';
        /* Unknown side effects remain frozen for explicit reconciliation. */
      }
      await db
        .get('writer')
        .update(paymentOutbox)
        .set({ status })
        .where(and(eq(paymentOutbox.id, job.id), eq(paymentOutbox.status, 'processing')));
      summary[status]++;
      observe?.({
        id: job.id,
        resource:
          job.kind === 'order-kinesis'
            ? 'order-kinesis'
            : job.kind === 'order-sms'
              ? 'order-sms'
              : 'order-engagement',
        outcome: status,
        requestId: job.requestId,
        operatorId: job.operatorId,
      });
    }
    return summary;
  };
}
