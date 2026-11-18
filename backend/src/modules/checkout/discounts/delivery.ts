import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { PosUser, Store } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import { boundedJson } from '../../../domain/http-json.js';
import type { DeliveryObserver } from '../delivery.js';
import { checkoutSessions } from '../schema.js';
import { decryptCode } from './crypto.js';
import { discountAudits, discountChallenges, discountDeliveries } from './schema.js';

export interface DiscountDeliveryEnvironment {
  url?: string;
  apiKey?: string;
  approvalSecret?: string;
}
export function discountDeliveryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DiscountDeliveryEnvironment {
  return {
    url: env.NETCORE_EMAIL_URL || undefined,
    apiKey: env.NETCORE_API_KEY || undefined,
    approvalSecret: env.DISCOUNT_APPROVAL_SECRET || undefined,
  };
}
export function assertDiscountDeliveryReady(
  environment: DiscountDeliveryEnvironment,
  code = true,
): void {
  if (
    !environment.url ||
    !environment.apiKey ||
    (code && (!environment.approvalSecret || environment.approvalSecret.length < 32))
  )
    throw new AppError(
      503,
      'DISCOUNT_DELIVERY_UNAVAILABLE',
      'Manager approval email delivery is not configured.',
    );
  if (!z.url().safeParse(environment.url).success)
    throw new AppError(
      503,
      'DISCOUNT_DELIVERY_UNAVAILABLE',
      'Manager approval email requires a configured HTTPS endpoint.',
    );
  const endpoint = new URL(environment.url);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new AppError(
      503,
      'DISCOUNT_DELIVERY_UNAVAILABLE',
      'Manager approval email requires a configured HTTPS endpoint.',
    );
}
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
/** Send one durable business email once; unknown delivery outcomes stay frozen. */
export function discountOutboxDispatcher(
  db: Databases,
  environment: DiscountDeliveryEnvironment,
  fetcher: typeof fetch = fetch,
  observe?: DeliveryObserver,
  now = Date.now,
) {
  return async function dispatch(limit = 10) {
    const batch = z.number().int().min(1).max(100).parse(limit),
      summary = { delivered: 0, rejected: 0, uncertain: 0 };
    for (let index = 0; index < batch; index++) {
      const [waiting] = await db
        .get('writer')
        .select({ kind: discountDeliveries.kind })
        .from(discountDeliveries)
        .where(eq(discountDeliveries.status, 'pending'))
        .limit(1);
      if (!waiting) break;
      assertDiscountDeliveryReady(environment, waiting.kind === 'approval-code');
      const job = await db.get('writer').transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(discountDeliveries)
          .where(eq(discountDeliveries.status, 'pending'))
          .orderBy(asc(discountDeliveries.createdAt), asc(discountDeliveries.id))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!row) return null;
        assertDiscountDeliveryReady(environment, row.kind === 'approval-code');
        await tx
          .update(discountDeliveries)
          .set({ status: 'processing' })
          .where(eq(discountDeliveries.id, row.id));
        return row;
      });
      if (!job) break;
      let outcome: 'delivered' | 'rejected' | 'uncertain' = 'uncertain';
      try {
        const [session] = await db
          .get('writer')
          .select({ state: checkoutSessions.state })
          .from(checkoutSessions)
          .where(eq(checkoutSessions.id, job.checkoutId))
          .limit(1);
        const [recipient] = await db
          .get('writer')
          .select({
            email: PosUser.contact_email,
            name: PosUser.first_name,
            active: PosUser.is_active,
          })
          .from(PosUser)
          .where(eq(PosUser.id, BigInt(job.targetId)))
          .limit(1);
        const [requestor] = await db
          .get('writer')
          .select({ name: PosUser.first_name })
          .from(PosUser)
          .where(eq(PosUser.id, BigInt(job.operatorId)))
          .limit(1);
        const [store] = session
          ? await db
              .get('writer')
              .select({ name: Store.store_name })
              .from(Store)
              .where(eq(Store.id, BigInt(session.state.storeId)))
              .limit(1)
          : [];
        let subject: string | null = null,
          body = '';
        if (
          session &&
          recipient?.active &&
          recipient.email &&
          z.email().safeParse(recipient.email).success &&
          store
        ) {
          // Legacy core/tasks.py:254,261 formats first_name in an f-string: NULL -> 'None'.
          const name = escapeHtml(recipient.name ?? 'None'),
            storeName = escapeHtml(store.name || ''),
            requestedBy = escapeHtml(requestor?.name || '');
          if (job.kind === 'approval-code' && job.encryptedCode) {
            const [row] = await db
                .get('writer')
                .select()
                .from(discountChallenges)
                .where(eq(discountChallenges.checkoutId, job.checkoutId))
                .limit(1),
              challenge = row?.state;
            if (
              challenge &&
              challenge.id === job.challengeId &&
              challenge.expiresAt > now() &&
              !challenge.approvedBy &&
              challenge.attempts < 5 &&
              challenge.codes.some((code) => code.managerId === job.targetId)
            ) {
              const code = decryptCode(environment.approvalSecret!, job.id, job.encryptedCode);
              subject = 'PG Discount OTP Mail';
              body = `Hello ${name}, <br><br>Your OTP for PG Discount - <b>${code}</b><br><br>Store - ${storeName}<br>Requested By - ${requestedBy}<br>PG Discount Value - ${challenge.amount}<br>Total Bill Amount Without GST - ${challenge.productsTotal}<br><i>This code expires in ${Math.ceil((challenge.expiresAt - now()) / 60000)} minute(s).</i>`;
            }
          } else if (job.kind === 'discount-used' && job.orderId) {
            const [audit] = await db
              .get('writer')
              .select()
              .from(discountAudits)
              .where(
                and(
                  eq(discountAudits.orderId, job.orderId),
                  eq(discountAudits.checkoutId, job.checkoutId),
                ),
              )
              .limit(1);
            if (audit && job.targetId === (audit.approvedBy || audit.appliedBy)) {
              subject = 'PG Discount Used For Order - ' + job.orderId;
              body = `Hello ${name}, <br><br>${audit.approvedBy ? 'Your PG Discount approval has been applied.' : 'PG Discount has been applied from your account.'}<br><br>Order ID - ${escapeHtml(job.orderId)}<br>PG Discount Comment - ${escapeHtml(audit.comment)}<br>PG Discount Value - ${audit.amount}<br>Applied By - ${requestedBy}<br>Store Name - ${storeName}`;
            }
          }
        }
        if (!subject) outcome = 'rejected';
        else {
          const response = await fetcher(environment.url!, {
            method: 'POST',
            headers: {
              api_key: environment.apiKey!,
              'Content-Type': 'application/json',
              'Idempotency-Key': job.id,
            },
            body: JSON.stringify({
              from: { email: 'connect@thesouledstore.com', name: 'The Souled Store' },
              subject,
              content: [{ type: 'html', value: body }],
              personalizations: [{ to: [{ email: recipient!.email, name: recipient!.name }] }],
            }),
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          });
          if (!response.ok) {
            outcome = response.status >= 400 && response.status < 500 ? 'rejected' : 'uncertain';
            await response.body?.cancel();
          } else
            outcome = z
              .object({ status: z.literal('success') })
              .safeParse(await boundedJson(response, 64000)).success
              ? 'delivered'
              : 'uncertain';
        }
      } catch {
        /* A crash/timeout never repeats a manager code or approval notification. */
      }
      await db
        .get('writer')
        .update(discountDeliveries)
        .set({ status: outcome, encryptedCode: null })
        .where(and(eq(discountDeliveries.id, job.id), eq(discountDeliveries.status, 'processing')));
      summary[outcome]++;
      observe?.({
        id: job.id,
        resource: job.kind === 'approval-code' ? 'discount-approval-email' : 'discount-used-email',
        outcome,
        requestId: job.requestId,
        operatorId: job.operatorId,
      });
    }
    return summary;
  };
}
