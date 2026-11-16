import { and, asc, eq, gte, inArray, lt, ne, notExists, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/mysql-core';
import { Store } from '../../../db/legacy-schema.js';
import { retryTransaction } from '../../../db/retry.js';
import { AppError } from '../../../domain/errors.js';
import { issueCustomerToken } from '../../checkout/crypto.js';
import type { CheckoutEnvironment } from '../../checkout/gateway.js';
import { legacyCommands, legacyHyperlocalLogs } from '../schema.js';
import { providerRequest, type ProviderResult } from './contracts.js';
import { eventId, reconciliation } from './domain.js';
import { addStoreSlack, slackDestination, ticketAcknowledged } from './effects.js';
import { localDeliveryService } from './service.js';
import type { LifecycleRuntime } from './runtime.js';
import { deliveryCalls, deliveryCommands, deliveryJobs } from './schema.js';
import { resultForRequest } from './provider.js';

export function localDeliveryWorker(
  runtime: LifecycleRuntime,
  service: ReturnType<typeof localDeliveryService>,
  keys: Pick<CheckoutEnvironment, 'hs256' | 'hs512'> = {},
) {
  async function markProblem(
    commandId: string,
    code:
      | 'PROVIDER_OUTCOME_UNKNOWN'
      | 'CURRENT_AUTHORITY_REQUIRED'
      | 'SOURCE_STATE_RECONCILIATION_REQUIRED'
      | 'DEPENDENCY_UNAVAILABLE',
  ) {
    await retryTransaction(() =>
      runtime.db.get('writer').transaction(async (tx) => {
        const command = await runtime.command(tx, commandId);
        if (command.phase === 'completed') return;
        await runtime.save(tx, command, {
          phase: code === 'PROVIDER_OUTCOME_UNKNOWN' ? 'uncertain' : 'reconciliation-required',
          errorCode: code,
        });
      }),
    );
  }
  return {
    async dispatchNext(signal?: AbortSignal) {
      const prepared = await retryTransaction(() =>
        runtime.db.get('writer').transaction(async (tx) => {
          const prior = alias(deliveryCalls, 'earlier_local_delivery_call');
          const [call] = await tx
            .select({ call: deliveryCalls })
            .from(deliveryCalls)
            .innerJoin(deliveryCommands, eq(deliveryCommands.id, deliveryCalls.commandId))
            .where(
              and(
                eq(deliveryCalls.status, 'PENDING'),
                or(
                  and(
                    lt(deliveryCalls.sequence, 10000),
                    inArray(deliveryCommands.phase, ['queued', 'sending', 'applying']),
                  ),
                  and(
                    ne(deliveryCommands.phase, 'rejected'),
                    eq(deliveryCommands.phase, 'completed'),
                  ),
                  and(gte(deliveryCalls.sequence, 20000), ne(deliveryCommands.phase, 'rejected')),
                ),
                or(
                  gte(deliveryCalls.sequence, 20000),
                  notExists(
                    tx
                      .select({ id: prior.id })
                      .from(prior)
                      .where(
                        and(
                          eq(prior.commandId, deliveryCalls.commandId),
                          lt(prior.sequence, deliveryCalls.sequence),
                          lt(prior.sequence, 10000),
                          ne(prior.status, 'ACKNOWLEDGED'),
                        ),
                      ),
                  ),
                ),
              ),
            )
            .orderBy(
              asc(deliveryCalls.createdAt),
              asc(deliveryCalls.commandId),
              asc(deliveryCalls.sequence),
            )
            .limit(1)
            .for('update', { skipLocked: true });
          if (!call) return null;
          const command = await runtime.command(tx, call.call.commandId),
            request = providerRequest.parse(call.call.request),
            [identity] = await tx
              .select({ requestId: legacyCommands.requestId })
              .from(legacyCommands)
              .where(eq(legacyCommands.id, command.id))
              .limit(1)
              .for('share');
          if (!identity) throw reconciliation();
          let slackUrl: string | undefined,
            ready = false;
          try {
            slackUrl = await slackDestination(runtime, tx, request);
            ready = runtime.dependencies.provider.ready(request.kind, slackUrl);
          } catch {
            /* A changed destination requires explicit reconciliation. */
          }
          if (!ready) {
            await tx
              .update(deliveryCalls)
              .set({ status: 'BLOCKED' })
              .where(eq(deliveryCalls.id, request.id));
            if (call.call.sequence < 10000)
              await runtime.save(tx, command, {
                phase: 'reconciliation-required',
                errorCode: 'DEPENDENCY_UNAVAILABLE',
              });
            return {
              blocked: true as const,
              callId: request.id,
              commandId: command.id,
              requestId: identity.requestId,
              userId: command.state.actorId,
              kind: request.kind,
            };
          }
          let token: string | undefined;
          try {
            if (call.call.sequence >= 10000)
              await runtime.authority.auxiliary(tx, command.snapshot, request);
            else await runtime.context(tx, command);
            if (request.kind === 'online-convert' || request.kind === 'cancel-item') {
              const customer = await runtime.authority.customer(tx, request.customerId);
              token = issueCustomerToken(
                {
                  id: String(customer.id),
                  email: '',
                  firstName: '',
                  lastName: '',
                  telephone: '',
                  twoFactor: customer.twoFactor === 1,
                  active: true,
                  exclusive: false,
                },
                keys,
                runtime.instant(),
              );
            }
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            await tx
              .update(deliveryCalls)
              .set({ status: 'BLOCKED' })
              .where(eq(deliveryCalls.id, request.id));
            if (call.call.sequence < 10000)
              await runtime.save(tx, command, {
                phase: 'reconciliation-required',
                errorCode: 'CURRENT_AUTHORITY_REQUIRED',
              });
            return {
              blocked: true as const,
              callId: request.id,
              commandId: command.id,
              requestId: identity.requestId,
              userId: command.state.actorId,
              kind: request.kind,
            };
          }
          await tx
            .update(deliveryCalls)
            .set({
              status: 'SENDING',
              claimedAt: runtime.instant(),
              attempts: call.call.attempts + 1,
            })
            .where(eq(deliveryCalls.id, request.id));
          if (call.call.sequence < 10000)
            await runtime.save(tx, command, { phase: 'sending', errorCode: null });
          return {
            blocked: false as const,
            callId: request.id,
            commandId: command.id,
            requestId: identity.requestId,
            userId: command.state.actorId,
            kind: request.kind,
            sequence: call.call.sequence,
            attempt: call.call.attempts + 1,
            request,
            token,
            slackUrl,
          };
        }),
      );
      if (!prepared) return null;
      if (prepared.blocked) return { ...prepared, status: 'BLOCKED' as const };
      let result: ProviderResult;
      try {
        result = resultForRequest(
          prepared.kind,
          await runtime.dependencies.provider.send(
            prepared.request,
            prepared.token,
            prepared.requestId,
            signal,
            { slackUrl: prepared.slackUrl },
          ),
        );
      } catch (error) {
        const notSent = error instanceof AppError && error.code === 'UPSTREAM_NOT_SENT',
          status = notSent ? 'BLOCKED' : 'UNCERTAIN';
        await retryTransaction(() =>
          runtime.db.get('writer').transaction(async (tx) => {
            const command = await runtime.command(tx, prepared.commandId),
              [call] = await tx
                .select({ status: deliveryCalls.status, attempts: deliveryCalls.attempts })
                .from(deliveryCalls)
                .where(eq(deliveryCalls.id, prepared.callId))
                .limit(1)
                .for('update');
            if (
              !call ||
              call.attempts !== prepared.attempt ||
              !['SENDING', 'UNCERTAIN'].includes(call.status)
            )
              return;
            await tx
              .update(deliveryCalls)
              .set({ status })
              .where(eq(deliveryCalls.id, prepared.callId));
            if (prepared.sequence < 10000 && command.phase !== 'completed')
              await runtime.save(tx, command, {
                phase: notSent ? 'reconciliation-required' : 'uncertain',
                errorCode: notSent ? 'DEPENDENCY_UNAVAILABLE' : 'PROVIDER_OUTCOME_UNKNOWN',
              });
          }),
        );
        return {
          callId: prepared.callId,
          commandId: prepared.commandId,
          requestId: prepared.requestId,
          userId: prepared.userId,
          kind: prepared.kind,
          status,
        };
      }
      await retryTransaction(() =>
        runtime.db.get('writer').transaction(async (tx) => {
          const command = await runtime.command(tx, prepared.commandId);
          const [call] = await tx
            .select({ status: deliveryCalls.status, attempts: deliveryCalls.attempts })
            .from(deliveryCalls)
            .where(eq(deliveryCalls.id, prepared.callId))
            .limit(1)
            .for('update');
          if (
            !call ||
            !['SENDING', 'UNCERTAIN'].includes(call.status) ||
            call.attempts !== prepared.attempt
          )
            throw reconciliation();
          await tx
            .update(deliveryCalls)
            .set({ status: 'ACKNOWLEDGED', result, completedAt: runtime.instant() })
            .where(eq(deliveryCalls.id, prepared.callId));
          await ticketAcknowledged(runtime, tx, command, prepared.request);
          if (prepared.sequence < 10000)
            await runtime.save(tx, command, { phase: 'applying', errorCode: null });
        }),
      );
      if (prepared.sequence < 10000)
        try {
          await service.apply(prepared.commandId);
        } catch (error) {
          await markProblem(
            prepared.commandId,
            error instanceof AppError &&
              [
                'AUTH_REQUIRED',
                'STORE_ACCESS_DENIED',
                'CHECK_IN_REQUIRED',
                'STORE_UNAVAILABLE',
              ].includes(error.code)
              ? 'CURRENT_AUTHORITY_REQUIRED'
              : 'SOURCE_STATE_RECONCILIATION_REQUIRED',
          );
        }
      return {
        callId: prepared.callId,
        commandId: prepared.commandId,
        requestId: prepared.requestId,
        userId: prepared.userId,
        kind: prepared.kind,
        status: 'ACKNOWLEDGED' as const,
      };
    },
    async applyPending() {
      const rows = await runtime.db
        .get('writer')
        .select({ id: deliveryCommands.id })
        .from(deliveryCommands)
        .where(eq(deliveryCommands.phase, 'applying'))
        .orderBy(asc(deliveryCommands.id))
        .limit(runtime.options.LEGACY_DELIVERY_WORKER_BATCH_SIZE);
      let completed = 0;
      for (const row of rows)
        try {
          const result = await service.apply(row.id);
          if (result.phase === 'completed') completed++;
        } catch (error) {
          await markProblem(
            row.id,
            error instanceof AppError &&
              [
                'AUTH_REQUIRED',
                'STORE_ACCESS_DENIED',
                'CHECK_IN_REQUIRED',
                'STORE_UNAVAILABLE',
              ].includes(error.code)
              ? 'CURRENT_AUTHORITY_REQUIRED'
              : 'SOURCE_STATE_RECONCILIATION_REQUIRED',
          );
        }
      return { completed };
    },
    async runNextJob() {
      const job = await retryTransaction(() =>
        runtime.db.get('writer').transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(deliveryJobs)
            .where(
              and(
                eq(deliveryJobs.status, 'PENDING'),
                lt(deliveryJobs.dueAt, runtime.instant() + 1),
              ),
            )
            .orderBy(asc(deliveryJobs.dueAt), asc(deliveryJobs.id))
            .limit(1)
            .for('update', { skipLocked: true });
          if (!row) return null;
          await tx
            .update(deliveryJobs)
            .set({ status: 'RUNNING', claimedAt: runtime.instant() })
            .where(eq(deliveryJobs.id, row.id));
          return row;
        }),
      );
      if (!job) return null;
      try {
        const origin = await runtime.db.get('writer').transaction(async (tx) => {
          const command = await runtime.command(tx, job.commandId),
            [identity] = await tx
              .select({ requestId: legacyCommands.requestId })
              .from(legacyCommands)
              .where(eq(legacyCommands.id, job.commandId))
              .limit(1)
              .for('share');
          if (!identity) throw reconciliation();
          return { command, requestId: identity.requestId };
        });
        if (job.kind === 'advance-notification') {
          await retryTransaction(() =>
            runtime.db.get('writer').transaction(async (tx) => {
              await runtime.authority.context(
                tx,
                { kind: 'service', id: 'service' },
                String(job.storeId),
                String(job.orderId),
              );
              await runtime.notice(tx, {
                eventId: job.id,
                orderId: String(job.orderId),
                storeId: String(job.storeId),
                title: 'Hyperlocal Order',
                reason: '',
                newOrder: true,
                timestamp: runtime.timestamp(),
                requestId: origin.requestId,
              });
              const [store] = await tx
                .select({ name: Store.store_name })
                .from(Store)
                .where(eq(Store.id, job.storeId))
                .limit(1);
              if (!store) throw reconciliation();
              await addStoreSlack(
                runtime,
                tx,
                origin.command,
                20000,
                String(job.storeId),
                `🛵 Order Id: ${job.orderId}, Hyperlocal Order to ${store.name}`,
              );
              await tx
                .update(deliveryJobs)
                .set({ status: 'COMPLETED', result: { notificationEventId: job.id } })
                .where(eq(deliveryJobs.id, job.id));
            }),
          );
        } else {
          const [terminal] = await runtime.db
            .get('writer')
            .select({ action: legacyHyperlocalLogs.action })
            .from(legacyHyperlocalLogs)
            .where(
              and(
                eq(legacyHyperlocalLogs.orderId, job.orderId),
                inArray(legacyHyperlocalLogs.action, ['ACCEPTED', 'DECLINED', 'CONVERT_ONLINE']),
              ),
            )
            .limit(1);
          if (terminal) {
            await runtime.db
              .get('writer')
              .update(deliveryJobs)
              .set({ status: 'COMPLETED', result: { skipped: true } })
              .where(eq(deliveryJobs.id, job.id));
          } else {
            const childId = eventId('local-delivery-job-command', job.id),
              receipt = await service.submitJob(
                String(job.storeId),
                String(job.orderId),
                job.kind === 'auto-transfer' ? 'pass' : 'convert',
                {
                  commandId: childId,
                  reason: origin.command.input.reason,
                  reasonCategory: origin.command.input.reasonCategory,
                  notify: false,
                },
                origin.requestId,
                {
                  staffName: origin.command.input.staffName,
                  locationIds: origin.command.input.locationIds,
                },
              );
            await runtime.db
              .get('writer')
              .update(deliveryJobs)
              .set({ status: 'COMPLETED', result: { spawnedCommandId: receipt.commandId } })
              .where(eq(deliveryJobs.id, job.id));
          }
        }
        return {
          jobId: job.id,
          commandId: job.commandId,
          requestId: origin.requestId,
          userId: 'service',
          kind: job.kind,
          status: 'COMPLETED' as const,
        };
      } catch (error) {
        const retry = error instanceof AppError && error.code === 'LOCAL_DELIVERY_COMMAND_PENDING';
        await runtime.db
          .get('writer')
          .update(deliveryJobs)
          .set({
            status: retry ? 'PENDING' : 'RECONCILIATION_REQUIRED',
            dueAt: runtime.instant() + 5000,
            result: {
              errorCode: retry ? 'COMMAND_PENDING' : 'SOURCE_STATE_RECONCILIATION_REQUIRED',
            },
          })
          .where(eq(deliveryJobs.id, job.id));
        return {
          jobId: job.id,
          commandId: job.commandId,
          requestId: job.requestId,
          userId: 'service',
          kind: job.kind,
          status: retry ? ('PENDING' as const) : ('RECONCILIATION_REQUIRED' as const),
        };
      }
    },
    async expireClaims() {
      const limit = runtime.instant() - 60000;
      const rows = await runtime.db
        .get('writer')
        .select({
          id: deliveryCalls.id,
          commandId: deliveryCalls.commandId,
          sequence: deliveryCalls.sequence,
          attempts: deliveryCalls.attempts,
        })
        .from(deliveryCalls)
        .where(and(eq(deliveryCalls.status, 'SENDING'), lt(deliveryCalls.claimedAt, limit)))
        .limit(runtime.options.LEGACY_DELIVERY_WORKER_BATCH_SIZE);
      let uncertain = 0;
      for (const row of rows)
        uncertain += await retryTransaction(() =>
          runtime.db.get('writer').transaction(async (tx) => {
            const command = await runtime.command(tx, row.commandId),
              [call] = await tx
                .select()
                .from(deliveryCalls)
                .where(eq(deliveryCalls.id, row.id))
                .limit(1)
                .for('update');
            if (
              !call ||
              call.status !== 'SENDING' ||
              call.attempts !== row.attempts ||
              call.claimedAt === null ||
              call.claimedAt >= limit
            )
              return 0;
            await tx
              .update(deliveryCalls)
              .set({ status: 'UNCERTAIN' })
              .where(eq(deliveryCalls.id, row.id));
            if (row.sequence < 10000 && command.phase !== 'completed')
              await runtime.save(tx, command, {
                phase: 'uncertain',
                errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
              });
            return 1;
          }),
        );
      await runtime.db
        .get('writer')
        .update(deliveryJobs)
        .set({ status: 'PENDING', claimedAt: null })
        .where(and(eq(deliveryJobs.status, 'RUNNING'), lt(deliveryJobs.claimedAt, limit)));
      return { uncertain };
    },
  };
}
