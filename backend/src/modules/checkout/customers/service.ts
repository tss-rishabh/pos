import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { MUser } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { currentRequestTrace } from '../../../observability/context.js';
import type { CheckoutState } from '../contracts.js';
import type { CheckoutGateway } from '../gateway.js';
import { checkoutSessions } from '../schema.js';
import {
  assertNoActiveContactChangeReservation,
  lockCustomerContactKeys,
} from '../../customer-contacts/reservations.js';
import {
  registrationDetailsSchema,
  registrationPayload,
  validateRegistrationDetails,
  type CustomerRegistrations,
  type PublicRegistration,
  type RegistrationDetails,
} from './contracts.js';
import {
  openRegistration,
  registrationCode,
  registrationCodeDigest,
  registrationCodeMatches,
  registrationDigest,
  sealRegistration,
} from './crypto.js';
import {
  customerRegistrationClaims as claims,
  customerRegistrationDeliveries as deliveries,
  customerRegistrationLimits as limits,
  customerRegistrationsTable as registrations,
} from './schema.js';

export interface RegistrationEnvironment {
  secret?: string;
  ttlSeconds?: number;
  fallbackSeconds: number;
}
export interface RegistrationOtpSender {
  assertReady(channel: 'sms' | 'whatsapp'): void;
  send(phone: string, code: string, channel: 'sms' | 'whatsapp'): Promise<void>;
}
export function registrationEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RegistrationEnvironment {
  const optional = z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().optional(),
  );
  const value = z
    .object({
      CUSTOMER_REGISTRATION_SECRET: optional,
      LOGIN_OTP_EXPIRY: z.preprocess(
        (input) => (input === '' || input === undefined ? undefined : Number(input)),
        z.number().int().min(60).max(900).optional(),
      ),
      WHATSAPP_OTP_FALLBACK_DELAY_TIME: z.coerce.number().int().min(1).max(300).default(20),
    })
    .parse(env);
  return {
    secret: value.CUSTOMER_REGISTRATION_SECRET,
    ttlSeconds: value.LOGIN_OTP_EXPIRY,
    fallbackSeconds: value.WHATSAPP_OTP_FALLBACK_DELAY_TIME,
  };
}
export function assertRegistrationReady(
  environment: RegistrationEnvironment,
): asserts environment is RegistrationEnvironment & { secret: string; ttlSeconds: number } {
  if (!environment.secret || environment.secret.length < 32 || !environment.ttlSeconds)
    throw new AppError(
      503,
      'CUSTOMER_REGISTRATION_UNAVAILABLE',
      'Customer verification is not configured.',
    );
}
export const registrationEnvelopeSchema = z
  .object({
    details: registrationDetailsSchema,
    code: z
      .string()
      .regex(/^[1-9]{6}$/)
      .optional(),
  })
  .strict();
type Writer = ReturnType<Databases['get']>;
type Transaction = Parameters<Parameters<Writer['transaction']>[0]>[0];
type RegistrationRow = typeof registrations.$inferSelect;
const scope = (state: CheckoutState, id: string) =>
  and(
    eq(registrations.id, id),
    eq(registrations.checkoutId, state.id),
    eq(registrations.operatorId, state.operatorId),
    eq(registrations.storeId, state.storeId),
    eq(registrations.counterId, state.counterId),
  );
const notFound = () =>
  new AppError(
    404,
    'CUSTOMER_REGISTRATION_NOT_FOUND',
    'This registration was not found for the checkout.',
  );
const review = () =>
  new AppError(
    409,
    'CUSTOMER_REGISTRATION_REVIEW_REQUIRED',
    'The saved registration needs reconciliation before another registration can be dispatched.',
  );

