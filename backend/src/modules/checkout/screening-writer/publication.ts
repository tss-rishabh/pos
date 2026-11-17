import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { boundedText } from '../../../domain/http-json.js';
import { equalImportHash } from '../../legacy-order-imports/financial-adapter-crypto.js';
import { lockScreeningCustomer } from '../../legacy-order-imports/screening-transactions.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { checkoutSessions } from '../schema.js';
import type { PublicScreeningCoordinator } from './coordinator.js';
import {
  lockPublicActor,
  lockPublicStore,
  lockPublicCheckout,
  readPublicIntent,
  matchesPublicCreation,
  verifyPublicStructure,
} from './native.js';
import {
  readPublicScreeningCreation,
  publicScreeningHash,
  screeningReconciliationRequired,
  type PublicScreeningCreation,
} from './proof.js';
import { readPublicCompletion } from './settlement.js';
import {
  publicScreeningWork,
  publicScreeningPublicationDispatches,
  publicScreeningPublicationReplies,
} from './schema.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const publicPublicationSchema = z
  .object({
    contract: z.literal('pos-node-screening-publication-v1'),
    operationId: z.uuid(),
    creationHash: hash,
    completionHash: hash,
    effectsHash: hash,
    status: z.enum(['pending', 'processing', 'uncertain', 'accepted', 'cancelled']),
    deliveries: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
            kind: z.enum([
              'warehouse',
              'cashback',
              'facebook',
              'engagement',
              'shadow',
              'kinesis-chain',
              'sms',
              'membership-cache',
              'cart-tracking',
            ]),
          })
          .strict(),
      )
      .max(20),
    updatedAt: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.deliveries.map((row) => row.id)).size !== value.deliveries.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate delivery identity' });
  });
const dispatchSchema = z
  .object({
    contract: z.literal('pos-node-screening-publication-dispatch-v1'),
    operationId: z.uuid(),
    creationHash: hash,
    completionHash: hash,
    effectsHash: hash,
    dispatchedAt: z.number().int().positive().safe(),
  })
  .strict();
export async function readPublicPublication(
  tx: AdministrationTransaction,
  creation: PublicScreeningCreation,
  key: string,
) {
  const [row] = await tx
    .select()
    .from(publicScreeningPublicationReplies)
    .where(eq(publicScreeningPublicationReplies.operationId, creation.operationId))
    .limit(1)
    .for('share');
  if (!row) return null;
  const value = publicPublicationSchema.parse(row.data);
  if (
    value.operationId !== creation.operationId ||
    value.creationHash !== publicScreeningHash(key, 'creation', creation) ||
    value.effectsHash !== creation.effectsHash ||
    !equalImportHash(publicScreeningHash(key, 'publication', value), row.proofHash)
  )
    throw screeningReconciliationRequired();
  const completion = await readPublicCompletion(tx, creation, key);
  if (!completion || value.completionHash !== publicScreeningHash(key, 'completion', completion))
    throw screeningReconciliationRequired();
  return value;
}
/** Caller owns Store → checkout → intent → global customer. Retained evidence
 * reads intentionally do not require the original operator to remain active. */
