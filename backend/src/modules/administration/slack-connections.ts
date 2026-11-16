import { createHash, createHmac } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, eq, inArray, lt, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser, Store, UserStore } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { currentAuthenticationVersion } from '../../auth/revocation.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { currentRequestTrace } from '../../observability/context.js';
import type { AdministrationTransaction } from './checkins.js';
import { lockAdministrationRegistry } from './locks.js';
import { storePublicUrl } from './policies.js';
import { slackConnections } from './slack-schema.js';
import { slackTeamId, type SlackConnectionOptions } from './slack-provider.js';
import { slackWebhook } from './slack-url.js';

export const startSlackConnectionInput = z
  .object({ operationId: z.uuid(), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const slackCallbackInput = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    error: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.code) !== Boolean(value.error),
    'Choose a valid Slack authorization result.',
  );
const grantSchema = z
  .object({
    webhook: slackWebhook,
    channel: z.string().min(1).max(255),
    channelId: z.string().regex(/^[CG][A-Z0-9]{8,32}$/),
    teamId: slackTeamId,
  })
  .strict();
type Attempt = typeof slackConnections.$inferSelect;
const failed = () =>
  new AppError(
    409,
    'SLACK_CONNECTION_CHANGED',
    'The store or operator changed. Start a new Slack connection.',
  );
const missing = () =>
  new AppError(404, 'SLACK_CONNECTION_NOT_FOUND', 'This Slack connection was not found.');
