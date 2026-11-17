import { receiverBody, statusServiceDenied, type StatusReceiverProof } from './receiver-auth.js';
export { authenticateStatusReceiver, type StatusReceiverProof } from './receiver-auth.js';
import { statusReceiverHttp, vendorResponse } from './receiver-http.js';
import { readStatusNetcore } from './receiver-netcore.js';
import { statusNotifications } from './receiver-notifications.js';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lte, sql, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { retryTransaction } from '../../db/retry.js';
import { wholeOrderStatusCommands } from './schema.js';
import {
  statusAttempts,
  statusVendorCalls,
  statusReceivers,
  statusRates,
  statusNotificationAttempts,
  statusSourceLogWrites,
} from './receiver-schema.js';
import {
  readStatusReceiverOptions,
  receiverEndpoints,
  type StatusReceiverOptions,
} from './receiver-options.js';
import { wholeOrderStatusRepository } from './repository.js';
import { legacyWholeRequestCovers } from './authority.js';
import type { WholeOrderStatusOptions } from './options.js';
import {
  wholeOrderStatusContract,
  scopeSnapshot,
  immutableScopeHash,
  sourceStatusBody,
  statusDigest,
  requiredStages,
  receiptSchema,
  type StatusPlatform,
  type StatusReceipt,
  statusReconciliation,
} from './domain.js';
import type { StatusCommand } from './transport.js';
import {
  createSourceStoreRuntime,
  type SourceStorePorts,
} from '../../../compatibility/upstream/whole-order-status/pinned-source.js';