export function customerRegistrationService(
  db: Databases,
  gateway: CheckoutGateway,
  environment: RegistrationEnvironment,
  sender: RegistrationOtpSender,
  timeZone: string,
  now: () => number = Date.now,
): CustomerRegistrations {
  function secret() {
    assertRegistrationReady(environment);
    return environment.secret;
  }
  const contactKeys = (row: Pick<RegistrationRow, 'phoneHash' | 'emailHash'>) =>
    [`email:${row.emailHash}`, `phone:${row.phoneHash}`].sort();
  const budgetKeys = (row: Pick<RegistrationRow, 'operatorId' | 'phoneHash'>) =>
    [`operator:${row.operatorId}`, `phone:${row.phoneHash}`].sort();
  async function get(
    state: CheckoutState,
    id = state.registrationId,
    reader: Pick<Writer, 'select'> = db.get('writer'),
  ) {
    if (!id) throw notFound();
    const [row] = await reader.select().from(registrations).where(scope(state, id)).limit(1);
    if (!row) throw notFound();
    return row;
  }
  async function lock(tx: Transaction, state: CheckoutState) {
    const initial = await get(state, state.registrationId, tx);
    if (initial.status !== 'registered')
      for (const key of contactKeys(initial)) {
        const [claim] = await tx.select().from(claims).where(eq(claims.key, key)).for('update');
        if (!claim || claim.registrationId !== initial.id)
          throw new AppError(
            409,
            'CUSTOMER_REGISTRATION_SUPERSEDED',
            'Request a new verification code for this registration.',
          );
      }
    const [row] = await tx
      .select()
      .from(registrations)
      .where(scope(state, initial.id))
      .for('update');
    if (!row) throw notFound();
    return row;
  }
  async function budgets(tx: Transaction, row: Pick<RegistrationRow, 'operatorId' | 'phoneHash'>) {
    const output: (typeof limits.$inferSelect)[] = [];
    for (const key of budgetKeys(row)) {
      await tx
        .insert(limits)
        .values({
          key,
          lastSentAt: 0,
          sendWindowAt: now(),
          sends: 0,
          failureWindowAt: now(),
          failures: 0,
        })
        .onDuplicateKeyUpdate({ set: { key } });
      const [value] = await tx.select().from(limits).where(eq(limits.key, key)).for('update');
      output.push(value!);
    }
    return output;
  }
  const input = (row: RegistrationRow) =>
    registrationEnvelopeSchema.parse(openRegistration(secret(), row.id, row.encryptedInput));
  async function publicRow(row: RegistrationRow): Promise<PublicRegistration> {
    const jobs = await db
      .get('writer')
      .select({
        channel: deliveries.channel,
        status: deliveries.status,
        createdAt: deliveries.createdAt,
      })
      .from(deliveries)
      .where(eq(deliveries.registrationId, row.id))
      .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
      .limit(2);
    const status = ['registered', 'dispatching', 'uncertain'].includes(row.status)
      ? row.status
      : row.attempts >= 5
        ? 'locked'
        : row.expiresAt <= now()
          ? 'expired'
          : row.status;
    return {
      id: row.id,
      status: z
        .enum([
          'pending',
          'verified',
          'dispatching',
          'registered',
          'uncertain',
          'expired',
          'locked',
        ])
        .parse(status),
      expiresAt: row.expiresAt,
      retryAt: Math.max(row.createdAt, ...jobs.map((job) => job.createdAt)) + 60_000,
      attemptsRemaining: Math.max(0, 5 - row.attempts),
      customerId: row.customerId,
      verifiedAt: row.verifiedAt,
      deliveries: jobs
        .filter(
          (job) =>
            job.createdAt === Math.max(row.createdAt, ...jobs.map((value) => value.createdAt)),
        )
        .map((job) => ({
          channel: z.enum(['sms', 'whatsapp']).parse(job.channel),
          status: job.status,
        })),
    };
  }
  async function existingContacts(reader: Pick<Writer, 'select'>, details: RegistrationDetails) {
    const email = details.email || `${details.telephone}@temp.id`;
    const phone = await reader
      .select({
        id: MUser.id,
        email: MUser.email,
        phone: MUser.telephone,
        active: MUser.status,
        blocked: MUser.is_block,
      })
      .from(MUser)
      .where(eq(MUser.telephone, details.telephone))
      .limit(2);
    const emails = await reader
      .select({ id: MUser.id })
      .from(MUser)
      .where(eq(MUser.email, email))
      .limit(2);
    return { phone, emails, email };
  }
  async function acceptCustomer(state: CheckoutState, expectedId?: string) {
    return db.get('writer').transaction(async (tx) => {
      const row = await lock(tx, state);
      if (row.status === 'registered') return row;
      if (!['dispatching', 'uncertain'].includes(row.status) || !row.verifiedAt) throw review();
      if (row.verifiedAt + 15 * 60_000 <= now())
        throw new AppError(
          403,
          'CUSTOMER_REGISTRATION_REVERIFICATION_REQUIRED',
          'Verify a new code before reconciling this registration.',
        );
      const value = input(row),
        matched = await existingContacts(tx, value.details);
      const customer = matched.phone[0];
      if (
        matched.phone.length !== 1 ||
        matched.emails.length !== 1 ||
        !customer ||
        customer.email.toLowerCase() !== matched.email.toLowerCase() ||
        matched.emails[0]!.id !== customer.id ||
        (expectedId && String(customer.id) !== expectedId) ||
        customer.active !== 1 ||
        customer.blocked === 1
      )
        throw new AppError(
          503,
          'CUSTOMER_REGISTRATION_UNCONFIRMED',
          'A matching registered customer has not been proved on the writer. Keep this registration reference.',
        );
      // The source registration UI sends these fields, but pinned create_user
      // ignores them. Bind their intended update to the verified contact pair.
      await tx
        .update(MUser)
        .set({ customer_type: value.details.customerType, gstin: value.details.gstin })
        .where(eq(MUser.id, customer.id));
      await tx
        .update(registrations)
        .set({
          status: 'registered',
          customerId: String(customer.id),
          codeHash: '',
          encryptedInput: sealRegistration(secret(), row.id, { details: value.details }),
          updatedAt: now(),
        })
        .where(scope(state, row.id));
      await tx
        .delete(claims)
        .where(and(inArray(claims.key, contactKeys(row)), eq(claims.registrationId, row.id)));
      await tx
        .update(deliveries)
        .set({ status: 'cancelled', updatedAt: now() })
        .where(and(eq(deliveries.registrationId, row.id), eq(deliveries.status, 'pending')));
      return { ...row, status: 'registered', customerId: String(customer.id), codeHash: '' };
    });
  }
  return {
    async request(state, id, raw) {
      assertRegistrationReady(environment);
      sender.assertReady('sms');
      const details = validateRegistrationDetails(raw, timeZone, now()),
        phoneHash = registrationDigest(secret(), 'phone', details.telephone),
        emailHash = registrationDigest(
          secret(),
          'email',
          (details.email || `${details.telephone}@temp.id`).toLowerCase(),
        ),
        requestHash = registrationDigest(secret(), 'request', JSON.stringify(details)),
        code = registrationCode();
      let whatsapp = false;
      try {
        sender.assertReady('whatsapp');
        whatsapp = true;
      } catch {
        /* Fallback is optional; SMS readiness is mandatory. */
      }
      const row = await db.get('writer').transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(checkoutSessions)
          .where(
            and(
              eq(checkoutSessions.id, state.id),
              eq(checkoutSessions.operatorId, state.operatorId),
              eq(checkoutSessions.storeId, state.storeId),
            ),
          )
          .for('update');
        if (
          !session ||
          session.state.busyOperationId !== id ||
          session.state.counterId !== state.counterId
        )
          throw new AppError(
            409,
            'CHECKOUT_OPERATION_CHANGED',
            'This registration request is no longer active.',
          );
        const reservedContacts = contactKeys({ phoneHash, emailHash });
        await lockCustomerContactKeys(tx, reservedContacts);
        await assertNoActiveContactChangeReservation(tx, reservedContacts, now());
        const [prior] = await tx
          .select()
          .from(registrations)
          .where(eq(registrations.id, id))
          .limit(1);
        if (prior) {
          if (
            prior.checkoutId !== state.id ||
            prior.operatorId !== state.operatorId ||
            prior.storeId !== state.storeId ||
            prior.counterId !== state.counterId ||
            prior.requestHash !== requestHash
          )
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This registration identifier was used for different details.',
            );
          return prior;
        }
        if (state.registrationId) {
          const previous = await get(state, state.registrationId, tx);
          if (['dispatching', 'uncertain', 'registered'].includes(previous.status)) throw review();
        }
        for (const key of contactKeys({ phoneHash, emailHash })) {
          await tx
            .insert(claims)
            .values({ key, registrationId: id })
            .onDuplicateKeyUpdate({ set: { key } });
          const [claim] = await tx.select().from(claims).where(eq(claims.key, key)).for('update');
          if (claim!.registrationId !== id) {
            const [owner] = await tx
              .select()
              .from(registrations)
              .where(eq(registrations.id, claim!.registrationId))
              .for('update');
            if (
              owner &&
              (['dispatching', 'uncertain', 'registered'].includes(owner.status) ||
                (owner.checkoutId !== state.id && owner.expiresAt > now()))
            )
              throw new AppError(
                409,
                'CUSTOMER_REGISTRATION_BUSY',
                'A registration for this contact is already pending.',
              );
            if (owner && owner.checkoutId === state.id) {
              await tx
                .update(registrations)
                .set({ expiresAt: now(), updatedAt: now() })
                .where(eq(registrations.id, owner.id));
              await tx
                .update(deliveries)
                .set({ status: 'cancelled', updatedAt: now() })
                .where(
                  and(eq(deliveries.registrationId, owner.id), eq(deliveries.status, 'pending')),
                );
            }
            await tx.update(claims).set({ registrationId: id }).where(eq(claims.key, key));
          }
        }
        const found = await existingContacts(tx, details);
        if (found.phone.length || found.emails.length)
          throw new AppError(
            409,
            'CUSTOMER_ALREADY_REGISTERED',
            'The phone or email is already registered. Find and connect the existing customer.',
          );
        for (const limit of await budgets(tx, { operatorId: state.operatorId, phoneHash })) {
          const sends = limit.sendWindowAt + 3600_000 > now() ? limit.sends : 0,
            failures = limit.failureWindowAt + 600_000 > now() ? limit.failures : 0;
          if (
            limit.lastSentAt + (limit.key.startsWith('phone:') ? 60_000 : 10_000) > now() ||
            sends >= (limit.key.startsWith('phone:') ? 5 : 60) ||
            failures >= 5
          )
            throw new AppError(
              429,
              'CUSTOMER_REGISTRATION_RATE_LIMITED',
              'Customer verification is temporarily limited. Wait before requesting another code.',
            );
          await tx
            .update(limits)
            .set({
              lastSentAt: now(),
              sends: sends + 1,
              sendWindowAt: sends ? limit.sendWindowAt : now(),
            })
            .where(eq(limits.key, limit.key));
        }
        const created: RegistrationRow = {
          id,
          checkoutId: state.id,
          operatorId: state.operatorId,
          storeId: state.storeId,
          counterId: state.counterId,
          requestHash,
          phoneHash,
          emailHash,
          encryptedInput: sealRegistration(secret(), id, { details, code }),
          codeHash: registrationCodeDigest(secret(), id, state.id, code),
          status: 'pending',
          attempts: 0,
          expiresAt: now() + environment.ttlSeconds! * 1000,
          verifiedAt: null,
          customerId: null,
          createdAt: now(),
          updatedAt: now(),
        };
        await tx.insert(registrations).values(created);
        // Persist the recovery reference with the queued delivery so a process
        // crash cannot leave an undiscoverable customer-verification message.
        await tx
          .update(checkoutSessions)
          .set({ state: { ...session.state, registrationId: id, updatedAt: now() } })
          .where(eq(checkoutSessions.id, state.id));
        const trace = currentRequestTrace();
        await tx.insert(deliveries).values(
          (whatsapp ? (['sms', 'whatsapp'] as const) : (['sms'] as const)).map((channel) => ({
            id: `${id}:${channel}`,
            registrationId: id,
            channel,
            status: 'pending',
            availableAt: now() + (channel === 'whatsapp' ? environment.fallbackSeconds * 1000 : 0),
            requestId: trace?.requestId ?? null,
            operatorId: state.operatorId,
            createdAt: now(),
            updatedAt: now(),
          })),
        );
        return created;
      });
      return publicRow(row);
    },
    async read(state) {
      return state.registrationId ? publicRow(await get(state)) : null;
    },
    async verifiedCustomerUntil(state, customer) {
      if (!state.registrationId) return null;
      const row = await get(state);
      if (
        row.status !== 'registered' ||
        row.customerId !== customer.id ||
        !row.verifiedAt ||
        row.verifiedAt + 15 * 60_000 <= now() ||
        !customer.active
      )
        return null;
      const value = input(row).details;
      return customer.telephone === value.telephone &&
        customer.email.toLowerCase() === (value.email || `${value.telephone}@temp.id`).toLowerCase()
        ? row.verifiedAt + 15 * 60_000
        : null;
    },
    async cancel(state) {
      if (!state.registrationId) return true;
      return db.get('writer').transaction(async (tx) => {
        const row = await lock(tx, state);
        if (['dispatching', 'uncertain'].includes(row.status)) return false;
        if (row.status === 'registered') return true;
        const value = input(row);
        await tx
          .update(registrations)
          .set({
            status: 'expired',
            codeHash: '',
            expiresAt: now(),
            encryptedInput: sealRegistration(secret(), row.id, { details: value.details }),
            updatedAt: now(),
          })
          .where(scope(state, row.id));
        await tx
          .delete(claims)
          .where(and(inArray(claims.key, contactKeys(row)), eq(claims.registrationId, row.id)));
        await tx
          .update(deliveries)
          .set({ status: 'cancelled', updatedAt: now() })
          .where(and(eq(deliveries.registrationId, row.id), eq(deliveries.status, 'pending')));
        return true;
      });
    },
    async verify(state, code) {
      secret();
      const outcome = await db.get('writer').transaction(async (tx) => {
        const row = await lock(tx, state);
        if (
          ['verified', 'registered'].includes(row.status) ||
          (row.status === 'uncertain' && row.verifiedAt !== null && row.codeHash === '')
        )
          return { row, error: null };
        if (
          !['pending', 'uncertain'].includes(row.status) ||
          row.expiresAt <= now() ||
          row.attempts >= 5
        )
          return { row, error: 'CUSTOMER_REGISTRATION_CODE_EXPIRED' };
        const budget = await budgets(tx, row);
        if (budget.some((value) => value.failureWindowAt + 600_000 > now() && value.failures >= 5))
          return { row, error: 'CUSTOMER_REGISTRATION_ATTEMPT_LIMIT' };
        const [delivery] = await tx
          .select({ id: deliveries.id })
          .from(deliveries)
          .where(
            and(
              eq(deliveries.registrationId, row.id),
              inArray(deliveries.status, ['processing', 'delivered', 'uncertain']),
            ),
          )
          .limit(1);
        if (!delivery) return { row, error: 'CUSTOMER_REGISTRATION_DELIVERY_PENDING' };
        if (!registrationCodeMatches(secret(), row.id, state.id, code, row.codeHash)) {
          await tx
            .update(registrations)
            .set({ attempts: row.attempts + 1, updatedAt: now() })
            .where(scope(state, row.id));
          for (const value of budget) {
            const fresh = value.failureWindowAt + 600_000 <= now();
            await tx
              .update(limits)
              .set({
                failures: fresh ? 1 : value.failures + 1,
                failureWindowAt: fresh ? now() : value.failureWindowAt,
              })
              .where(eq(limits.key, value.key));
          }
          return { row, error: 'CUSTOMER_REGISTRATION_CODE_INVALID' };
        }
        const status = row.status === 'uncertain' ? 'uncertain' : 'verified';
        await tx
          .update(registrations)
          .set({ status, verifiedAt: now(), codeHash: '', updatedAt: now() })
          .where(scope(state, row.id));
        await tx
          .update(deliveries)
          .set({ status: 'cancelled', updatedAt: now() })
          .where(and(eq(deliveries.registrationId, row.id), eq(deliveries.status, 'pending')));
        return { row: { ...row, status, verifiedAt: now(), codeHash: '' }, error: null };
      });
      if (outcome.error)
        throw new AppError(
          outcome.error === 'CUSTOMER_REGISTRATION_ATTEMPT_LIMIT' ? 429 : 422,
          outcome.error,
          'Customer verification is not confirmed. Check delivery, expiry and remaining attempts.',
        );
      return publicRow(outcome.row);
    },
    async resend(state, operationId) {
      assertRegistrationReady(environment);
      sender.assertReady('sms');
      let whatsapp = false;
      try {
        sender.assertReady('whatsapp');
        whatsapp = true;
      } catch {
        /* Optional fallback. */
      }
      const row = await db.get('writer').transaction(async (tx) => {
        const current = await lock(tx, state);
        if (current.status === 'registered') throw review();
        for (const limit of await budgets(tx, current)) {
          const sends = limit.sendWindowAt + 3600_000 > now() ? limit.sends : 0,
            failures = limit.failureWindowAt + 600_000 > now() ? limit.failures : 0;
          if (
            limit.lastSentAt + (limit.key.startsWith('phone:') ? 60_000 : 10_000) > now() ||
            sends >= (limit.key.startsWith('phone:') ? 5 : 60) ||
            failures >= 5
          )
            throw new AppError(
              429,
              'CUSTOMER_REGISTRATION_RATE_LIMITED',
              'Customer verification is temporarily limited. Wait before requesting another code.',
            );
          await tx
            .update(limits)
            .set({
              lastSentAt: now(),
              sends: sends + 1,
              sendWindowAt: sends ? limit.sendWindowAt : now(),
            })
            .where(eq(limits.key, limit.key));
        }
        const value = input(current),
          code = registrationCode(),
          status = ['dispatching', 'uncertain'].includes(current.status) ? 'uncertain' : 'pending',
          expiresAt = now() + environment.ttlSeconds! * 1000;
        await tx
          .update(registrations)
          .set({
            encryptedInput: sealRegistration(secret(), current.id, {
              details: value.details,
              code,
            }),
            codeHash: registrationCodeDigest(secret(), current.id, state.id, code),
            status,
            verifiedAt: null,
            attempts: 0,
            expiresAt,
            updatedAt: now(),
          })
          .where(scope(state, current.id));
        await tx
          .update(deliveries)
          .set({ status: 'cancelled', updatedAt: now() })
          .where(and(eq(deliveries.registrationId, current.id), eq(deliveries.status, 'pending')));
        const trace = currentRequestTrace();
        await tx.insert(deliveries).values(
          (whatsapp ? (['sms', 'whatsapp'] as const) : (['sms'] as const)).map((channel) => ({
            id: `${operationId}:${channel}`,
            registrationId: current.id,
            channel,
            status: 'pending',
            availableAt: now() + (channel === 'whatsapp' ? environment.fallbackSeconds * 1000 : 0),
            requestId: trace?.requestId ?? null,
            operatorId: state.operatorId,
            createdAt: now(),
            updatedAt: now(),
          })),
        );
        return { ...current, status, verifiedAt: null, attempts: 0, expiresAt };
      });
      return publicRow(row);
    },
    async register(state) {
      secret();
      gateway.assertApiReady?.();
      const row = await db.get('writer').transaction(async (tx) => {
        const current = await lock(tx, state);
        if (current.status === 'registered') return current;
        if (current.status !== 'verified' || current.expiresAt <= now() || !current.verifiedAt)
          throw review();
        await tx
          .update(registrations)
          .set({ status: 'dispatching', updatedAt: now() })
          .where(scope(state, current.id));
        return { ...current, status: 'dispatching' };
      });
      if (row.status === 'registered') return publicRow(row);
      try {
        const payload = registrationPayload(input(row).details, state.storeId),
          response = z
            .object({
              user_id: z.union([identifier, z.number().int().positive().safe()]),
              status: z.literal(1),
            })
            .passthrough()
            .parse(await gateway.api('store-register', payload));
        return publicRow(await acceptCustomer(state, String(response.user_id)));
      } catch {
        await db
          .get('writer')
          .update(registrations)
          .set({ status: 'uncertain', updatedAt: now() })
          .where(and(scope(state, row.id), eq(registrations.status, 'dispatching')));
        throw new AppError(
          503,
          'CUSTOMER_REGISTRATION_OUTCOME_UNCERTAIN',
          'Registration may have completed. Reconcile the saved registration; do not submit it again.',
        );
      }
    },
    async reconcile(state) {
      return publicRow(await acceptCustomer(state));
    },
  };
}
