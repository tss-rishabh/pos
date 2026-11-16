import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { currentRequestTrace } from '../../observability/context.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import {
  customerContactBindingSchema,
  sameCustomerContact,
  type CustomerContactBinding,
} from '../checkout/customer-contact-authority.js';
import {
  assertCustomerOtpActor,
  assertCustomerOtpEnabled,
  assertCurrentOtpBinding,
  customerOtpAuthority,
  customerOtpChanged,
  customerOtpDestinations,
  customerOtpUnavailable,
} from './authority.js';
import {
  consumeCustomerOtpSend,
  customerOtpAttemptLimit,
  lockedCustomerOtpBudgets,
} from './budgets.js';
import {
  customerOtpScopeSchema,
  customerOtpOperationViewSchema,
  type CustomerOtpScope,
  type CustomerOtpDelivery,
} from './contracts.js';
import {
  customerOtpCode,
  customerOtpDigest,
  sameCustomerOtpCode,
  sealCustomerOtp,
} from './crypto.js';
import type { CustomerOtpOptions } from './options.js';
import { projectCustomerOtp, type CustomerOtpChallenge } from './projection.js';
import {
  customerOtpBudgets as budgets,
  customerOtpChallenges as challenges,
  customerOtpDeliveries as deliveries,
  customerOtpOperations as operations,
  type CustomerOtpOutcome,
} from './schema.js';

const missing = () =>
  new AppError(404, 'CUSTOMER_OTP_NOT_FOUND', 'Customer verification was not found.');
const conflict = () =>
  new AppError(
    409,
    'IDEMPOTENCY_CONFLICT',
    'This request key was used for different verification details.',
  );
const invalid = () =>
  new AppError(422, 'CUSTOMER_OTP_INVALID', 'The customer verification code is incorrect.');
