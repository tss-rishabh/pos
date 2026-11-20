import { timingSafeEqual } from 'node:crypto';
import { or, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { MUser } from '../../../db/legacy-schema.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import { currentRequestTrace } from '../../../observability/context.js';
import type { CheckoutState } from '../contracts.js';
import { CheckoutGatewayError, type CheckoutGateway } from '../gateway.js';
import { checkoutSessionStore, type CheckoutSessionStore } from '../session-store.js';
import { memoryStateStore, readJson, withStateLock, type PosStateStore } from '../state-store.js';
import {
  registrationDetailsSchema,
  registrationPayload,
  validateRegistrationDetails,
  type CustomerRegistrations,
  type PublicRegistration,
  type RegistrationDetails,
  type RegistrationStatus,
} from './contracts.js';
import {
  openRegistration,
  registrationCode,
  registrationCodeDigest,
  registrationCodeMatches,
  registrationDigest,
  sealRegistration,
} from './crypto.js';
import type { RegisteredEvent } from '../../../observability/event-registry.js';

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
    // Legacy `users/login_otp.py:33`: `int(LOGIN_OTP_EXPIRY or 180)`.
    ttlSeconds: value.LOGIN_OTP_EXPIRY ?? 180,
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
      'Customer registration is not configured.',
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

/** Verified registration proof window (the rewrite's checkout verification window). */
const PROOF_MS = 15 * 60_000;
/** Dispatched/registered records stay readable for the life of the sale (session TTL). */
const REVIEW_TTL_SECONDS = 2 * 24 * 3600;
const MAX_ATTEMPTS = 5;
const deliveryStatus = z.enum(['sent', 'failed', 'scheduled', 'skipped']);
const recordSchema = z
  .object({
    id: z.uuid(),
    checkoutId: z.uuid(),
    operatorId: identifier,
    storeId: identifier,
    counterId: identifier,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    phoneHash: z.string().regex(/^[a-f0-9]{64}$/),
    emailHash: z.string().regex(/^[a-f0-9]{64}$/),
    encryptedInput: z.string().min(1).max(8000),
    codeHash: z.string().max(64),
    status: z.enum([
      'pending',
      'verified',
      'dispatching',
      'registered',
      'uncertain',
      'expired',
      'locked',
    ]),
    attempts: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    verifiedAt: z.number().int().nonnegative().nullable(),
    customerId: identifier.nullable(),
    createdAt: z.number().int().nonnegative(),
    sentAt: z.number().int().nonnegative(),
    deliveries: z.object({ sms: deliveryStatus, whatsapp: deliveryStatus.optional() }).strict(),
    /** S36 "Self Verify (Without OTP)": verified without the code; never a benefit proof. */
    selfVerified: z.boolean().optional(),
  })
  .strict();
type RegistrationRecord = z.infer<typeof recordSchema>;

/**
 * Redis keys (table-disposition.md "checkout/customer-registration"); every key has a TTL:
 * - `pos:customer_registration:{registrationId}`: RegistrationRecord JSON. Phone/email only as
 *   HMAC digests plus an AES-GCM envelope; the code only as an HMAC. TTL LOGIN_OTP_EXPIRY while
 *   pending, the 15-minute proof window once verified, 2 days once dispatched or registered.
 * - `pos:customer_registration_claim:{phone|email}:{digest}`: registrationId, same TTL as the
 *   record; one in-flight registration per contact.
 * - `pos:customer_registration_lock:{registrationId}`: lock token, 30 s.
 * - `pos:customer_registration_limit:cooldown:phone:{digest}`: 60 s resend cooldown.
 * - `pos:customer_registration_limit:sends:{phone:{digest}|operator:{id}}:{hour}`: sends per
 *   clock hour (5 per phone, 60 per operator), 1 h.
 */
export const registrationKeys = {
  record: (id: string) => `pos:customer_registration:${id}`,
  claim: (contactKey: string) => `pos:customer_registration_claim:${contactKey}`,
  lock: (id: string) => `pos:customer_registration_lock:${id}`,
  cooldown: (phoneHash: string) => `pos:customer_registration_limit:cooldown:phone:${phoneHash}`,
  sends: (subject: string, hour: number) =>
    `pos:customer_registration_limit:sends:${subject}:${hour}`,
};
/** For customer-contacts: the status and customer of a registration, or null once gone. */
export async function readRegistrationOutcome(store: PosStateStore, registrationId: string) {
  const record = await readJson(store, registrationKeys.record(registrationId), recordSchema);
  return record
    ? { status: record.status, customerId: record.customerId, expiresAt: record.expiresAt }
    : null;
}
/** For customer-contacts: the registration currently claiming `{phone|email}:{digest}`. */
export async function readRegistrationClaim(store: PosStateStore, contactKey: string) {
  const owner = await store.get(registrationKeys.claim(contactKey));
  return owner ? readRegistrationOutcome(store, owner) : null;
}

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
const busy = () =>
  new AppError(409, 'CUSTOMER_REGISTRATION_BUSY', 'This registration is still being processed.');
const limited = () =>
  new AppError(
    429,
    'CUSTOMER_REGISTRATION_RATE_LIMITED',
    'Customer verification is temporarily limited. Wait before requesting another code.',
  );

/** Structured audit sink (Fastify `app.log`); events carry identifiers only, never contacts. */
export interface RegistrationAuditLog {
  info(value: RegisteredEvent, message: string): void;
}
const stdoutAudit: RegistrationAuditLog = {
  info(value, message) {
    process.stdout.write(
      JSON.stringify({ level: 30, time: Date.now(), ...value, msg: message }) + '\n',
    );
  },
};
const selfVerifyRefused = (code: string, status: number, message: string) =>
  new AppError(status, code, message);

export interface CustomerRegistrationDependencies {
  /** Audit sink for self-verified registrations; defaults to a JSON line on stdout. */
  log?: RegistrationAuditLog;
  stateStore?: PosStateStore;
  sessions?: CheckoutSessionStore;
  now?: () => number;
  /** Runs the delayed WhatsApp fallback; defaults to an unref'd in-process timer. */
  schedule?: (delayMs: number, run: () => Promise<void>) => void;
}
const timer = (delayMs: number, run: () => Promise<void>) => {
  setTimeout(() => void run().catch(() => undefined), delayMs).unref();
};

/**
 * Legacy `AjaxUserRegisterView` (`order/views.py:2416-2534`) and its dialog
 * (`create_order.html:4797-5030`): duplicate check, 6-digit OTP by SMS with a delayed WhatsApp
 * fallback, OTP verification, then API-v2 `store-register`. API-v2 writes the `users` row.
 */
export function customerRegistrationService(
  db: Databases,
  gateway: CheckoutGateway,
  environment: RegistrationEnvironment,
  sender: RegistrationOtpSender,
  timeZone: string,
  dependencies: CustomerRegistrationDependencies = {},
): CustomerRegistrations {
  const store = dependencies.stateStore ?? dependencies.sessions?.store ?? memoryStateStore(),
    sessions = dependencies.sessions ?? checkoutSessionStore(store),
    now = dependencies.now ?? Date.now,
    schedule = dependencies.schedule ?? timer,
    audit = dependencies.log ?? stdoutAudit;
  /** S36 audit: request, operator, store, sale, registration and customer identifiers only. */
  function auditSelfVerified(record: RegistrationRecord, outcome: 'accepted' | 'registered') {
    const trace = currentRequestTrace();
    audit.info(
      {
        module: 'checkout',
        resource: 'customer-registration',
        eventId: `checkout.customer-registration.self-verify-${outcome}` as const,
        requestId: trace?.requestId ?? null,
        userId: trace?.userId ?? record.operatorId,
        operatorId: record.operatorId,
        storeId: record.storeId,
        counterId: record.counterId,
        checkoutId: record.checkoutId,
        registrationId: record.id,
        customerId: record.customerId,
      },
      outcome === 'accepted'
        ? 'Customer registration self-verified without OTP'
        : 'Self-verified customer registration created',
    );
  }
  function secret() {
    assertRegistrationReady(environment);
    return environment.secret;
  }
  const contactKeys = (record: Pick<RegistrationRecord, 'phoneHash' | 'emailHash'>) =>
    [`email:${record.emailHash}`, `phone:${record.phoneHash}`].sort();
  const read = (id: string) => readJson(store, registrationKeys.record(id), recordSchema);
  function ttlSeconds(record: RegistrationRecord) {
    const until =
      record.status === 'pending' || record.status === 'expired' || record.status === 'locked'
        ? record.expiresAt
        : record.status === 'verified'
          ? (record.verifiedAt ?? 0) + PROOF_MS
          : now() + REVIEW_TTL_SECONDS * 1000;
    return Math.max(60, Math.ceil((until - now()) / 1000));
  }
  async function save(record: RegistrationRecord) {
    const parsed = recordSchema.parse(record),
      ttl = ttlSeconds(parsed);
    await store.set(registrationKeys.record(parsed.id), JSON.stringify(parsed), ttl);
    if (!['registered', 'expired'].includes(parsed.status))
      for (const key of contactKeys(parsed))
        await store.compareAndSet(registrationKeys.claim(key), parsed.id, parsed.id, ttl);
  }
  async function releaseClaims(record: RegistrationRecord) {
    for (const key of contactKeys(record))
      await store.deleteIfEquals(registrationKeys.claim(key), record.id);
  }
  const locked = <T>(id: string, run: () => Promise<T>) =>
    withStateLock(store, registrationKeys.lock(id), run, { ttlSeconds: 30, busy });
  function registrationIdOf(state: CheckoutState) {
    if (!state.registrationId) throw notFound();
    return state.registrationId;
  }
  async function current(state: CheckoutState) {
    if (!state.registrationId) throw notFound();
    const record = await read(state.registrationId);
    if (
      !record ||
      record.checkoutId !== state.id ||
      record.operatorId !== state.operatorId ||
      record.storeId !== state.storeId ||
      record.counterId !== state.counterId
    )
      throw notFound();
    return record;
  }
  const input = (record: RegistrationRecord) =>
    registrationEnvelopeSchema.parse(openRegistration(secret(), record.id, record.encryptedInput));
  function publicRecord(record: RegistrationRecord): PublicRegistration {
    const status: RegistrationStatus = ['registered', 'dispatching', 'uncertain'].includes(
      record.status,
    )
      ? record.status
      : record.attempts >= MAX_ATTEMPTS || record.status === 'locked'
        ? 'locked'
        : record.status === 'pending' && record.expiresAt <= now()
          ? 'expired'
          : record.status;
    return {
      id: record.id,
      status,
      expiresAt: record.expiresAt,
      retryAt: record.sentAt + 60_000,
      attemptsRemaining: Math.max(0, MAX_ATTEMPTS - record.attempts),
      customerId: record.customerId,
      verifiedAt: record.verifiedAt,
      selfVerified: record.selfVerified === true,
      deliveries: [
        { channel: 'sms' as const, status: record.deliveries.sms },
        ...(record.deliveries.whatsapp
          ? [{ channel: 'whatsapp' as const, status: record.deliveries.whatsapp }]
          : []),
      ],
    };
  }
  /**
   * Legacy duplicate check (`order/views.py:2434-2440`): `MUser` by telephone OR email (blank email
   * becomes `{mobile}@temp.id`); a telephone match wins the message.
   */
  async function assertNotRegistered(details: RegistrationDetails) {
    const email = details.email || `${details.telephone}@temp.id`;
    const [match] = await db
      .get('writer')
      .select({ telephone: MUser.telephone })
      .from(MUser)
      .where(or(eq(MUser.telephone, details.telephone), eq(MUser.email, email)))
      .limit(1);
    if (match)
      throw match.telephone === details.telephone
        ? new AppError(409, 'CUSTOMER_PHONE_REGISTERED', 'Mobile No is already registered with us')
        : new AppError(409, 'CUSTOMER_EMAIL_REGISTERED', 'Email is already registered with us');
  }
  async function consumeSendBudget(operatorId: string, phoneHash: string) {
    if (!(await store.set(registrationKeys.cooldown(phoneHash), '1', 60, true))) throw limited();
    const hour = Math.floor(now() / 3600_000);
    if ((await store.increment(registrationKeys.sends(`phone:${phoneHash}`, hour), 3600)) > 5)
      throw limited();
    if ((await store.increment(registrationKeys.sends(`operator:${operatorId}`, hour), 3600)) > 60)
      throw limited();
  }
  function whatsappReady() {
    try {
      sender.assertReady('whatsapp');
      return true;
    } catch {
      return false; // The fallback is optional; SMS readiness is mandatory.
    }
  }
  /**
   * Legacy `send_otp` (`order/views.py:2458-2500`): SMS synchronously (a provider failure is
   * swallowed, as legacy logs and continues), then WhatsApp after WHATSAPP_OTP_FALLBACK_DELAY_TIME
   * only while the same code is still unverified (`helpers/helpers.py:1556-1585`).
   */
  async function deliver(record: RegistrationRecord, telephone: string, code: string) {
    let sms: 'sent' | 'failed' = 'sent';
    try {
      await sender.send(telephone, code, 'sms');
    } catch {
      sms = 'failed';
    }
    const fallback = whatsappReady();
    const next: RegistrationRecord = {
      ...record,
      deliveries: { sms, ...(fallback ? { whatsapp: 'scheduled' as const } : {}) },
    };
    await locked(record.id, async () => {
      const latest = await read(record.id);
      if (latest?.codeHash === record.codeHash)
        await save({ ...latest, deliveries: next.deliveries });
    });
    if (fallback)
      schedule(environment.fallbackSeconds * 1000, async () => {
        const due = await read(record.id);
        if (
          !due ||
          due.status !== 'pending' ||
          due.codeHash !== record.codeHash ||
          due.expiresAt <= now()
        )
          return;
        let whatsapp: 'sent' | 'failed' = 'sent';
        try {
          await sender.send(telephone, code, 'whatsapp');
        } catch {
          whatsapp = 'failed';
        }
        await locked(record.id, async () => {
          const latest = await read(record.id);
          if (latest?.codeHash === record.codeHash)
            await save({ ...latest, deliveries: { ...latest.deliveries, whatsapp } });
        });
      });
    return next;
  }
  /** Confirms the registered account on the writer by its exact phone and email pair. */
  async function confirmCustomer(record: RegistrationRecord, expectedId?: string) {
    const details = input(record).details,
      email = (details.email || `${details.telephone}@temp.id`).toLowerCase();
    const matches = await db
      .get('writer')
      .select({
        id: MUser.id,
        email: MUser.email,
        telephone: MUser.telephone,
        active: MUser.status,
        blocked: MUser.is_block,
      })
      .from(MUser)
      .where(or(eq(MUser.telephone, details.telephone), eq(MUser.email, email)))
      .limit(3);
    const customer = matches[0];
    if (
      matches.length !== 1 ||
      !customer ||
      customer.telephone !== details.telephone ||
      customer.email.toLowerCase() !== email ||
      (expectedId && String(customer.id) !== expectedId) ||
      customer.active !== 1 ||
      customer.blocked === 1
    )
      return null;
    return String(customer.id);
  }
  async function markRegistered(record: RegistrationRecord, customerId: string) {
    const registered: RegistrationRecord = {
      ...record,
      status: 'registered',
      customerId,
      codeHash: '',
      encryptedInput: sealRegistration(secret(), record.id, { details: input(record).details }),
    };
    await save(registered);
    await releaseClaims(registered);
    if (registered.selfVerified) auditSelfVerified(registered, 'registered');
    return registered;
  }
  return {
    async request(state, id, raw) {
      assertRegistrationReady(environment);
      sender.assertReady('sms');
      z.uuid().parse(id);
      const details = validateRegistrationDetails(raw, timeZone, now()),
        phoneHash = registrationDigest(secret(), 'phone', details.telephone),
        emailHash = registrationDigest(
          secret(),
          'email',
          (details.email || `${details.telephone}@temp.id`).toLowerCase(),
        ),
        requestHash = registrationDigest(secret(), 'request', JSON.stringify(details));
      const prior = await read(id);
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
        return publicRecord(prior);
      }
      if (state.registrationId && state.registrationId !== id) {
        const previous = await read(state.registrationId);
        if (previous && ['dispatching', 'uncertain', 'registered'].includes(previous.status))
          throw review();
      }
      await assertNotRegistered(details);
      const code = registrationCode(),
        created: RegistrationRecord = {
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
          expiresAt: now() + environment.ttlSeconds * 1000,
          verifiedAt: null,
          customerId: null,
          createdAt: now(),
          sentAt: now(),
          deliveries: { sms: 'skipped' },
        };
      // One in-flight registration per contact. The same sale may supersede its own pending one.
      const ttl = ttlSeconds(created),
        taken: string[] = [];
      try {
        for (const key of contactKeys(created)) {
          const claim = registrationKeys.claim(key);
          if (await store.set(claim, id, ttl, true)) {
            taken.push(claim);
            continue;
          }
          const ownerId = await store.get(claim),
            owner = ownerId ? await read(ownerId) : null;
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
          if (!(await store.compareAndSet(claim, ownerId, id, ttl))) throw busy();
          taken.push(claim);
          if (owner && owner.checkoutId === state.id && owner.status === 'pending')
            await save({ ...owner, status: 'expired', codeHash: '', expiresAt: now() });
        }
        await consumeSendBudget(state.operatorId, phoneHash);
      } catch (error) {
        for (const claim of taken) await store.deleteIfEquals(claim, id);
        throw error;
      }
      await save(created);
      // Persist the reference with the sale before the code leaves, so request recovery can
      // find it (the checkout operation `id` still owns the sale).
      try {
        await sessions.exclusive(state.operatorId, state.storeId, state.id, async (session) => {
          if (session.busyOperationId !== id || session.counterId !== state.counterId)
            throw new AppError(
              409,
              'CHECKOUT_OPERATION_CHANGED',
              'This registration request is no longer active.',
            );
          return { state: { ...session, registrationId: id, updatedAt: now() }, value: undefined };
        });
      } catch (error) {
        await store.del(registrationKeys.record(id));
        await releaseClaims(created);
        throw error;
      }
      return publicRecord(await deliver(created, details.telephone, code));
    },
    async read(state) {
      if (!state.registrationId) return null;
      try {
        return publicRecord(await current(state));
      } catch (error) {
        if (error instanceof AppError && error.status === 404) return null;
        throw error;
      }
    },
    async verifiedCustomerUntil(state, customer) {
      if (!state.registrationId) return null;
      const record = await read(state.registrationId);
      if (
        !record ||
        record.checkoutId !== state.id ||
        record.status !== 'registered' ||
        // S36/S33: a self-verified registration connects the customer but proves nothing.
        record.selfVerified === true ||
        record.customerId !== customer.id ||
        !record.verifiedAt ||
        record.verifiedAt + PROOF_MS <= now() ||
        !customer.active
      )
        return null;
      const value = input(record).details;
      return customer.telephone === value.telephone &&
        customer.email.toLowerCase() === (value.email || `${value.telephone}@temp.id`).toLowerCase()
        ? record.verifiedAt + PROOF_MS
        : null;
    },
    async cancel(state) {
      if (!state.registrationId) return true;
      const id = state.registrationId;
      return locked(id, async () => {
        let record: RegistrationRecord;
        try {
          record = await current(state);
        } catch (error) {
          if (error instanceof AppError && error.status === 404) return true;
          throw error;
        }
        if (['dispatching', 'uncertain'].includes(record.status)) return false;
        if (record.status === 'registered') return true;
        await store.del(registrationKeys.record(id));
        await releaseClaims(record);
        return true;
      });
    },
    /** Legacy `verify_otp` (`order/views.py:2502-2510`). */
    async verify(state, code) {
      secret();
      if (!/^\d{6}$/.test(code.replaceAll('_', '')))
        throw new AppError(400, 'CUSTOMER_REGISTRATION_CODE_FORMAT', 'Please enter the OTP');
      const record = await locked(registrationIdOf(state), async () => {
        const row = await current(state);
        if (['verified', 'registered'].includes(row.status)) return row;
        if (row.status !== 'pending' || row.expiresAt <= now())
          throw new AppError(
            403,
            'CUSTOMER_REGISTRATION_CODE_EXPIRED',
            'The OTP has expired. Request a new OTP.',
          );
        if (row.attempts >= MAX_ATTEMPTS)
          throw new AppError(
            429,
            'CUSTOMER_REGISTRATION_ATTEMPT_LIMIT',
            'Too many wrong codes. Request a new OTP.',
          );
        if (
          !registrationCodeMatches(
            secret(),
            row.id,
            state.id,
            code.replaceAll('_', ''),
            row.codeHash,
          )
        ) {
          await save({ ...row, attempts: row.attempts + 1 });
          throw new AppError(400, 'CUSTOMER_REGISTRATION_CODE_INVALID', 'OTP is incorrect');
        }
        const verified: RegistrationRecord = {
          ...row,
          status: 'verified',
          verifiedAt: now(),
          codeHash: '',
          encryptedInput: sealRegistration(secret(), row.id, { details: input(row).details }),
        };
        await save(verified);
        return verified;
      });
      return publicRecord(record);
    },
    /**
     * Legacy "Self Verify (Without OTP)" (`create_order.html:4856,4996`; `order/views.py:2429-2448`
     * `if self_verify or self.verify_otp(...)`). Legacy trusts a client `self_verify=1` for any
     * phone; S36 accepts it only for the phone this sale's pending registration OTP was actually
     * delivered to (SMS or WhatsApp `sent`), within the LOGIN_OTP_EXPIRY window of that send.
     * The result is `verified` so `register` can follow, flagged `selfVerified` so it is never a
     * verified-customer proof (S33).
     */
    async selfVerify(state, telephone) {
      secret();
      const refusedPhone = () =>
        selfVerifyRefused(
          'CUSTOMER_SELF_VERIFY_PHONE_MISMATCH',
          409,
          'Self verification is allowed only for the mobile number the OTP was sent to.',
        );
      const expired = () =>
        selfVerifyRefused(
          'CUSTOMER_SELF_VERIFY_EXPIRED',
          409,
          'The OTP window has ended. Request a new OTP before self verification.',
        );
      if (!/^[6-9]\d{9}$/.test(telephone)) throw refusedPhone();
      if (!state.registrationId)
        throw selfVerifyRefused(
          'CUSTOMER_SELF_VERIFY_OTP_NOT_SENT',
          409,
          'Send the registration OTP to this mobile number before self verification.',
        );
      const outcome = await locked(state.registrationId, async () => {
        // The record lives only for its OTP window while pending; gone means the window ended.
        if (!(await read(registrationIdOf(state)))) throw expired();
        const row = await current(state),
          phone = Buffer.from(registrationDigest(secret(), 'phone', telephone), 'hex'),
          bound = Buffer.from(row.phoneHash, 'hex');
        if (phone.length !== bound.length || !timingSafeEqual(phone, bound)) throw refusedPhone();
        if (['verified', 'registered', 'dispatching', 'uncertain'].includes(row.status))
          return { record: row, accepted: false };
        if (row.deliveries.sms !== 'sent' && row.deliveries.whatsapp !== 'sent')
          throw selfVerifyRefused(
            'CUSTOMER_SELF_VERIFY_OTP_NOT_SENT',
            409,
            'Send the registration OTP to this mobile number before self verification.',
          );
        if (
          row.status !== 'pending' ||
          row.expiresAt <= now() ||
          row.sentAt + (environment.ttlSeconds ?? 0) * 1000 <= now()
        )
          throw expired();
        const verified: RegistrationRecord = {
          ...row,
          status: 'verified',
          verifiedAt: now(),
          selfVerified: true,
          codeHash: '',
          encryptedInput: sealRegistration(secret(), row.id, { details: input(row).details }),
        };
        await save(verified);
        return { record: verified, accepted: true };
      });
      if (outcome.accepted) auditSelfVerified(outcome.record, 'accepted');
      return publicRecord(outcome.record);
    },
    async resend(state) {
      assertRegistrationReady(environment);
      sender.assertReady('sms');
      const id = registrationIdOf(state);
      const { record, code, telephone } = await locked(id, async () => {
        const row = await current(state);
        if (['registered', 'dispatching', 'uncertain'].includes(row.status)) throw review();
        await consumeSendBudget(state.operatorId, row.phoneHash);
        const details = input(row).details,
          next = registrationCode(),
          updated: RegistrationRecord = {
            ...row,
            encryptedInput: sealRegistration(secret(), row.id, { details, code: next }),
            codeHash: registrationCodeDigest(secret(), row.id, state.id, next),
            status: 'pending',
            verifiedAt: null,
            selfVerified: false,
            attempts: 0,
            expiresAt: now() + environment.ttlSeconds * 1000,
            sentAt: now(),
            deliveries: { sms: 'skipped' },
          };
        await save(updated);
        return { record: updated, code: next, telephone: details.telephone };
      });
      return publicRecord(await deliver(record, telephone, code));
    },
    /** Legacy `user_register` (`order/views.py:2512-2534`) after a VERIFY. */
    async register(state) {
      secret();
      gateway.assertApiReady?.();
      const id = registrationIdOf(state);
      const record = await locked(id, async () => {
        const row = await current(state);
        if (row.status === 'registered') return row;
        if (row.status !== 'verified' || !row.verifiedAt || row.verifiedAt + PROOF_MS <= now())
          throw review();
        // Legacy repeats the duplicate check on VERIFY (`order/views.py:2434-2440`).
        await assertNotRegistered(input(row).details);
        const dispatching: RegistrationRecord = { ...row, status: 'dispatching' };
        await save(dispatching);
        return dispatching;
      });
      if (record.status === 'registered') return publicRecord(record);
      let userId: string;
      try {
        const response = z
          .object({ user_id: z.union([identifier, z.number().int().positive().safe()]) })
          .passthrough()
          .parse(
            await gateway.api(
              'store-register',
              registrationPayload(input(record).details, state.storeId),
            ),
          );
        userId = String(response.user_id);
      } catch (error) {
        const rejected = error instanceof CheckoutGatewayError && !error.uncertain;
        await locked(id, async () => {
          const latest = await read(id);
          if (latest?.status === 'dispatching')
            await save({ ...latest, status: rejected ? 'verified' : 'uncertain' });
        });
        if (rejected) throw new AppError(400, 'CUSTOMER_REGISTRATION_REJECTED', error.message);
        throw new AppError(
          503,
          'CUSTOMER_REGISTRATION_OUTCOME_UNCERTAIN',
          'Registration may have completed. Reconcile the saved registration; do not submit it again.',
        );
      }
      return publicRecord(
        await locked(id, async () => {
          const latest = await current(state);
          if (latest.status === 'registered') return latest;
          const customerId = await confirmCustomer(latest, userId);
          if (!customerId) {
            await save({ ...latest, status: 'uncertain' });
            throw new AppError(
              503,
              'CUSTOMER_REGISTRATION_UNCONFIRMED',
              'A matching registered customer has not been proved on the writer. Keep this registration reference.',
            );
          }
          return markRegistered(latest, customerId);
        }),
      );
    },
    async reconcile(state) {
      const id = registrationIdOf(state);
      return publicRecord(
        await locked(id, async () => {
          const row = await current(state);
          if (row.status === 'registered') return row;
          if (!['dispatching', 'uncertain'].includes(row.status) || !row.verifiedAt) throw review();
          const customerId = await confirmCustomer(row);
          if (!customerId)
            throw new AppError(
              503,
              'CUSTOMER_REGISTRATION_UNCONFIRMED',
              'A matching registered customer has not been proved on the writer. Keep this registration reference.',
            );
          return markRegistered(row, customerId);
        }),
      );
    },
  };
}
