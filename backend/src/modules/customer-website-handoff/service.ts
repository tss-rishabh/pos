import { randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { currentRequestTrace } from '../../observability/context.js';
import { applicationDigest, applicationToken, sameToken } from '../application-links/domain.js';
import {
  configuredWebsiteHandoff,
  handoffUnavailable,
  type CustomerWebsiteHandoffOptions,
} from './options.js';
import {
  websiteHandoffAuthority,
  changed,
  expired,
  type WebsiteSessionProbe,
  type WebsiteVerification,
} from './authority.js';
import {
  customerWebsiteHandoffContract,
  websiteHandoffIssue,
  websiteHandoffRedemption,
  websiteHandoffScope,
  websiteHandoffSession,
  websiteHandoffReceipt,
  type WebsiteHandoffIssue,
  type WebsiteHandoffRedemption,
  type WebsiteHandoffScope,
  type WebsiteHandoffSession,
} from './contracts.js';
import { customerWebsiteHandoffs as grants, type CustomerWebsiteGrant } from './schema.js';
function safeTime(value: bigint) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw expired();
  return number;
}
export function customerWebsiteHandoffService(
  config: Config,
  db: Databases,
  options: CustomerWebsiteHandoffOptions,
  verification: WebsiteVerification | undefined,
  clock: () => number = Date.now,
  sessionAlive?: WebsiteSessionProbe,
) {
  const authority = websiteHandoffAuthority(config, db, verification, clock, sessionAlive),
    digest = (purpose: string, value: string) =>
      applicationDigest(config.SESSION_SECRET, purpose, value);
  function ready() {
    const result = configuredWebsiteHandoff(config, options);
    if (!verification) throw handoffUnavailable();
    return {
      ...result,
      configurationHash: digest(
        'customer-website-configuration',
        JSON.stringify([
          customerWebsiteHandoffContract,
          result.url.href,
          result.key,
          options.CUSTOMER_WEBSITE_HANDOFF_TTL_SECONDS,
          options.CUSTOMER_WEBSITE_HANDOFF_SESSION_SECONDS,
        ]),
      ),
    };
  }
  function token(row: CustomerWebsiteGrant) {
    return applicationToken(config.SESSION_SECRET, 'customer-website-handoff', [
      row.id,
      row.operationId,
      row.checkoutId,
      String(row.checkoutVersion),
      row.operatorId,
      row.operatorCustomerId,
      row.customerId,
      row.storeId,
      row.counterId,
      row.operatorSessionId,
      row.authorityHash,
      row.configurationHash,
      String(row.expiresAt),
      String(row.sessionExpiresAt),
      String(row.verifiedUntil),
      row.challengeId,
      String(row.createdAt),
    ]);
  }
  function valid(
    row: CustomerWebsiteGrant,
    original: { authorityHash: string },
    configurationHash: string,
  ) {
    if (
      !['ISSUED', 'CONSUMED'].includes(row.state) ||
      row.expiresAt > row.sessionExpiresAt ||
      row.sessionExpiresAt > row.verifiedUntil ||
      row.sessionExpiresAt >
        row.createdAt + BigInt(options.CUSTOMER_WEBSITE_HANDOFF_SESSION_SECONDS * 1000) ||
      row.expiresAt <= BigInt(clock()) ||
      row.configurationHash !== configurationHash ||
      row.authorityHash !== original.authorityHash
    )
      throw expired();
  }
  function descriptor(row: CustomerWebsiteGrant) {
    const { url } = ready();
    if (row.state !== 'ISSUED' || row.expiresAt <= BigInt(clock())) throw expired();
    url.hash = token(row);
    return {
      contract: customerWebsiteHandoffContract,
      id: row.id,
      operationId: row.operationId,
      checkoutId: row.checkoutId,
      checkoutVersion: row.checkoutVersion,
      url: url.href,
      serverNow: clock(),
      expiresAt: safeTime(row.expiresAt),
    };
  }
  async function closed<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ER_DUP_ENTRY'
      )
        throw new AppError(
          409,
          'CUSTOMER_WEBSITE_OPERATION_CONFLICT',
          'This website action is already bound to another request.',
        );
      throw handoffUnavailable();
    }
  }
  return {
    async capabilities(
      user: Principal,
      rawScope: WebsiteHandoffScope,
      rawSession: WebsiteHandoffSession,
    ) {
      const scope = websiteHandoffScope.parse(rawScope),
        session = websiteHandoffSession.parse(rawSession);
      try {
        ready();
      } catch {
        return {
          contract: customerWebsiteHandoffContract,
          available: false,
          requiresVerification: true,
          checkoutVersion: null,
          receiverOrigin: null,
        };
      }
      return closed(() =>
        // Native OTP authority also locks the checkout. Acquire its strongest
        // lock first so concurrent capability reads never upgrade shared locks.
        authority.withCheckout(user, scope, 'update', async (tx, state) => {
          try {
            await authority.current(tx, user, state, session);
            return {
              contract: customerWebsiteHandoffContract,
              available: true,
              requiresVerification: false,
              checkoutVersion: state.version,
              receiverOrigin: ready().url.origin,
            };
          } catch (error) {
            if (
              error instanceof AppError &&
              [
                'CUSTOMER_VERIFICATION_REQUIRED',
                'CUSTOMER_OTP_UNAVAILABLE',
                'CUSTOMER_OTP_SCOPE_CHANGED',
                'CUSTOMER_CONTACT_CHANGED',
              ].includes(error.code)
            )
              return {
                contract: customerWebsiteHandoffContract,
                available: error.code !== 'CUSTOMER_OTP_UNAVAILABLE',
                requiresVerification: true,
                checkoutVersion: state.version,
                receiverOrigin: ready().url.origin,
              };
            throw error;
          }
        }),
      );
    },
    async issue(
      user: Principal,
      rawScope: WebsiteHandoffScope,
      rawInput: WebsiteHandoffIssue,
      rawSession: WebsiteHandoffSession,
    ) {
      const scope = websiteHandoffScope.parse(rawScope),
        input = websiteHandoffIssue.parse(rawInput),
        session = websiteHandoffSession.parse(rawSession),
        configuration = ready();
      const row = await closed(() =>
        authority.withCheckout(user, scope, 'update', async (tx, state) => {
          if (state.version !== input.expectedVersion) throw changed();
          const current = await authority.current(tx, user, state, session),
            [replay] = await tx
              .select()
              .from(grants)
              .where(eq(grants.operationId, input.operationId))
              .limit(1)
              .for('update');
          if (replay) {
            if (
              replay.operatorId !== user.id ||
              replay.checkoutId !== scope.checkoutId ||
              replay.storeId !== scope.storeId ||
              replay.checkoutVersion !== input.expectedVersion ||
              replay.operatorSessionId !== session.id
            )
              throw new AppError(
                409,
                'CUSTOMER_WEBSITE_OPERATION_CONFLICT',
                'This website action belongs to another sale or session.',
              );
            valid(replay, current, configuration.configurationHash);
            return replay;
          }
          const now = clock(),
            expiresAt = Math.min(
              now + options.CUSTOMER_WEBSITE_HANDOFF_TTL_SECONDS * 1000,
              current.verifiedUntil,
              current.sessionExpiresAt,
            ),
            sessionExpiresAt = Math.min(
              now + options.CUSTOMER_WEBSITE_HANDOFF_SESSION_SECONDS * 1000,
              current.verifiedUntil,
              current.sessionExpiresAt,
            );
          if (expiresAt <= now) throw expired();
          await tx
            .update(grants)
            .set({ state: 'REVOKED', updatedAt: BigInt(now) })
            .where(
              and(
                eq(grants.checkoutId, state.id),
                eq(grants.state, 'ISSUED'),
                gt(grants.expiresAt, BigInt(now)),
              ),
            );
          const grant: CustomerWebsiteGrant = {
            id: randomUUID(),
            operationId: input.operationId,
            checkoutId: state.id,
            checkoutVersion: state.version,
            operatorId: user.id,
            operatorCustomerId: state.operatorCustomerId,
            customerId: state.customerId,
            storeId: state.storeId,
            counterId: state.counterId,
            operatorSessionId: session.id,
            challengeId: state.verificationChallenge!.id,
            verifiedUntil: BigInt(current.verifiedUntil),
            authorityHash: current.authorityHash,
            configurationHash: configuration.configurationHash,
            tokenDigest: '',
            state: 'ISSUED',
            expiresAt: BigInt(expiresAt),
            sessionExpiresAt: BigInt(sessionExpiresAt),
            createdAt: BigInt(now),
            updatedAt: BigInt(now),
            consumedOperationId: null,
            browserBindingDigest: null,
            consumedAt: null,
            requestId: currentRequestTrace()?.requestId ?? null,
            consumedRequestId: null,
          };
          grant.tokenDigest = digest('customer-website-token', token(grant));
          await tx.insert(grants).values(grant);
          return grant;
        }),
      );
      return descriptor(row);
    },
    async revoke(user: Principal, rawScope: WebsiteHandoffScope, id: string) {
      const scope = websiteHandoffScope.parse(rawScope);
      return closed(() =>
        authority.withCheckout(user, scope, 'update', async (tx) => {
          const [row] = await tx
            .select()
            .from(grants)
            .where(
              and(
                eq(grants.id, id),
                eq(grants.checkoutId, scope.checkoutId),
                eq(grants.operatorId, user.id),
                eq(grants.storeId, scope.storeId),
              ),
            )
            .limit(1)
            .for('update');
          if (!row) throw expired();
          if (row.state === 'ISSUED') {
            await tx
              .update(grants)
              .set({ state: 'REVOKED', updatedAt: BigInt(clock()) })
              .where(eq(grants.id, row.id));
            return { id: row.id, state: 'REVOKED' as const };
          }
          return { id: row.id, state: row.state };
        }),
      );
    },
    async redeem(raw: WebsiteHandoffRedemption) {
      const input = websiteHandoffRedemption.parse(raw),
        configuration = ready();
      return closed(async () => {
        const [lookup] = await db
          .get('writer')
          .select({
            id: grants.id,
            operatorId: grants.operatorId,
            storeId: grants.storeId,
            checkoutId: grants.checkoutId,
          })
          .from(grants)
          .where(eq(grants.tokenDigest, digest('customer-website-token', input.token)))
          .limit(1);
        if (!lookup) throw expired();
        const scope = { storeId: lookup.storeId, checkoutId: lookup.checkoutId };
        return authority.withPrincipal(lookup.operatorId, scope, (user) =>
          authority.withCheckout(user, scope, 'update', async (tx, state) => {
            const [row] = await tx
              .select()
              .from(grants)
              .where(eq(grants.id, lookup.id))
              .limit(1)
              .for('update');
            if (
              !row ||
              row.operatorId !== user.id ||
              row.storeId !== scope.storeId ||
              row.checkoutId !== state.id ||
              row.customerId !== state.customerId ||
              row.operatorCustomerId !== state.operatorCustomerId ||
              row.counterId !== state.counterId ||
              row.checkoutVersion !== state.version ||
              row.challengeId !== state.verificationChallenge?.id ||
              row.verifiedUntil !== BigInt(state.verifiedCustomerUntil ?? 0) ||
              !sameToken(input.token, token(row))
            )
              throw expired();
            const current = await authority.current(tx, user, state, {
              id: row.operatorSessionId,
              expiresAt: safeTime(row.sessionExpiresAt),
            });
            valid(row, current, configuration.configurationHash);
            const binding = digest('customer-website-browser', input.browserBinding);
            if (row.state === 'CONSUMED') {
              if (
                row.consumedOperationId !== input.operationId ||
                row.browserBindingDigest !== binding
              )
                throw expired();
            } else {
              await tx
                .update(grants)
                .set({
                  state: 'CONSUMED',
                  consumedOperationId: input.operationId,
                  browserBindingDigest: binding,
                  consumedAt: BigInt(clock()),
                  updatedAt: BigInt(clock()),
                  consumedRequestId: currentRequestTrace()?.requestId ?? null,
                })
                .where(eq(grants.id, row.id));
            }
            return websiteHandoffReceipt.parse({
              contract: customerWebsiteHandoffContract,
              receiptId: row.id,
              operationId: input.operationId,
              checkoutId: row.checkoutId,
              checkoutVersion: row.checkoutVersion,
              customerId: row.customerId,
              operatorId: row.operatorId,
              operatorCustomerId: row.operatorCustomerId,
              storeId: row.storeId,
              counterId: row.counterId,
              sessionExpiresAt: safeTime(row.sessionExpiresAt),
            });
          }),
        );
      });
    },
  };
}
