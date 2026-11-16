import { Temporal } from '@js-temporal/polyfill';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { currentRequestTrace } from '../../observability/context.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type { CheckoutState } from '../checkout/contracts.js';
import { customerCheckoutScope } from '../customer-insights/checkout-scope.js';
import {
  assertContactRegistrationAvailable,
  assertContactWriterIsolation,
  assertEditableContactCheckout,
  assertMissingContact,
  contactActorVersion,
  contactChanged,
  contactFingerprint,
  contactNotFound,
  contactUnavailable,
  currentProofDestination,
  lockContactCustomer,
  type ContactCustomer,
} from './authority.js';
import {
  contactChangeContract,
  contactScope,
  requestContactChange,
  verifyContactChange,
  resendContactChange,
  commitContactChange,
  cancelContactChange,
  contactEnvelope,
  contactWorkspace,
  contactMutationResponse,
  type CustomerContactDelivery,
} from './contracts.js';
import {
  contactDigest,
  customerContactReservationKey,
  matchesContactCode,
  openContactEnvelope,
  sealContact,
} from './crypto.js';
import { contactAttemptLimit, recordContactFailure } from './limits.js';
import type { CustomerContactOptions } from './options.js';
import { contactUsers } from './legacy-schema.js';
import {
  assertEmailNotRegistered,
  assertNoEmployeeContactChange,
  hasRealCustomerEmail,
} from './references.js';
import {
  assertNoActiveContactChangeReservation,
  lockCustomerContactKeys,
  reserveCustomerContactKeys,
  releaseCustomerContactKeys,
} from './reservations.js';
import {
  contactChallengeView,
  contactStageDestination,
  type ContactChallenge,
} from './projection.js';
import {
  contactMutationReplay,
  contactReceiptError,
  findContactChallenge,
  queueContactCode,
  saveContactMutation,
} from './commands.js';
import { commitCustomerContact } from './commit.js';
import {
  customerContactChallenges as challenges,
  customerContactDeliveries as deliveries,
  customerContactMutations,
  type ContactMutationReceipt,
} from './schema.js';