export async function lockRetainedPublicScreening(
  coordinator: PublicScreeningCoordinator,
  tx: AdministrationTransaction,
  operationId: string,
) {
  const [hint] = await tx
    .select({
      actorId: publicScreeningWork.actorId,
      storeId: publicScreeningWork.storeId,
      checkoutId: publicScreeningWork.checkoutId,
    })
    .from(publicScreeningWork)
    .where(eq(publicScreeningWork.operationId, operationId))
    .limit(1);
  if (!hint) return null;
  await lockPublicActor(tx, hint.actorId);
  await lockPublicStore(tx, hint.storeId);
  const [checkout] = await tx
    .select({ id: checkoutSessions.id })
    .from(checkoutSessions)
    .where(eq(checkoutSessions.id, hint.checkoutId))
    .limit(1)
    .for('update');
  if (!checkout) throw screeningReconciliationRequired();
  const intent = await readPublicIntent(tx, operationId, coordinator.key());
  if (
    !intent ||
    intent.value.actorId !== hint.actorId ||
    intent.value.storeId !== hint.storeId ||
    intent.value.checkoutId !== hint.checkoutId
  )
    throw screeningReconciliationRequired();
  await lockScreeningCustomer(tx, intent.value.customerId);
  const creation = await readPublicScreeningCreation(tx, operationId, coordinator.key());
  if (!creation) return { intent, creation: null };
  if (!matchesPublicCreation(creation, intent.value)) throw screeningReconciliationRequired();
  await lockPublicCheckout(tx, creation);
  return { intent, creation };
}
function endpoint(options: PublicScreeningCoordinator['options']) {
  if (
    !options.publicationUrl ||
    !options.publicationKey ||
    !/^[!-~]{32,4096}$/.test(options.publicationKey)
  )
    return null;
  if (options.publicationKey === options.proofKey) throw screeningReconciliationRequired();
  const url = new URL(options.publicationUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/internal/pos/public-screening/publications'
  )
    throw screeningReconciliationRequired();
  return url;
}
export function publicScreeningPublicationWorker(coordinator: PublicScreeningCoordinator) {
  async function claim(operationId: string) {
    return coordinator.transaction(async (tx) => {
      const locked = await lockRetainedPublicScreening(coordinator, tx, operationId);
      if (!locked || !locked.creation || locked.intent.row.nextCheckAt > coordinator.clock())
        return null;
      const { creation } = locked;
      await verifyPublicStructure(tx, creation, coordinator.key());
      const completion = await readPublicCompletion(tx, creation, coordinator.key());
      if (!completion) return null;
      const accepted = await readPublicPublication(tx, creation, coordinator.key());
      if (accepted && ['accepted', 'cancelled'].includes(accepted.status)) {
        await tx
          .update(publicScreeningWork)
          .set({
            status: 'publication-' + accepted.status,
            nextCheckAt: Number.MAX_SAFE_INTEGER,
            updatedAt: coordinator.clock(),
          })
          .where(eq(publicScreeningWork.operationId, operationId));
        return null;
      }
      const [prior] = await tx
        .select()
        .from(publicScreeningPublicationDispatches)
        .where(eq(publicScreeningPublicationDispatches.operationId, operationId))
        .limit(1)
        .for('share');
      const values = {
        operationId,
        creationHash: publicScreeningHash(coordinator.key(), 'creation', creation),
        completionHash: publicScreeningHash(coordinator.key(), 'completion', completion),
        effectsHash: creation.effectsHash,
      };
      let dispatch: ReturnType<typeof dispatchSchema.parse>;
      if (prior) {
        dispatch = dispatchSchema.parse(prior.data);
        if (
          dispatch.operationId !== operationId ||
          dispatch.creationHash !== values.creationHash ||
          dispatch.completionHash !== values.completionHash ||
          dispatch.effectsHash !== values.effectsHash ||
          !equalImportHash(
            publicScreeningHash(coordinator.key(), 'publication-dispatch', dispatch),
            prior.proofHash,
          )
        )
          throw screeningReconciliationRequired();
      } else {
        // Disabling new work never disables native/GET reconciliation. A new
        // effects dispatch, however, requires the explicit selected resource.
        if (
          coordinator.options.publicationContract !==
            'pos-node-screening-publication-resource-v1' ||
          !endpoint(coordinator.options)
        ) {
          await tx
            .update(publicScreeningWork)
            .set({
              status: 'publication-unavailable',
              nextCheckAt: coordinator.clock() + 30000,
              updatedAt: coordinator.clock(),
            })
            .where(eq(publicScreeningWork.operationId, operationId));
          return null;
        }
        dispatch = dispatchSchema.parse({
          contract: 'pos-node-screening-publication-dispatch-v1',
          ...values,
          dispatchedAt: coordinator.clock(),
        });
        await tx.insert(publicScreeningPublicationDispatches).values({
          operationId,
          data: dispatch,
          proofHash: publicScreeningHash(coordinator.key(), 'publication-dispatch', dispatch),
        });
      }
      const url = endpoint(coordinator.options);
      if (!url) return null;
      await tx
        .update(publicScreeningWork)
        .set({
          status: 'publication-processing',
          nextCheckAt: coordinator.clock() + 30000,
          updatedAt: coordinator.clock(),
        })
        .where(eq(publicScreeningWork.operationId, operationId));
      return { method: prior ? ('GET' as const) : ('POST' as const), dispatch, url: String(url) };
    });
  }
  async function retain(
    operationId: string,
    data: z.infer<typeof publicPublicationSchema>,
    proofHash: string,
  ) {
    await coordinator.transaction(async (tx) => {
      const locked = await lockRetainedPublicScreening(coordinator, tx, operationId);
      if (!locked?.creation) throw screeningReconciliationRequired();
      const { creation } = locked;
      await verifyPublicStructure(tx, creation, coordinator.key());
      const completion = await readPublicCompletion(tx, creation, coordinator.key());
      if (
        !completion ||
        data.operationId !== operationId ||
        data.creationHash !== publicScreeningHash(coordinator.key(), 'creation', creation) ||
        data.completionHash !== publicScreeningHash(coordinator.key(), 'completion', completion) ||
        data.effectsHash !== creation.effectsHash ||
        !equalImportHash(publicScreeningHash(coordinator.key(), 'publication', data), proofHash)
      )
        throw screeningReconciliationRequired();
      const prior = await readPublicPublication(tx, creation, coordinator.key());
      if (
        prior &&
        (prior.updatedAt > data.updatedAt ||
          (['accepted', 'cancelled'].includes(prior.status) &&
            JSON.stringify(prior) !== JSON.stringify(data)))
      )
        throw screeningReconciliationRequired();
      await tx
        .insert(publicScreeningPublicationReplies)
        .values({ operationId, data, proofHash })
        .onDuplicateKeyUpdate({ set: { data, proofHash } });
      const terminal = ['accepted', 'cancelled'].includes(data.status);
      await tx
        .update(publicScreeningWork)
        .set({
          status: 'publication-' + data.status,
          nextCheckAt: terminal ? Number.MAX_SAFE_INTEGER : coordinator.clock() + 30000,
          updatedAt: coordinator.clock(),
        })
        .where(eq(publicScreeningWork.operationId, operationId));
    });
  }
  async function one(operationId: string, signal?: AbortSignal) {
    const task = await claim(operationId);
    if (!task) return 'skipped' as const;
    try {
      const url = task.method === 'POST' ? task.url : task.url + '/' + operationId;
      const response = await (coordinator.options.fetcher ?? fetch)(url, {
        method: task.method,
        headers: {
          'X-POS-Public-Screening-Publication-Key': coordinator.options.publicationKey!,
          'X-Request-ID': crypto.randomUUID(),
          ...(task.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(task.method === 'POST' ? { body: JSON.stringify({ operationId }) } : {}),
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      });
      if (!response.ok) throw screeningReconciliationRequired();
      const result = z
        .object({ data: publicPublicationSchema, proofHash: hash })
        .strict()
        .parse(JSON.parse(await boundedText(response, 16000)) as unknown);
      await retain(operationId, result.data, result.proofHash);
      return result.data.status === 'accepted' ? ('accepted' as const) : ('pending' as const);
    } catch {
      // The durable dispatch remains. Even a timeout before fetch/receipt GET
      // is unknown; the worker can only GET the original operation next time.
      await coordinator.transaction(async (tx) => {
        const locked = await lockRetainedPublicScreening(coordinator, tx, operationId);
        if (!locked) return;
        if (!['publication-accepted', 'publication-cancelled'].includes(locked.intent.row.status))
          await tx
            .update(publicScreeningWork)
            .set({
              status: 'publication-uncertain',
              nextCheckAt: coordinator.clock() + 30000,
              updatedAt: coordinator.clock(),
            })
            .where(eq(publicScreeningWork.operationId, operationId));
      });
      return 'uncertain' as const;
    }
  }
  return {
    one,
    async drain(signal?: AbortSignal, limit = 20) {
      if (!coordinator.options.proofKey) return { accepted: 0, pending: 0, uncertain: 0 };
      const rows = await coordinator.db
        .get('writer')
        .select({ id: publicScreeningWork.operationId })
        .from(publicScreeningWork)
        .where(
          and(
            inArray(publicScreeningWork.status, [
              'publication-pending',
              'publication-processing',
              'publication-uncertain',
              'publication-unavailable',
            ]),
            lte(publicScreeningWork.nextCheckAt, coordinator.clock()),
          ),
        )
        .orderBy(asc(publicScreeningWork.nextCheckAt), asc(publicScreeningWork.operationId))
        .limit(z.number().int().min(1).max(100).parse(limit));
      const result = { accepted: 0, pending: 0, uncertain: 0 };
      for (const row of rows) {
        if (signal?.aborted) break;
        const outcome = await one(row.id, signal);
        if (outcome !== 'skipped') result[outcome]++;
      }
      return result;
    },
  };
}