export interface StatusWorkerEvent {
  module: 'whole-order-status';
  resource: 'store-status-worker';
  eventId: 'whole-order-status.store-worker';
  eventInstanceId: string;
  requestId: string;
  userId: string;
  state: string;
}
import { requireHandoverBarrier, type AssertHandoverAvailable } from './handover.js';
export function wholeOrderStatusReceiver(
  config: Config,
  db: Databases,
  options: WholeOrderStatusOptions,
  receiver: StatusReceiverOptions = readStatusReceiverOptions(),
  dependencies: {
    assertHandoverAvailable?: AssertHandoverAvailable;
    fetcher?: typeof fetch;
    clock?: () => number;
    event?: (event: StatusWorkerEvent) => void;
  } = {},
) {
  const clock = dependencies.clock ?? Date.now,
    fetcher = dependencies.fetcher ?? fetch,
    repository = wholeOrderStatusRepository(
      config,
      db,
      clock,
      dependencies.assertHandoverAvailable,
    ),
    writer = () => db.get('writer');
  const delays = {
    PACK: receiver.SQS_STORE_ORDER_PACK_INITIAL_DELAY_SECONDS,
    SHIP: receiver.SQS_STORE_ORDER_SHIP_INITIAL_DELAY_SECONDS,
    DELIVER: receiver.SQS_STORE_ORDER_DELIVER_INITIAL_DELAY_SECONDS,
  };
  const retryDelays = {
    PACK: receiver.SQS_STORE_ORDER_PACK_RETRY_DELAY_SECONDS,
    SHIP: receiver.SQS_STORE_ORDER_SHIP_RETRY_DELAY_SECONDS,
    DELIVER: receiver.SQS_STORE_ORDER_DELIVER_RETRY_DELAY_SECONDS,
  };
  const limits = {
    PACK: {
      max: receiver.VINCULUM_PACK_RATE_LIMIT_MAX,
      window: receiver.VINCULUM_PACK_RATE_LIMIT_WINDOW_SECONDS,
    },
    SHIP: {
      max: receiver.VINCULUM_SHIP_RATE_LIMIT_MAX,
      window: receiver.VINCULUM_SHIP_RATE_LIMIT_WINDOW_SECONDS,
    },
    DELIVER: {
      max: receiver.VINCULUM_DELIVER_RATE_LIMIT_MAX,
      window: receiver.VINCULUM_DELIVER_RATE_LIMIT_WINDOW_SECONDS,
    },
  };
  const attemptId = (command: StatusCommand, stage: StatusPlatform) =>
    statusDigest(['store-status-stage', command.scopeHash, stage]);
  const event = (command: StatusCommand, state: string) =>
    dependencies.event?.({
      module: 'whole-order-status',
      resource: 'store-status-worker',
      eventId: 'whole-order-status.store-worker',
      eventInstanceId: command.id,
      requestId: command.requestId ?? command.id,
      userId: command.operatorId,
      state,
    });
  const post = statusReceiverHttp(options, fetcher),
    notification = statusNotifications(db, clock, post, event);
  async function command(proof: StatusReceiverProof) {
    const [row] = await writer()
      .select()
      .from(wholeOrderStatusCommands)
      .where(eq(wholeOrderStatusCommands.id, proof.operationId))
      .limit(1);
    if (
      !row ||
      row.operatorId !== proof.operatorId ||
      row.authVersion !== proof.authVersion ||
      row.storeId !== proof.storeId ||
      row.snapshot.counterId !== proof.counterId ||
      row.scopeHash !== proof.scopeHash ||
      row.requestHash !== proof.requestHash ||
      row.requestId !== proof.requestId ||
      immutableScopeHash(scopeSnapshot.parse(row.snapshot)) !== row.scopeHash ||
      statusDigest(sourceStatusBody(row.snapshot, row.platform)) !== row.requestHash
    )
      throw statusServiceDenied();
    return row;
  }
  async function enqueue(row: StatusCommand, stage: StatusPlatform, delay: number) {
    if (!requiredStages(row.platform).includes(stage)) throw statusReconciliation();
    const now = clock();
    await writer()
      .insert(statusAttempts)
      .values({
        id: attemptId(row, stage),
        operationId: row.id,
        platform: stage,
        state: 'QUEUED',
        dueAt: now + delay * 1000,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({ set: { id: sql`${statusAttempts.id}` } });
  }
  async function receipt(row: StatusCommand): Promise<StatusReceipt | null> {
    return writer().transaction(
      async (tx) => {
        const [accepted] = await tx
          .select()
          .from(statusReceivers)
          .where(eq(statusReceivers.id, row.id))
          .limit(1);
        if (!accepted) return null;
        const attempts = await tx
          .select()
          .from(statusAttempts)
          .where(eq(statusAttempts.operationId, row.id));
        const stages = requiredStages(row.platform).flatMap((stage) => {
          const item = attempts.find((value) => value.platform === stage);
          return item
            ? [
                {
                  platform: stage,
                  status: item.state === 'SENDING' ? ('UNKNOWN' as const) : item.state,
                  updatedAt: new Date(item.updatedAt).toISOString(),
                },
              ]
            : [];
        });
        const successful = requiredStages(row.platform).every((stage) =>
          stages.some((value) => value.platform === stage && value.status === 'SUCCESS'),
        );
        const failed = stages.some(
            (value) => value.status === 'FAILED' || value.status === 'UNEXPECTED',
          ),
          unknown = stages.some((value) => value.status === 'UNKNOWN');
        return receiptSchema.parse({
          contract: wholeOrderStatusContract,
          operationId: row.id,
          requestHash: row.requestHash,
          scopeHash: row.scopeHash,
          state: successful ? 'succeeded' : unknown ? 'unknown' : failed ? 'rejected' : 'queued',
          acceptedAt: new Date(accepted.acceptedAt).toISOString(),
          completedAt:
            successful || failed
              ? new Date(Math.max(...attempts.map((value) => value.updatedAt))).toISOString()
              : null,
          taskId: row.id,
          stages,
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  async function accept(proof: StatusReceiverProof, raw: unknown) {
    requireHandoverBarrier(dependencies.assertHandoverAvailable);
    receiverEndpoints(config, options, receiver);
    const body = receiverBody.parse(raw),
      row = await command(proof);
    if (statusDigest(body) !== row.requestHash) throw statusServiceDenied();
    const prior = await receipt(row);
    if (prior) return prior;
    const authority = await repository.authorizeDispatch(row);
    await retryTransaction(() =>
      writer().transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: wholeOrderStatusCommands.id })
          .from(wholeOrderStatusCommands)
          .where(eq(wholeOrderStatusCommands.id, row.id))
          .limit(1)
          .for('update');
        if (!locked) throw statusServiceDenied();
        const now = clock();
        await tx
          .insert(statusReceivers)
          .values({ id: row.id, acceptedAt: now })
          .onDuplicateKeyUpdate({ set: { id: sql`${statusReceivers.id}` } });
        await tx
          .insert(statusAttempts)
          .values({
            id: attemptId(row, row.platform),
            operationId: row.id,
            platform: row.platform,
            state: 'QUEUED',
            dueAt: now + delays[row.platform] * 1000,
            updatedAt: now,
          })
          .onDuplicateKeyUpdate({ set: { id: sql`${statusAttempts.id}` } });
        for (const stage of requiredStages(row.platform))
          if (
            authority.logs.some(
              (value) =>
                value.platform === stage &&
                value.status === 'SUCCESS' &&
                legacyWholeRequestCovers(value.request, row.snapshot, stage),
            )
          ) {
            const id = attemptId(row, stage);
            await tx
              .insert(statusAttempts)
              .values({
                id,
                operationId: row.id,
                platform: stage,
                state: 'SUCCESS',
                dueAt: now,
                updatedAt: now,
                response: { responseCode: 0, responseMessage: 'Success' },
              })
              .onDuplicateKeyUpdate({
                set: {
                  state: sql`CASE WHEN ${statusAttempts.state}='QUEUED' AND ${statusAttempts.operationId}=${row.id} THEN 'SUCCESS' ELSE ${statusAttempts.state} END`,
                },
              });
          }
      }),
    );
    return (await receipt(row))!;
  }
  function runtime(row: StatusCommand, stage: StatusPlatform) {
    const endpoints = receiverEndpoints(config, options, receiver),
      noop = () => {},
      log = { info: noop, warn: noop, error: noop, debug: noop };
    const ports: SourceStorePorts = {
      config: {
        sqs: {
          storeOrderQueueUrl: 'qualified-store-status-sql',
          slackWebhookUrl: '',
          storeOrderInitialDelaySeconds: delays,
          membershipOrderInitialDelaySeconds: { PACK: 0, SHIP: 0, DELIVER: 0 },
          storeOrderRetryDelaySeconds: { PACK: 60, SHIP: 60, DELIVER: 60 },
          membershipOrderRetryDelaySeconds: { PACK: 0, SHIP: 0, DELIVER: 0 },
        },
        vinculum: {
          orderShippedUrl: endpoints.shipped,
          orderDeliveredUrl: endpoints.delivered,
          rateLimits: {
            PACK: { maxRequests: 0, windowMs: 1 },
            SHIP: { maxRequests: 0, windowMs: 1 },
            DELIVER: { maxRequests: 0, windowMs: 1 },
          },
        },
        events: {
          baseUrl: endpoints.events,
          appId: receiver.TSS_EVENTS_APP_ID!,
          appKey: receiver.TSS_EVENTS_APP_KEY!,
        },
      },
      async getStoreOrderLocationAndRef(id) {
        if (id !== row.orderId) throw statusServiceDenied();
        return { orderRefNo: row.snapshot.reference, locationCode: row.snapshot.locationCode };
      },
      async getProductsForPackShip(id, ids) {
        if (
          id !== row.orderId ||
          statusDigest(ids) !== statusDigest(row.snapshot.lines.map((value) => value.id))
        )
          throw statusServiceDenied();
        return row.snapshot.lines.map((value) => ({
          id: value.id,
          productId: value.productId,
          qty: value.quantity,
        }));
      },
      getOrderProductsForNetcore: () => readStatusNetcore(db, row),
      async hasAutoDeliverSuccess(id, selected) {
        if (id !== row.orderId || selected !== stage) throw statusServiceDenied();
        const [attempt] = await writer()
          .select()
          .from(statusAttempts)
          .where(eq(statusAttempts.id, attemptId(row, stage)))
          .limit(1);
        return attempt?.state === 'SUCCESS';
      },
      async clearAutoDeliverSuccess() {
        throw statusReconciliation();
      },
      async executeVinculumJsonRequest(body, url) {
        const [attempt] = await writer()
          .select()
          .from(statusAttempts)
          .where(eq(statusAttempts.id, attemptId(row, stage)))
          .limit(1);
        if (attempt?.state !== 'SENDING') throw statusReconciliation();
        const [call] = await writer()
          .select()
          .from(statusVendorCalls)
          .where(
            and(
              eq(statusVendorCalls.stageId, attempt.id),
              eq(statusVendorCalls.attempt, attempt.attempts),
            ),
          )
          .limit(1);
        if (call?.state !== 'SENDING' || call.bodyHash !== null) throw statusReconciliation();
        await writer()
          .update(statusVendorCalls)
          .set({ bodyHash: statusDigest(body), updatedAt: clock() })
          .where(eq(statusVendorCalls.id, call.id));
        return (await post(
          url,
          body,
          {
            'Content-Type': 'application/json',
            ApiOwner: receiver.WHOLE_ORDER_STATUS_VENDOR_API_OWNER!,
            ApiKey: receiver.WHOLE_ORDER_STATUS_VENDOR_API_KEY!,
          },
          true,
        ))!;
      },
      async upsertAutoDeliverLog(value) {
        if (
          value.orderId !== row.orderId ||
          value.platform !== stage ||
          value.hasProductId !==
            row.snapshot.lines.reduce((left, right) =>
              BigInt(left.id) < BigInt(right.id) ? left : right,
            ).id
        )
          throw statusServiceDenied();
        const response = vendorResponse.parse(JSON.parse(value.response) as unknown),
          state =
            value.status === 'SUCCESS'
              ? 'SUCCESS'
              : value.status === 'UNEXPECTED'
                ? 'UNEXPECTED'
                : 'FAILED',
          stamp = Temporal.Instant.fromEpochMilliseconds(clock())
            .toZonedDateTimeISO('Asia/Kolkata')
            .toPlainDateTime()
            .toString({ smallestUnit: 'second' })
            .replace('T', ' ');
        await writer().transaction(async (tx) => {
          const [attempt] = await tx
            .select()
            .from(statusAttempts)
            .where(eq(statusAttempts.id, attemptId(row, stage)))
            .limit(1)
            .for('update');
          if (attempt?.state !== 'SENDING') throw statusReconciliation();
          const safeResponse = {
            responseCode: response.responseCode,
            responseMessage: ['Success', 'API Hit Quota Exceeded'].includes(
              response.responseMessage,
            )
              ? response.responseMessage
              : 'REMOTE_STATUS_REJECTED',
          };
          const retry =
            state === 'FAILED' &&
            receiver.WHOLE_ORDER_STATUS_DEFINITE_REJECTION_CONTRACT ===
              'vinculum-status-no-effect-v1' &&
            receiver.WHOLE_ORDER_STATUS_RETRY_RESPONSE_CODES.includes(response.responseCode) &&
            attempt.attempts < receiver.WHOLE_ORDER_STATUS_MAX_STAGE_ATTEMPTS;
          const [existing] = await tx
            .select({ id: statusSourceLogWrites.id })
            .from(statusSourceLogWrites)
            .where(
              and(
                eq(statusSourceLogWrites.orderId, BigInt(row.orderId)),
                eq(statusSourceLogWrites.hasProductId, BigInt(value.hasProductId ?? '0')),
                eq(statusSourceLogWrites.platform, stage),
              ),
            )
            .limit(1)
            .for('update');
          const log = {
            platform: stage,
            retries: attempt.attempts,
            request: value.request,
            response: JSON.stringify(safeResponse),
            status: value.status,
            message: value.message,
            updatedAt: stamp,
          };
          if (existing)
            await tx
              .update(statusSourceLogWrites)
              .set(log)
              .where(eq(statusSourceLogWrites.id, existing.id));
          else
            await tx.insert(statusSourceLogWrites).values({
              ...log,
              orderId: BigInt(row.orderId),
              productId: 0n,
              hasProductId: value.hasProductId === null ? null : BigInt(value.hasProductId),
              createdAt: stamp,
            });
          await tx
            .update(statusVendorCalls)
            .set({
              state: state === 'SUCCESS' ? 'SUCCESS' : 'REJECTED',
              responseCode: response.responseCode,
              updatedAt: clock(),
            })
            .where(
              and(
                eq(statusVendorCalls.stageId, attempt.id),
                eq(statusVendorCalls.attempt, attempt.attempts),
                eq(statusVendorCalls.state, 'SENDING'),
              ),
            );
          await tx
            .update(statusAttempts)
            .set({
              state: retry ? 'QUEUED' : state,
              ...(retry ? { dueAt: clock() + retryDelays[stage] * 1000 } : {}),
              response: safeResponse,
              updatedAt: clock(),
            })
            .where(eq(statusAttempts.id, attempt.id));
        });
      },
      async enqueue(_queue, _url, message, delay) {
        if (
          message.source !== 'STORE' ||
          message.force !== false ||
          message.orderId !== row.orderId ||
          statusDigest(message.hasProductIds) !==
            statusDigest(row.snapshot.lines.map((value) => value.id)) ||
          message.platform !== (stage === 'PACK' ? 'SHIP' : 'DELIVER')
        )
          throw statusServiceDenied();
        await enqueue(row, message.platform, delay);
        return attemptId(row, message.platform);
      },
      async sendSlackAlert() {
        event(row, 'VENDOR_UNEXPECTED');
      },
      axios: {
        async post(url, body, request) {
          const kind =
            url === endpoints.events + '/send-netcore-activity-event'
              ? 'activity'
              : url === endpoints.events + '/update-netcore-user-contact'
                ? 'contact'
                : null;
          if (!kind) throw statusServiceDenied();
          return notification(row, kind, url, body, request.headers);
        },
      },
    };
    return { source: createSourceStoreRuntime(ports), log };
  }
  async function runStage(row: StatusCommand, stage: StatusPlatform) {
    try {
      await repository.authorizeDispatch(row);
      const { source, log } = runtime(row, stage),
        [attempt] = await writer()
          .select()
          .from(statusAttempts)
          .where(eq(statusAttempts.id, attemptId(row, stage)))
          .limit(1);
      await source.process(
        row.orderId,
        row.snapshot.lines.map((value) => value.id),
        stage,
        log,
        attempt?.attempts || 1,
        'STORE',
        false,
      );
    } catch {
      await writer()
        .update(statusAttempts)
        .set({ state: 'UNKNOWN', updatedAt: clock() })
        .where(
          and(eq(statusAttempts.id, attemptId(row, stage)), eq(statusAttempts.state, 'SENDING')),
        );
      const [current] = await writer()
        .select()
        .from(statusAttempts)
        .where(eq(statusAttempts.id, attemptId(row, stage)))
        .limit(1);
      if (current?.state === 'UNKNOWN')
        await writer()
          .update(statusVendorCalls)
          .set({ state: 'UNKNOWN', updatedAt: clock() })
          .where(
            and(
              eq(statusVendorCalls.stageId, current.id),
              eq(statusVendorCalls.attempt, current.attempts),
              eq(statusVendorCalls.state, 'SENDING'),
            ),
          );
      if (current?.state === 'SUCCESS' && stage !== 'DELIVER') {
        const next = stage === 'PACK' ? 'SHIP' : 'DELIVER';
        await writer()
          .insert(statusAttempts)
          .values({
            id: attemptId(row, next),
            operationId: row.id,
            platform: next,
            state: 'UNKNOWN',
            dueAt: clock(),
            updatedAt: clock(),
          })
          .onDuplicateKeyUpdate({ set: { id: sql`${statusAttempts.id}` } });
      }
    }
    const result = await receipt(row);
    event(row, result?.state ?? 'unknown');
    return result;
  }
  async function continueSucceeded() {
    const next = alias(statusAttempts, 'next_store_status_stage');
    const completed = await writer()
      .select({ attempt: statusAttempts })
      .from(statusAttempts)
      .leftJoin(
        next,
        and(
          eq(next.operationId, statusAttempts.operationId),
          sql`${next.platform}=CASE WHEN ${statusAttempts.platform}='PACK' THEN 'SHIP' ELSE 'DELIVER' END`,
        ),
      )
      .where(
        and(
          eq(statusAttempts.state, 'SUCCESS'),
          inArray(statusAttempts.platform, ['PACK', 'SHIP']),
          isNull(next.id),
        ),
      )
      .orderBy(statusAttempts.updatedAt)
      .limit(50);
    const activity = alias(statusNotificationAttempts, 'store_status_activity'),
      contact = alias(statusNotificationAttempts, 'store_status_contact');
    const notifications = await writer()
      .select({ attempt: statusAttempts })
      .from(statusAttempts)
      .leftJoin(
        activity,
        and(eq(activity.operationId, statusAttempts.operationId), eq(activity.kind, 'activity')),
      )
      .leftJoin(
        contact,
        and(eq(contact.operationId, statusAttempts.operationId), eq(contact.kind, 'contact')),
      )
      .where(
        and(
          eq(statusAttempts.state, 'SUCCESS'),
          eq(statusAttempts.platform, 'DELIVER'),
          isNull(contact.id),
          or(isNull(activity.id), eq(activity.state, 'SUCCESS')),
        ),
      )
      .orderBy(statusAttempts.updatedAt)
      .limit(50);
    for (const { attempt } of [...completed, ...notifications]) {
      const [row] = await writer()
        .select()
        .from(wholeOrderStatusCommands)
        .where(eq(wholeOrderStatusCommands.id, attempt.operationId))
        .limit(1);
      if (row) await runStage(row, attempt.platform);
    }
  }
  async function runOnce() {
    requireHandoverBarrier(dependencies.assertHandoverAvailable);
    receiverEndpoints(config, options, receiver);
    await continueSucceeded();
    const selected = await retryTransaction(() =>
      writer().transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(statusAttempts)
          .where(and(eq(statusAttempts.state, 'QUEUED'), lte(statusAttempts.dueAt, clock())))
          .orderBy(statusAttempts.dueAt, statusAttempts.id)
          .limit(1)
          .for('update', { skipLocked: true });
        const attempt = rows[0];
        if (!attempt) return null;
        const limit = limits[attempt.platform];
        await tx
          .insert(statusRates)
          .values({ platform: attempt.platform, nextAt: 0 })
          .onDuplicateKeyUpdate({ set: { platform: sql`${statusRates.platform}` } });
        const [rate] = await tx
          .select()
          .from(statusRates)
          .where(eq(statusRates.platform, attempt.platform))
          .limit(1)
          .for('update');
        if (rate!.nextAt > clock()) return null;
        await tx
          .update(statusRates)
          .set({
            nextAt: clock() + (limit.max > 0 ? Math.ceil((limit.window * 1000) / limit.max) : 0),
          })
          .where(eq(statusRates.platform, attempt.platform));
        if (attempt.attempts >= receiver.WHOLE_ORDER_STATUS_MAX_STAGE_ATTEMPTS)
          throw statusReconciliation();
        await tx
          .update(statusAttempts)
          .set({
            state: 'SENDING',
            attempts: attempt.attempts + 1,
            claimedAt: clock(),
            updatedAt: clock(),
          })
          .where(eq(statusAttempts.id, attempt.id));
        await tx.insert(statusVendorCalls).values({
          id: randomUUID(),
          stageId: attempt.id,
          attempt: attempt.attempts + 1,
          state: 'SENDING',
          bodyHash: null,
          createdAt: clock(),
          updatedAt: clock(),
        });
        return attempt;
      }),
    );
    if (!selected) return null;
    const [row] = await writer()
      .select()
      .from(wholeOrderStatusCommands)
      .where(eq(wholeOrderStatusCommands.id, selected.operationId))
      .limit(1);
    if (!row) throw statusReconciliation();
    return runStage(row, selected.platform);
  }
  return {
    ready: () => {
      requireHandoverBarrier(dependencies.assertHandoverAvailable);
      receiverEndpoints(config, options, receiver);
    },
    accept,
    async read(proof: StatusReceiverProof) {
      return receipt(await command(proof));
    },
    runOnce,
    continueSucceeded,
    async expireClaims() {
      await writer().transaction(async (tx) => {
        const expired = await tx
          .select()
          .from(statusAttempts)
          .where(
            and(
              eq(statusAttempts.state, 'SENDING'),
              lte(statusAttempts.claimedAt, clock() - options.WHOLE_ORDER_STATUS_CLAIM_TIMEOUT_MS),
            ),
          )
          .limit(100)
          .for('update', { skipLocked: true });
        for (const row of expired) {
          await tx
            .update(statusAttempts)
            .set({ state: 'UNKNOWN', updatedAt: clock() })
            .where(eq(statusAttempts.id, row.id));
          await tx
            .update(statusVendorCalls)
            .set({ state: 'UNKNOWN', updatedAt: clock() })
            .where(
              and(
                eq(statusVendorCalls.stageId, row.id),
                eq(statusVendorCalls.attempt, row.attempts),
                eq(statusVendorCalls.state, 'SENDING'),
              ),
            );
        }
      });
    },
  };
}
export type WholeOrderStatusReceiver = ReturnType<typeof wholeOrderStatusReceiver>;