export function customerOtpService(
  config: Config,
  db: Databases,
  options: CustomerOtpOptions,
  delivery: CustomerOtpDelivery | undefined,
  clock: () => number = Date.now,
) {
  const lockAuthority = customerOtpAuthority(config, db);
  function ready() {
    assertCustomerOtpEnabled(config, options);
    if (!delivery) throw customerOtpUnavailable();
    return { secret: options.CUSTOMER_OTP_SECRET!, delivery };
  }
  function parseScope(user: Principal, raw: CustomerOtpScope) {
    const scope = customerOtpScopeSchema.parse(raw);
    assertCustomerOtpActor(user, scope);
    return scope;
  }
  async function own(
    tx: AdministrationTransaction,
    scope: CustomerOtpScope,
    id: string,
    current: Awaited<ReturnType<typeof lockAuthority>>,
    secret: string,
  ) {
    const [row] = await tx
      .select()
      .from(challenges)
      .where(eq(challenges.id, id))
      .limit(1)
      .for('update');
    if (!row || row.scopeHash !== customerOtpDigest(secret, 'scope', scope)) throw missing();
    assertCurrentOtpBinding(row, current);
    if (
      current.frozenConsentUntil !== null &&
      (row.state !== 'VERIFIED' || row.verifiedUntil !== current.frozenConsentUntil)
    )
      throw customerOtpChanged();
    return row;
  }
  async function operation(
    tx: AdministrationTransaction,
    id: string,
    challengeId: string,
    kind: 'request' | 'verify',
    hash: string,
  ) {
    const [row] = await tx
      .select()
      .from(operations)
      .where(eq(operations.id, id))
      .limit(1)
      .for('update');
    if (row && (row.challengeId !== challengeId || row.kind !== kind || row.requestHash !== hash))
      throw conflict();
    return row;
  }
  async function terminal(tx: AdministrationTransaction, row: CustomerOtpChallenge, now: number) {
    if (row.state !== 'ACTIVE' || row.expiresAt > now) return row;
    const next = {
      ...row,
      state: 'EXPIRED' as const,
      codeHash: '',
      activeScopeHash: null,
      updatedAt: now,
    };
    await tx.update(challenges).set(next).where(eq(challenges.id, row.id));
    return next;
  }
  function unwrap(outcome: CustomerOtpOutcome) {
    if (outcome.error === 'CUSTOMER_OTP_INVALID') throw invalid();
    if (outcome.error === 'CUSTOMER_OTP_ATTEMPT_LIMIT') throw customerOtpAttemptLimit();
    return outcome.result;
  }
  return {
    async request(
      user: Principal,
      rawScope: CustomerOtpScope,
      challengeId: string,
      operationId: string,
      expectedContact: CustomerContactBinding,
    ) {
      const { secret, delivery: sender } = ready(),
        scope = parseScope(user, rawScope);
      z.uuid().parse(challengeId);
      z.uuid().parse(operationId);
      const expected = customerContactBindingSchema.parse(expectedContact);
      return db.get('writer').transaction(async (tx) => {
        const now = clock(),
          current = await lockAuthority(tx, scope, challengeId, operationId);
        if (!sameCustomerContact(expected, current.contact)) throw customerOtpChanged();
        const hash = customerOtpDigest(secret, 'request', [scope, challengeId, expected]);
        const [existing] = await tx
          .select()
          .from(challenges)
          .where(eq(challenges.id, challengeId))
          .limit(1)
          .for('update');
        const previous = await operation(tx, operationId, challengeId, 'request', hash);
        if (existing) {
          if (!previous) throw conflict();
          if (
            existing.requestHash !== hash ||
            existing.scopeHash !== customerOtpDigest(secret, 'scope', scope)
          )
            throw conflict();
          assertCurrentOtpBinding(existing, current);
          const result = await projectCustomerOtp(tx, await terminal(tx, existing, now), now);
          return result;
        }
        if (previous) throw missing();
        const destinations = customerOtpDestinations(current, options);
        for (const destination of destinations)
          sender.assertReady(scope.purpose, destination.channel);
        const budgetKeys = [
          ...new Set([
            'customer:' + scope.customerId,
            ...destinations.map(
              (destination) =>
                (destination.channel === 'whatsapp' ? 'sms' : destination.channel) +
                ':' +
                customerOtpDigest(secret, 'destination', [
                  destination.channel === 'whatsapp' ? 'sms' : destination.channel,
                  destination.destination.toLowerCase(),
                ]),
            ),
          ]),
        ].sort();
        await consumeCustomerOtpSend(tx, budgetKeys, now, config.BUSINESS_TIMEZONE, options);
        const scopeHash = customerOtpDigest(secret, 'scope', scope);
        const [old] = await tx
          .select()
          .from(challenges)
          .where(eq(challenges.activeScopeHash, scopeHash))
          .limit(1)
          .for('update');
        if (old) {
          await tx
            .update(challenges)
            .set({
              state: 'SUPERSEDED',
              activeScopeHash: null,
              codeHash: '',
              verifiedUntil: null,
              updatedAt: now,
            })
            .where(eq(challenges.id, old.id));
          await tx
            .update(deliveries)
            .set({ state: 'CANCELLED', encryptedPayload: '', updatedAt: now })
            .where(and(eq(deliveries.challengeId, old.id), eq(deliveries.state, 'PENDING')));
        }
        const code = customerOtpCode(),
          row = {
            id: challengeId,
            operatorId: scope.operatorId,
            storeId: scope.storeId,
            customerId: scope.customerId,
            scope,
            contact: current.contact,
            scopeHash,
            activeScopeHash: scopeHash,
            requestHash: hash,
            actorVersion: current.actorVersion,
            state: 'ACTIVE' as const,
            codeHash: customerOtpDigest(secret, 'code', [challengeId, code]),
            budgetKeys,
            attempts: 0,
            expiresAt: now + 300000,
            proofExpiresAt: now + 900000,
            verifiedUntil: null,
            requestId: currentRequestTrace()?.requestId ?? null,
            createdAt: now,
            updatedAt: now,
          };
        await tx.insert(challenges).values(row);
        for (const destination of destinations) {
          const id = randomUUID();
          await tx.insert(deliveries).values({
            id,
            challengeId,
            channel: destination.channel,
            availableAt:
              now +
              (destination.channel === 'whatsapp' ? options.CUSTOMER_OTP_WHATSAPP_DELAY_MS : 0),
            state: 'PENDING',
            encryptedPayload: sealCustomerOtp(secret, id, {
              contract: 'pos-customer-otp-delivery-v1',
              purpose: scope.purpose,
              ...destination,
              code,
            }),
            createdAt: now,
            updatedAt: now,
          });
        }
        const result = await projectCustomerOtp(tx, row, now);
        await tx.insert(operations).values({
          id: operationId,
          challengeId,
          kind: 'request',
          requestHash: hash,
          outcome: { result, error: null },
          createdAt: now,
        });
        return result;
      });
    },
    async read(user: Principal, rawScope: CustomerOtpScope, challengeId: string) {
      const { secret } = ready(),
        scope = parseScope(user, rawScope);
      z.uuid().parse(challengeId);
      return db.get('writer').transaction(async (tx) => {
        const current = await lockAuthority(tx, scope, challengeId, undefined, true),
          now = clock();
        const row = await own(tx, scope, challengeId, current, secret);
        return projectCustomerOtp(tx, await terminal(tx, row, now), now);
      });
    },
    async readOperation(
      user: Principal,
      rawScope: CustomerOtpScope,
      challengeId: string,
      operationId: string,
    ) {
      const { secret } = ready(),
        scope = parseScope(user, rawScope);
      z.uuid().parse(challengeId);
      z.uuid().parse(operationId);
      return db.get('writer').transaction(async (tx) => {
        const current = await lockAuthority(tx, scope, challengeId, undefined, true),
          now = clock();
        let row: CustomerOtpChallenge;
        try {
          row = await own(tx, scope, challengeId, current, secret);
        } catch (error) {
          if (error instanceof AppError && error.status === 404) return null;
          throw error;
        }
        const [receipt] = await tx
          .select()
          .from(operations)
          .where(and(eq(operations.id, operationId), eq(operations.challengeId, challengeId)))
          .limit(1)
          .for('share');
        if (!receipt) return null;
        return customerOtpOperationViewSchema.parse({
          kind: receipt.kind,
          result: await projectCustomerOtp(tx, await terminal(tx, row, now), now),
          error: receipt.outcome.error,
        });
      });
    },
    async assertVerified(
      tx: AdministrationTransaction,
      user: Principal,
      rawScope: CustomerOtpScope,
      challengeId: string,
      expectedContact: CustomerContactBinding,
      verifiedUntil: number,
    ): Promise<void> {
      const { secret } = ready(),
        scope = parseScope(user, rawScope);
      z.uuid().parse(challengeId);
      z.number().int().positive().parse(verifiedUntil);
      const expected = customerContactBindingSchema.parse(expectedContact);
      const current = await lockAuthority(tx, scope, challengeId, undefined, true),
        row = await own(tx, scope, challengeId, current, secret);
      if (
        row.state !== 'VERIFIED' ||
        row.verifiedUntil !== verifiedUntil ||
        row.proofExpiresAt !== verifiedUntil ||
        verifiedUntil <= clock() ||
        !sameCustomerContact(expected, current.contact)
      )
        throw new AppError(
          403,
          'CUSTOMER_VERIFICATION_REQUIRED',
          'Verify this customer before using this proof.',
        );
    },
    async verify(
      user: Principal,
      rawScope: CustomerOtpScope,
      challengeId: string,
      operationId: string,
      code: string,
    ) {
      const { secret } = ready(),
        scope = parseScope(user, rawScope);
      z.uuid().parse(challengeId);
      z.uuid().parse(operationId);
      z.string()
        .regex(/^\d{6}$/)
        .parse(code);
      const outcome = await db
        .get('writer')
        .transaction(async (tx): Promise<CustomerOtpOutcome> => {
          const current = await lockAuthority(tx, scope, challengeId, operationId),
            now = clock();
          const row = await own(tx, scope, challengeId, current, secret),
            hash = customerOtpDigest(secret, 'verify', [scope, challengeId, code]);
          const previous = await operation(tx, operationId, challengeId, 'verify', hash);
          if (previous)
            return { ...previous.outcome, result: await projectCustomerOtp(tx, row, now) };
          if (row.state === 'VERIFIED' && row.verifiedUntil && row.verifiedUntil > now) {
            const result = await projectCustomerOtp(tx, row, now),
              accepted = { result, error: null };
            await tx.insert(operations).values({
              id: operationId,
              challengeId,
              kind: 'verify',
              requestHash: hash,
              outcome: accepted,
              createdAt: now,
            });
            return accepted;
          }
          if (row.state !== 'ACTIVE' || row.expiresAt <= now)
            throw new AppError(
              403,
              'CUSTOMER_OTP_EXPIRED',
              'Request a new customer verification code.',
            );
          const jobs = await tx
            .select({ state: deliveries.state })
            .from(deliveries)
            .where(eq(deliveries.challengeId, challengeId))
            .limit(3);
          if (!jobs.some((job) => ['ACCEPTED', 'SENDING', 'UNCERTAIN'].includes(job.state)))
            throw new AppError(
              409,
              'CUSTOMER_OTP_NOT_DISPATCHED',
              'Wait for the queued verification code.',
            );
          const limits = await lockedCustomerOtpBudgets(
            tx,
            row.budgetKeys,
            now,
            config.BUSINESS_TIMEZONE,
          );
          const blocked =
            row.attempts >= options.CUSTOMER_OTP_FAILURES_PER_WINDOW ||
            limits.some(
              (limit) =>
                limit.windowFailures >= options.CUSTOMER_OTP_FAILURES_PER_WINDOW ||
                limit.failures >= options.CUSTOMER_OTP_FAILURES_PER_DAY,
            );
          const valid = !blocked && sameCustomerOtpCode(row.codeHash, secret, challengeId, code);
          let next: CustomerOtpChallenge;
          let error: CustomerOtpOutcome['error'] = null;
          if (valid) {
            next = {
              ...row,
              state: 'VERIFIED',
              codeHash: '',
              verifiedUntil: row.proofExpiresAt,
              updatedAt: now,
            };
          } else {
            for (const limit of limits)
              if (!blocked)
                await tx
                  .update(budgets)
                  .set({
                    failures: limit.failures + 1,
                    windowFailures: limit.windowFailures + 1,
                  })
                  .where(eq(budgets.key, limit.key));
            const exhausted =
              blocked || row.attempts + 1 >= options.CUSTOMER_OTP_FAILURES_PER_WINDOW;
            next = {
              ...row,
              attempts: row.attempts + (blocked ? 0 : 1),
              ...(exhausted
                ? { state: 'LOCKED' as const, codeHash: '', activeScopeHash: null }
                : {}),
              updatedAt: now,
            };
            error = exhausted ? 'CUSTOMER_OTP_ATTEMPT_LIMIT' : 'CUSTOMER_OTP_INVALID';
          }
          await tx.update(challenges).set(next).where(eq(challenges.id, challengeId));
          if (valid || next.state === 'LOCKED')
            await tx
              .update(deliveries)
              .set({ state: 'CANCELLED', encryptedPayload: '', updatedAt: now })
              .where(
                and(
                  eq(deliveries.challengeId, challengeId),
                  inArray(deliveries.state, ['PENDING']),
                ),
              );
          const result = await projectCustomerOtp(tx, next, now),
            receipt = { result, error };
          await tx.insert(operations).values({
            id: operationId,
            challengeId,
            kind: 'verify',
            requestHash: hash,
            outcome: receipt,
            createdAt: now,
          });
          return receipt;
        });
      return unwrap(outcome);
    },
  };
}
