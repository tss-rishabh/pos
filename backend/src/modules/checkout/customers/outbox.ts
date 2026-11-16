import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { Databases } from '../../../db/pools.js';
import type { DeliveryObserver } from '../delivery.js';
import { openRegistration } from './crypto.js';
import {
  registrationEnvelopeSchema,
  type RegistrationEnvironment,
  type RegistrationOtpSender,
} from './service.js';
import {
  customerRegistrationDeliveries as deliveries,
  customerRegistrationsTable as registrations,
} from './schema.js';

export function customerRegistrationOutboxDispatcher(
  db: Databases,
  environment: RegistrationEnvironment,
  sender: RegistrationOtpSender,
  observe?: DeliveryObserver,
  now: () => number = Date.now,
) {
  return async (maximum = 100) => {
    const outcome = { delivered: 0, uncertain: 0, cancelled: 0 },
      channels: ('sms' | 'whatsapp')[] = [];
    if (!environment.secret || environment.secret.length < 32) return outcome;
    for (const channel of ['sms', 'whatsapp'] as const)
      try {
        sender.assertReady(channel);
        channels.push(channel);
      } catch {
        /* Unconfigured resources remain pending. */
      }
    if (!channels.length) return outcome;
    for (let index = 0; index < Math.max(0, Math.min(100, maximum)); index++) {
      const claimed = await db.get('writer').transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(deliveries)
          .where(
            and(
              eq(deliveries.status, 'pending'),
              lte(deliveries.availableAt, now()),
              inArray(deliveries.channel, channels),
            ),
          )
          .orderBy(asc(deliveries.availableAt), asc(deliveries.id))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!job) return null;
        const [registration] = await tx
          .select()
          .from(registrations)
          .where(eq(registrations.id, job.registrationId))
          .limit(1);
        const live =
          registration &&
          ['pending', 'uncertain'].includes(registration.status) &&
          registration.verifiedAt === null &&
          registration.expiresAt > now() &&
          registration.codeHash !== '';
        await tx
          .update(deliveries)
          .set({ status: live ? 'processing' : 'cancelled', updatedAt: now() })
          .where(eq(deliveries.id, job.id));
        return { job, registration: live ? registration : null };
      });
      if (!claimed) break;
      if (!claimed.registration) {
        outcome.cancelled++;
        continue;
      }
      let status: 'delivered' | 'uncertain' = 'uncertain';
      try {
        const value = registrationEnvelopeSchema.parse(
          openRegistration(
            environment.secret,
            claimed.registration.id,
            claimed.registration.encryptedInput,
          ),
        );
        const channel = claimed.job.channel;
        if (
          !value.code ||
          (channel !== 'sms' && channel !== 'whatsapp') ||
          !channels.includes(channel)
        )
          throw new Error('Invalid registration delivery');
        await sender.send(value.details.telephone, value.code, channel);
        status = 'delivered';
      } catch {
        /* A dispatched message can have arrived; never resend this job automatically. */
      }
      await db
        .get('writer')
        .update(deliveries)
        .set({ status, updatedAt: now() })
        .where(and(eq(deliveries.id, claimed.job.id), eq(deliveries.status, 'processing')));
      outcome[status]++;
      observe?.({
        id: claimed.job.id,
        resource:
          claimed.job.channel === 'sms'
            ? 'customer-registration-sms'
            : 'customer-registration-whatsapp',
        outcome: status,
        requestId: claimed.job.requestId,
        operatorId: claimed.job.operatorId,
      });
    }
    return outcome;
  };
}