type Scope = z.infer<typeof contactScope>;
type ScopedState = CheckoutState & { customerId: string };
export function customerContactService(
  config: Config,
  db: Databases,
  options: CustomerContactOptions,
  delivery: CustomerContactDelivery | undefined,
  clock: () => number = Date.now,
) {
  const withCheckout = customerCheckoutScope(config, db),
    secret = () => options.CUSTOMER_CONTACTS_SECRET ?? config.SESSION_SECRET;
  function ready() {
    if (
      config.DEMO_MODE ||
      !options.CUSTOMER_CONTACTS_ENABLED ||
      options.CUSTOMER_CONTACTS_CONTRACT !== contactChangeContract ||
      !options.CUSTOMER_CONTACTS_SECRET ||
      !options.CUSTOMER_REGISTRATION_SECRET ||
      !delivery
    )
      throw contactUnavailable();
    delivery.assertEffectsReady();
    return delivery;
  }
  function now() {
    return z.number().int().nonnegative().refine(Number.isSafeInteger).parse(clock());
  }
  function scopeInput(user: Principal, raw: Scope) {
    identifier.parse(user.id);
    return contactScope.parse(raw);
  }
  async function value(tx: AdministrationTransaction, row: ContactChallenge) {
    return contactChallengeView(tx, row, secret(), options, now());
  }
  async function cancelPending(
    tx: AdministrationTransaction,
    row: ContactChallenge,
    status: 'CANCELLED' | 'EXPIRED' | 'LOCKED',
    time: number,
  ) {
    await tx
      .update(challenges)
      .set({
        status,
        activeCustomerId: null,
        codeHash: '',
        attempts: status === 'LOCKED' ? row.attempts + 1 : row.attempts,
        version: row.version + 1,
        updatedAt: time,
      })
      .where(eq(challenges.id, row.id));
    await tx
      .update(deliveries)
      .set({ status: 'CANCELLED', encryptedPayload: '', updatedAt: time })
      .where(
        and(
          eq(deliveries.challengeId, row.id),
          eq(deliveries.kind, 'otp'),
          eq(deliveries.status, 'PENDING'),
        ),
      );
    await releaseCustomerContactKeys(tx, [row.targetKey], row.id);
  }
  async function mutate<T extends { operationId: string; version: number }>(
    user: Principal,
    scope: Scope,
    id: string,
    action: string,
    raw: unknown,
    schema: z.ZodType<T>,
    apply: (
      tx: AdministrationTransaction,
      state: ScopedState,
      row: ContactChallenge,
      customer: ContactCustomer,
      input: T,
      time: number,
    ) => Promise<ContactMutationReceipt>,
  ) {
    ready();
    scope = scopeInput(user, scope);
    z.uuid().parse(id);
    const input = schema.parse(raw),
      hash = contactDigest(
        secret(),
        'command',
        JSON.stringify([user.id, scope, id, action, input]),
      );
    const result = await withCheckout(user, scope, 'update', async (tx, state) => {
      const actorVersion = await contactActorVersion(tx, user.id),
        initial = await findContactChallenge(tx, state, id);
      const replay = await contactMutationReplay(tx, state, input.operationId, id, action, hash);
      if (replay)
        return contactMutationResponse.parse({
          challenge: await value(tx, initial),
          receipt: replay,
        });
      if (action !== 'cancel' && action !== 'recover')
        await assertEditableContactCheckout(tx, state);
      await lockCustomerContactKeys(tx, [initial.targetKey]);
      if (action === 'commit')
        await assertContactRegistrationAvailable(tx, initial.targetKey, now());
      const customer = await lockContactCustomer(tx, state.customerId),
        row = await findContactChallenge(tx, state, id, true);
      if (
        input.version !== row.version ||
        (action !== 'cancel' && action !== 'recover' && actorVersion !== row.actorVersion)
      )
        throw contactChanged();
      const time = now();
      let receipt: ContactMutationReceipt;
      if (
        action !== 'cancel' &&
        ['PENDING_CURRENT', 'PENDING_NEW', 'READY'].includes(row.status) &&
        row.expiresAt <= time
      ) {
        await cancelPending(tx, row, 'EXPIRED', time);
        receipt = {
          id: input.operationId,
          challengeId: id,
          status: 'error',
          errorCode: 'CUSTOMER_CONTACT_EXPIRED',
          errorStatus: 409,
          message: 'This contact proof expired. Start a new request.',
        };
      } else {
        if (
          action !== 'cancel' &&
          action !== 'recover' &&
          row.contactFingerprint !== contactFingerprint(secret(), customer)
        )
          throw contactChanged();
        receipt = await apply(tx, state, row, customer, input, time);
      }
      await saveContactMutation(tx, state, action, hash, receipt, time);
      return contactMutationResponse.parse({
        challenge: await value(tx, await findContactChallenge(tx, state, id)),
        receipt,
      });
    });
    contactReceiptError(result.receipt);
    return result;
  }
  return {
    async read(user: Principal, raw: Scope) {
      const scope = scopeInput(user, raw);
      return withCheckout(user, scope, 'share', async (tx, state) => {
        const customer = await lockContactCustomer(tx, state.customerId),
          [active] = await tx
            .select()
            .from(challenges)
            .where(eq(challenges.activeCustomerId, state.customerId))
            .limit(1);
        let enabled = true;
        try {
          ready();
          await assertEditableContactCheckout(tx, state);
        } catch {
          enabled = false;
        }
        const addableKinds: ('telephone' | 'email')[] = [];
        if (enabled) {
          try {
            const current = currentProofDestination(customer);
            delivery!.assertReady(current.channel);
            for (const kind of ['telephone', 'email'] as const) {
              if (
                kind === 'telephone'
                  ? Boolean(customer.telephone)
                  : hasRealCustomerEmail(customer.email)
              )
                continue;
              try {
                delivery!.assertReady(kind === 'email' ? 'email' : 'sms');
                addableKinds.push(kind);
              } catch {
                /* Channel is deliberately unavailable. */
              }
            }
          } catch {
            /* No existing real contact can authorize this bounded add flow. */
          }
        }
        const visible =
          active &&
          !(
            ['PENDING_CURRENT', 'PENDING_NEW', 'READY'].includes(active.status) &&
            active.expiresAt <= now()
          )
            ? active
            : null;
        const owned =
          visible &&
          visible.operatorId === state.operatorId &&
          visible.checkoutId === state.id &&
          visible.counterId === state.counterId;
        return contactWorkspace.parse({
          customerId: state.customerId,
          checkoutVersion: state.version,
          contactFingerprint: enabled ? contactFingerprint(secret(), customer) : null,
          enabled,
          addableKinds,
          activeChallenge: owned && visible ? await value(tx, visible) : null,
          pendingElsewhere: Boolean(visible && !owned),
        });
      });
    },
    async request(user: Principal, rawScope: Scope, raw: unknown) {
      const sender = ready(),
        scope = scopeInput(user, rawScope),
        input = requestContactChange.parse(raw),
        target = input.kind === 'email' ? input.value.toLowerCase() : input.value,
        hash = contactDigest(
          secret(),
          'request',
          JSON.stringify([user.id, scope, { ...input, value: target }]),
        );
      return withCheckout(user, scope, 'update', async (tx, state) => {
        const actorVersion = await contactActorVersion(tx, user.id),
          [existing] = await tx
            .select()
            .from(challenges)
            .where(eq(challenges.id, input.operationId))
            .limit(1);
        if (existing) {
          const row = await findContactChallenge(tx, state, input.operationId);
          if (row.requestHash !== hash)
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This contact request identifier was used for different details.',
            );
          return value(tx, row);
        }
        await assertEditableContactCheckout(tx, state, input.checkoutVersion);
        await assertContactWriterIsolation(tx);
        const time = now(),
          key = customerContactReservationKey(
            options.CUSTOMER_REGISTRATION_SECRET!,
            input.kind,
            target,
          );
        await lockCustomerContactKeys(tx, [key]);
        await assertNoActiveContactChangeReservation(tx, [key], time);
        await assertContactRegistrationAvailable(tx, key, time);
        const customer = await lockContactCustomer(tx, state.customerId);
        if (input.contactFingerprint !== contactFingerprint(secret(), customer))
          throw contactChanged();
        assertMissingContact(customer, input.kind);
        const [active] = await tx
          .select()
          .from(challenges)
          .where(eq(challenges.activeCustomerId, state.customerId))
          .limit(1)
          .for('update');
        if (active) {
          if (
            ['PENDING_CURRENT', 'PENDING_NEW', 'READY'].includes(active.status) &&
            active.expiresAt <= time
          )
            await tx
              .update(challenges)
              .set({ status: 'EXPIRED', activeCustomerId: null, codeHash: '', updatedAt: time })
              .where(eq(challenges.id, active.id));
          else
            throw new AppError(
              409,
              'CUSTOMER_CONTACT_PENDING',
              'Finish or cancel the current customer contact request first.',
            );
        }
        if (input.kind === 'email') {
          await assertEmailNotRegistered(tx, target);
          await assertNoEmployeeContactChange(
            tx,
            state.customerId,
            Temporal.Instant.fromEpochMilliseconds(time),
          );
        } else {
          const [taken] = await tx
            .select({ id: contactUsers.id })
            .from(contactUsers)
            .where(eq(contactUsers.telephone, target))
            .limit(1)
            .for('share');
          if (taken)
            throw new AppError(
              409,
              'CUSTOMER_CONTACT_ALREADY_REGISTERED',
              'This mobile number is already registered.',
            );
        }
        const current = currentProofDestination(customer);
        sender.assertReady(current.channel);
        sender.assertReady(input.kind === 'email' ? 'email' : 'sms');
        const row: ContactChallenge = {
          id: input.operationId,
          checkoutId: state.id,
          operatorId: user.id,
          storeId: state.storeId,
          counterId: state.counterId,
          customerId: state.customerId,
          activeCustomerId: state.customerId,
          actorVersion,
          contactFingerprint: input.contactFingerprint,
          requestHash: hash,
          kind: input.kind,
          targetKey: key,
          encryptedInput: sealContact(
            secret(),
            input.operationId,
            contactEnvelope.parse({
              purpose: contactChangeContract,
              id: input.operationId,
              kind: input.kind,
              value: target,
              current,
              oldEmail: customer.email,
              oldTelephone: customer.telephone,
            }),
          ),
          status: 'PENDING_CURRENT',
          version: 1,
          stage: 'current',
          codeHash: '',
          codeExpiresAt: time,
          attempts: 0,
          currentVerifiedAt: null,
          newVerifiedAt: null,
          expiresAt: time + 1200000,
          retryAt: time,
          requestId: currentRequestTrace()?.requestId ?? null,
          createdAt: time,
          updatedAt: time,
        };
        await tx.insert(challenges).values(row);
        await reserveCustomerContactKeys(tx, [key], row.id, row.expiresAt);
        const code = await queueContactCode(
          tx,
          row,
          'current',
          options,
          config.BUSINESS_TIMEZONE,
          time,
        );
        await tx.update(challenges).set(code).where(eq(challenges.id, row.id));
        return value(tx, { ...row, ...code });
      });
    },
    async challenge(user: Principal, raw: Scope, id: string) {
      const scope = scopeInput(user, raw);
      z.uuid().parse(id);
      return withCheckout(user, scope, 'share', async (tx, state) => {
        await lockContactCustomer(tx, state.customerId);
        return value(tx, await findContactChallenge(tx, state, id));
      });
    },
    async verify(user: Principal, scope: Scope, id: string, raw: unknown) {
      return mutate(
        user,
        scope,
        id,
        'verify',
        raw,
        verifyContactChange,
        async (tx, _state, row, _customer, input, time) => {
          if (!['PENDING_CURRENT', 'PENDING_NEW'].includes(row.status) || input.stage !== row.stage)
            throw contactChanged();
          const envelope = openContactEnvelope(secret(), row.id, row.encryptedInput),
            destination = contactStageDestination(row, envelope),
            [sent] = await tx
              .select({ status: deliveries.status })
              .from(deliveries)
              .where(
                and(
                  eq(deliveries.challengeId, row.id),
                  eq(deliveries.kind, 'otp'),
                  eq(deliveries.stage, row.stage),
                ),
              )
              .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
              .limit(1);
          if (!sent || !['SENDING', 'DELIVERED', 'UNCERTAIN'].includes(sent.status))
            throw new AppError(
              409,
              'CUSTOMER_CONTACT_CODE_NOT_SENT',
              'Wait for delivery to be attempted before verifying this code.',
            );
          if (row.codeExpiresAt <= time)
            return {
              id: input.operationId,
              challengeId: id,
              status: 'error',
              errorCode: 'CUSTOMER_CONTACT_CODE_EXPIRED',
              errorStatus: 409,
              message: 'This code expired. Request a new code.',
            };
          const attempts = row.attempts + 1,
            maximum = contactAttemptLimit(destination.channel, options);
          if (!matchesContactCode(row.codeHash, secret(), row.id, row.stage, input.code)) {
            await recordContactFailure(tx, row.customerId, row.targetKey, row.stage);
            if (attempts >= maximum) await cancelPending(tx, row, 'LOCKED', time);
            else
              await tx
                .update(challenges)
                .set({ attempts, version: row.version + 1, updatedAt: time })
                .where(eq(challenges.id, row.id));
            return {
              id: input.operationId,
              challengeId: id,
              status: 'error',
              errorCode:
                attempts >= maximum
                  ? 'CUSTOMER_CONTACT_ATTEMPTS_EXCEEDED'
                  : 'CUSTOMER_CONTACT_CODE_INVALID',
              errorStatus: 400,
              message:
                attempts >= maximum
                  ? 'Too many incorrect codes. Start a new request.'
                  : 'The verification code is incorrect.',
            };
          }
          if (row.stage === 'current') {
            delivery!.assertReady(row.kind === 'email' ? 'email' : 'sms');
            const code = await queueContactCode(
              tx,
              row,
              'new',
              options,
              config.BUSINESS_TIMEZONE,
              time,
            );
            await tx
              .update(challenges)
              .set({ ...code, currentVerifiedAt: time, version: row.version + 1 })
              .where(eq(challenges.id, row.id));
          } else
            await tx
              .update(challenges)
              .set({
                status: 'READY',
                newVerifiedAt: time,
                codeHash: '',
                attempts,
                version: row.version + 1,
                updatedAt: time,
              })
              .where(eq(challenges.id, row.id));
          await tx
            .update(deliveries)
            .set({ encryptedPayload: '', updatedAt: time })
            .where(
              and(
                eq(deliveries.challengeId, row.id),
                eq(deliveries.kind, 'otp'),
                eq(deliveries.stage, row.stage),
              ),
            );
          return {
            id: input.operationId,
            challengeId: id,
            status: 'success',
            message:
              row.stage === 'current'
                ? 'Existing contact verified. Enter the code sent to the new contact.'
                : 'New contact verified. Review and confirm the addition.',
          };
        },
      );
    },
    async resend(user: Principal, scope: Scope, id: string, raw: unknown) {
      return mutate(
        user,
        scope,
        id,
        'resend',
        raw,
        resendContactChange,
        async (tx, _state, row, _customer, input, time) => {
          if (!['PENDING_CURRENT', 'PENDING_NEW'].includes(row.status) || row.retryAt > time)
            throw new AppError(
              429,
              'CUSTOMER_CONTACT_RESEND_WAIT',
              'Wait before requesting another contact code.',
            );
          const envelope = openContactEnvelope(secret(), row.id, row.encryptedInput);
          delivery!.assertReady(contactStageDestination(row, envelope).channel);
          const code = await queueContactCode(
            tx,
            row,
            row.stage,
            options,
            config.BUSINESS_TIMEZONE,
            time,
          );
          await tx
            .update(challenges)
            .set({ ...code, version: row.version + 1 })
            .where(eq(challenges.id, row.id));
          return {
            id: input.operationId,
            challengeId: id,
            status: 'success',
            message: 'A new verification code is queued. The previous code no longer works.',
          };
        },
      );
    },
    async cancel(user: Principal, scope: Scope, id: string, raw: unknown) {
      return mutate(
        user,
        scope,
        id,
        'cancel',
        raw,
        cancelContactChange,
        async (tx, _state, row, _customer, input, time) => {
          if (['COMMITTING', 'COMMITTED', 'UNCERTAIN'].includes(row.status))
            throw new AppError(
              409,
              'CUSTOMER_CONTACT_ALREADY_COMMITTED',
              'The contact is already saved. Its synchronization must be recovered without undoing the customer record.',
            );
          await cancelPending(tx, row, 'CANCELLED', time);
          return {
            id: input.operationId,
            challengeId: id,
            status: 'success',
            message: 'The contact request was cancelled. No customer contact was changed.',
          };
        },
      );
    },
    async commit(user: Principal, scope: Scope, id: string, raw: unknown) {
      return mutate(
        user,
        scope,
        id,
        'commit',
        raw,
        commitContactChange,
        async (tx, state, row, customer, input, time) => {
          await assertEditableContactCheckout(tx, state, input.checkoutVersion);
          await assertContactWriterIsolation(tx);
          ready().assertEffectsReady();
          return commitCustomerContact(
            tx,
            state,
            row,
            customer,
            input.operationId,
            options,
            config.BUSINESS_TIMEZONE,
            time,
          );
        },
      );
    },
    async recover(user: Principal, scope: Scope, id: string, raw: unknown) {
      return mutate(
        user,
        scope,
        id,
        'recover',
        raw,
        resendContactChange,
        async (tx, _state, row, _customer, input, time) => {
          ready().assertEffectsReady();
          if (
            !options.CUSTOMER_CONTACT_EFFECTS_REPLAY_SAFE ||
            !['COMMITTING', 'UNCERTAIN'].includes(row.status) ||
            row.retryAt > time
          )
            throw contactChanged();
          const [job] = await tx
            .select()
            .from(deliveries)
            .where(and(eq(deliveries.challengeId, row.id), eq(deliveries.kind, 'source-effects')))
            .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
            .limit(1)
            .for('update');
          if (!job || !['UNCERTAIN', 'REJECTED'].includes(job.status) || !job.encryptedPayload)
            throw new AppError(
              409,
              'CUSTOMER_CONTACT_SYNC_PENDING',
              'The saved synchronization is already queued or requires operational review.',
            );
          await tx
            .update(deliveries)
            .set({
              status: 'PENDING',
              attempts: 0,
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: time,
            })
            .where(eq(deliveries.id, job.id));
          await tx
            .update(challenges)
            .set({
              status: 'COMMITTING',
              version: row.version + 1,
              retryAt: time + 30000,
              updatedAt: time,
            })
            .where(eq(challenges.id, row.id));
          return {
            id: input.operationId,
            challengeId: row.id,
            status: 'success',
            message:
              'The same saved synchronization has been requeued. The customer contact was not written again.',
          };
        },
      );
    },
    async operation(user: Principal, raw: Scope, id: string, operationId: string) {
      const scope = scopeInput(user, raw);
      z.uuid().parse(id);
      z.uuid().parse(operationId);
      return withCheckout(user, scope, 'share', async (tx, state) => {
        await lockContactCustomer(tx, state.customerId);
        const row = await findContactChallenge(tx, state, id);
        const [operation] = await tx
          .select()
          .from(customerContactMutations)
          .where(
            and(
              eq(customerContactMutations.id, operationId),
              eq(customerContactMutations.challengeId, id),
              eq(customerContactMutations.operatorId, user.id),
              eq(customerContactMutations.checkoutId, state.id),
            ),
          )
          .limit(1);
        if (!operation) throw contactNotFound();
        return contactMutationResponse.parse({
          challenge: await value(tx, row),
          receipt: operation.result,
        });
      });
    },
  };
}