const revision = (config: Config, row: typeof Store.$inferSelect) =>
  createHmac('sha256', config.SESSION_SECRET + ':slack-store')
    .update(
      JSON.stringify(row, (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    )
    .digest('hex');
async function authorize(
  tx: AdministrationTransaction,
  user: Principal,
  storeId: string,
  publish = false,
) {
  const [actor] = await tx
    .select()
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(user.id)))
    .limit(1)
    .for('share');
  if (!actor?.is_active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  if (![1, 3].includes(actor.role) || ![1, 2].includes(actor.user_type))
    throw new AppError(
      403,
      'SLACK_CONNECTION_DENIED',
      'Store Slack connections require current administration access.',
    );
  const [store] = await tx
    .select()
    .from(Store)
    .where(and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true)))
    .limit(1)
    .for(publish ? 'update' : 'share');
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'An active store was not found.');
  if (actor.user_type === 2 && store.category !== 'FRANCHISE')
    throw new AppError(403, 'STORE_ACCESS_DENIED', 'This store is outside your organization.');
  if (actor.role !== 1 || actor.user_type !== 1) {
    const [assignment] = await tx
      .select({ id: UserStore.id })
      .from(UserStore)
      .where(and(eq(UserStore.django_user_id, actor.id), eq(UserStore.store_id, store.id)))
      .limit(1)
      .for('share');
    if (!assignment)
      throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
  }
  return { actor, store };
}
const summary = (row: Attempt, timestamp: number) => ({
  id: row.id,
  storeId: row.storeId,
  state:
    ['PENDING', 'EXCHANGING'].includes(row.state) && row.expiresAt.getTime() <= timestamp
      ? 'EXPIRED'
      : row.state,
  errorCode: row.errorCode,
  channel: row.state === 'COMPLETED' ? row.channel : null,
  expiresAt: row.expiresAt.getTime(),
});
export function slackConnectionService(
  config: Config,
  db: Databases,
  options: SlackConnectionOptions = {},
  now: () => number = Date.now,
) {
  const provider = options.slackOAuth;
  const stateFor = (id: string) =>
    createHmac('sha256', config.SESSION_SECRET + ':slack-oauth-state')
      .update(id)
      .digest('base64url');
  const stateHash = (state: string) => createHash('sha256').update(state).digest('hex');
  const requiresProvider = () => {
    if (!provider)
      throw new AppError(
        503,
        'SLACK_OAUTH_UNAVAILABLE',
        'Slack connection setup is currently unavailable.',
      );
    return provider;
  };
  async function owned(tx: AdministrationTransaction, user: Principal, id: string) {
    const [row] = await tx
      .select()
      .from(slackConnections)
      .where(and(eq(slackConnections.id, id), eq(slackConnections.actorId, user.id)))
      .limit(1);
    if (!row) throw missing();
    await authorize(tx, user, row.storeId);
    return row;
  }
  return {
    async view(user: Principal, storeId: string) {
      return db.get('writer').transaction(async (tx) => {
        const { store } = await authorize(tx, user, storeId);
        return {
          enabled: Boolean(provider),
          configured: Boolean(store.slack_group_url),
          version: revision(config, store),
        };
      });
    },
    async start(
      user: Principal,
      storeId: string,
      input: z.infer<typeof startSlackConnectionInput>,
      sessionBinding: string,
    ) {
      z.string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(sessionBinding);
      const ready = requiresProvider();
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lockAdministrationRegistry(tx, 'stores');
          const { actor, store } = await authorize(tx, user, storeId, true),
            version = await currentAuthenticationVersion(tx, actor);
          const [previous] = await tx
            .select()
            .from(slackConnections)
            .where(eq(slackConnections.id, input.operationId))
            .limit(1)
            .for('update');
          if (previous) {
            if (previous.actorId !== user.id || previous.storeId !== storeId) throw missing();
            if (
              previous.storeVersion !== input.expectedVersion ||
              previous.stateHash !== stateHash(stateFor(previous.id))
            )
              throw failed();
            if (
              previous.state !== 'PENDING' ||
              previous.expiresAt.getTime() <= now() ||
              previous.authenticationVersion !== version ||
              previous.sessionBinding !== sessionBinding ||
              previous.configurationVersion !== ready.configurationVersion ||
              revision(config, store) !== previous.storeVersion
            )
              throw failed();
            return {
              id: previous.id,
              authorizationUrl: ready.authorize(stateFor(previous.id)),
              expiresAt: previous.expiresAt.getTime(),
            };
          }
          if (revision(config, store) !== input.expectedVersion) throw failed();
          await tx
            .update(slackConnections)
            .set({ state: 'CANCELLED', errorCode: 'SLACK_CONNECTION_SUPERSEDED', leaseToken: null })
            .where(
              and(
                eq(slackConnections.actorId, user.id),
                eq(slackConnections.storeId, storeId),
                inArray(slackConnections.state, ['PENDING', 'EXCHANGING']),
              ),
            );
          const id = input.operationId,
            expiresAt = new Date(now() + 600000);
          await tx.insert(slackConnections).values({
            id,
            actorId: user.id,
            storeId,
            stateHash: stateHash(stateFor(id)),
            state: 'PENDING',
            authenticationVersion: version,
            sessionBinding,
            storeVersion: input.expectedVersion,
            configurationVersion: ready.configurationVersion,
            requestId: currentRequestTrace()?.requestId || null,
            createdAt: new Date(now()),
            expiresAt,
          });
          return {
            id,
            authorizationUrl: ready.authorize(stateFor(id)),
            expiresAt: expiresAt.getTime(),
          };
        }),
      );
    },
    async attempt(user: Principal, id: string) {
      return db.get('writer').transaction(async (tx) => summary(await owned(tx, user, id), now()));
    },
    async cancel(user: Principal, id: string) {
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lockAdministrationRegistry(tx, 'stores');
          const current = await owned(tx, user, id);
          if (['PENDING', 'EXCHANGING'].includes(current.state))
            await tx
              .update(slackConnections)
              .set({
                state: 'CANCELLED',
                errorCode: 'SLACK_CONNECTION_CANCELLED',
                leaseToken: null,
              })
              .where(eq(slackConnections.id, id));
          return summary(
            {
              ...current,
              ...(['PENDING', 'EXCHANGING'].includes(current.state)
                ? { state: 'CANCELLED', errorCode: 'SLACK_CONNECTION_CANCELLED' }
                : {}),
            },
            now(),
          );
        }),
      );
    },
    async complete(
      user: Principal,
      input: z.infer<typeof slackCallbackInput>,
      sessionBinding: string,
    ) {
      z.string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(sessionBinding);
      const ready = requiresProvider();
      const claimed = await retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lockAdministrationRegistry(tx, 'stores');
          const [row] = await tx
            .select()
            .from(slackConnections)
            .where(eq(slackConnections.stateHash, stateHash(input.state)))
            .limit(1);
          if (!row || row.actorId !== user.id || row.sessionBinding !== sessionBinding)
            throw missing();
          const { actor, store } = await authorize(tx, user, row.storeId, true);
          const [current] = await tx
            .select()
            .from(slackConnections)
            .where(eq(slackConnections.id, row.id))
            .limit(1)
            .for('update');
          if (!current) throw missing();
          if (!['PENDING', 'EXCHANGING'].includes(current.state))
            return { kind: 'receipt' as const, id: row.id };
          if (current.state === 'EXCHANGING') return { kind: 'receipt' as const, id: row.id };
          let errorCode: string | null = null,
            state = 'FAILED';
          if (current.expiresAt.getTime() <= now()) {
            errorCode = 'SLACK_CONNECTION_EXPIRED';
            state = 'EXPIRED';
          } else if (
            current.authenticationVersion !== (await currentAuthenticationVersion(tx, actor)) ||
            current.storeVersion !== revision(config, store) ||
            current.configurationVersion !== ready.configurationVersion
          )
            errorCode = 'SLACK_CONNECTION_CHANGED';
          else if (input.error) {
            errorCode = 'SLACK_CONNECTION_CANCELLED';
            state = 'CANCELLED';
          }
          if (errorCode) {
            await tx
              .update(slackConnections)
              .set({ state, errorCode, leaseToken: null })
              .where(eq(slackConnections.id, row.id));
            return { kind: 'receipt' as const, id: row.id };
          }
          const lease = crypto.randomUUID();
          await tx
            .update(slackConnections)
            .set({ state: 'EXCHANGING', leaseToken: lease })
            .where(eq(slackConnections.id, row.id));
          return { kind: 'exchange' as const, id: row.id, lease, storeId: row.storeId };
        }),
      );
      if (claimed.kind === 'receipt') return { id: claimed.id };
      let grant: z.infer<typeof grantSchema>;
      try {
        grant = grantSchema.parse(await ready.exchange(input.code!));
      } catch {
        await db
          .get('writer')
          .update(slackConnections)
          .set({ state: 'FAILED', errorCode: 'SLACK_OAUTH_EXCHANGE_FAILED', leaseToken: null })
          .where(
            and(
              eq(slackConnections.id, claimed.id),
              eq(slackConnections.state, 'EXCHANGING'),
              eq(slackConnections.leaseToken, claimed.lease),
            ),
          );
        return { id: claimed.id };
      }
      await retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lockAdministrationRegistry(tx, 'stores');
          const { actor, store } = await authorize(tx, user, claimed.storeId, true);
          const [row] = await tx
            .select()
            .from(slackConnections)
            .where(eq(slackConnections.id, claimed.id))
            .limit(1)
            .for('update');
          if (!row || row.state !== 'EXCHANGING' || row.leaseToken !== claimed.lease) return;
          if (
            row.expiresAt.getTime() <= now() ||
            row.authenticationVersion !== (await currentAuthenticationVersion(tx, actor)) ||
            row.storeVersion !== revision(config, store) ||
            row.configurationVersion !== ready.configurationVersion
          ) {
            await tx
              .update(slackConnections)
              .set({ state: 'FAILED', errorCode: 'SLACK_CONNECTION_CHANGED', leaseToken: null })
              .where(eq(slackConnections.id, row.id));
            return;
          }
          await tx
            .update(Store)
            .set({
              slack_group_url: grant.webhook,
              url_key: storePublicUrl(claimed.storeId),
              updated_at: Temporal.Instant.fromEpochMilliseconds(now())
                .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
                .toPlainDateTime()
                .toString({ smallestUnit: 'microsecond' })
                .replace('T', ' '),
            })
            .where(eq(Store.id, store.id));
          await tx
            .update(slackConnections)
            .set({
              state: 'COMPLETED',
              errorCode: null,
              leaseToken: null,
              channel: grant.channel,
              channelId: grant.channelId,
              teamId: grant.teamId,
              completedAt: new Date(now()),
            })
            .where(eq(slackConnections.id, row.id));
        }),
      ).catch(async () => {
        await db
          .get('writer')
          .update(slackConnections)
          .set({ state: 'FAILED', errorCode: 'SLACK_CONNECTION_CHANGED', leaseToken: null })
          .where(
            and(
              eq(slackConnections.id, claimed.id),
              eq(slackConnections.state, 'EXCHANGING'),
              eq(slackConnections.leaseToken, claimed.lease),
            ),
          );
      });
      return { id: claimed.id };
    },
  };
}
export async function pruneSlackConnections(db: Databases, now = Date.now()) {
  await db
    .get('writer')
    .update(slackConnections)
    .set({ state: 'EXPIRED', errorCode: 'SLACK_CONNECTION_EXPIRED', leaseToken: null })
    .where(
      and(
        inArray(slackConnections.state, ['PENDING', 'EXCHANGING']),
        lte(slackConnections.expiresAt, new Date(now)),
      ),
    )
    .limit(100);
  const [removed] = await db
    .get('writer')
    .delete(slackConnections)
    .where(lt(slackConnections.expiresAt, new Date(now - 86400000)))
    .limit(100);
  return removed.affectedRows;
}
