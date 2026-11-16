import type { Draft } from '../api/types';
import { ApiError, put } from '../api/client';
import { db, type LocalDraft, type PosDatabase } from './database';
import { draftSchema } from '../api/schemas';

export async function queueDraft(cart: LocalDraft, database: PosDatabase = db): Promise<void> {
  await database.transaction(
    'rw',
    [database.operations, database.clearedDrafts, database.offlineCashReceipts],
    async () => {
      if (
        await database.offlineCashReceipts
          .where('[ownerId+draftId]')
          .equals([cart.ownerId, cart.id])
          .first()
      )
        throw new Error(
          'Cash has already been received for this sale. It cannot be queued as a draft.',
        );
      if (await database.clearedDrafts.get([cart.ownerId, cart.id]))
        throw new Error('This checkout was cleared. Open a new sale before saving again.');
      const existing = await database.operations
        .where('[ownerId+draftId]')
        .equals([cart.ownerId, cart.id])
        .first();
      if (existing)
        throw new Error(
          existing.state === 'conflict'
            ? 'Resolve this cart’s sync conflict before saving again.'
            : 'This cart already has a pending save.',
        );
      const mutationId = crypto.randomUUID();
      const { ownerId, updatedAt: _updatedAt, createdAt: _createdAt, version, ...draft } = cart;
      await database.operations.add({
        id: mutationId,
        ownerId,
        draftId: cart.id,
        storeId: cart.storeId,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        payload: { mutationId, expectedVersion: version, draft },
      });
    },
  );
}
export async function replay(
  ownerId: string,
  send: (body: import('../api/types').DraftMutation) => Promise<Draft> = (body) =>
    put(
      `/api/v1/stores/${body.draft.storeId}/cart-drafts/${body.draft.id}`,
      body,
      {
        headers: { 'X-Operator-Id': ownerId },
      },
      draftSchema,
    ),
): Promise<void> {
  const work = async () => {
    const operations = await db.operations.where('ownerId').equals(ownerId).toArray();
    for (const op of operations) {
      if (!['pending', 'retry'].includes(op.state) || op.nextAttemptAt > Date.now()) continue;
      try {
        const result = await send(op.payload);
        await db.transaction('rw', db.drafts, db.operations, async () => {
          const cart = await db.drafts.get([ownerId, op.draftId]);
          // Local edits after enqueue survive; only the server version advances.
          if (cart) await db.drafts.put({ ...cart, version: result.version });
          await db.operations.delete(op.id);
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.code === 'OPERATOR_CHANGED')
        )
          return;
        const state =
          error instanceof ApiError && error.status === 409
            ? 'conflict'
            : error instanceof ApiError && error.status >= 400 && error.status < 500
              ? 'rejected'
              : 'retry';
        await db.operations.update(op.id, {
          state,
          attempts: op.attempts + 1,
          nextAttemptAt: Date.now() + Math.min(60000, 1000 * 2 ** Math.min(op.attempts, 6)),
          message: error instanceof Error ? error.message : 'Connection lost.',
        });
        if (state === 'retry') return;
      }
    }
  };
  if (globalThis.navigator?.locks)
    await navigator.locks.request(
      `souled-pos-sync-${ownerId}`,
      { ifAvailable: true },
      async (lock) => {
        if (lock) await work();
      },
    );
  else await work();
}

export async function resolveConflict(
  ownerId: string,
  operationId: string,
  remote: Draft,
  choice: 'local' | 'server',
) {
  await db.transaction(
    'rw',
    [db.drafts, db.operations, db.clearedDrafts, db.offlineCashReceipts],
    async () => {
      const operation = await db.operations.get(operationId);
      if (!operation || operation.ownerId !== ownerId || operation.state !== 'conflict')
        throw new Error('This conflict is no longer available.');
      const local = await db.drafts.get([ownerId, operation.draftId]);
      if (
        !local ||
        remote.id !== local.id ||
        remote.storeId !== local.storeId ||
        remote.counterId !== local.counterId
      )
        throw new Error('The server sale does not match this device’s sale.');
      const resolved: LocalDraft =
        choice === 'server'
          ? { ...remote, ownerId, createdAt: local.createdAt, updatedAt: Date.now() }
          : { ...local, version: remote.version };
      await db.drafts.put(resolved);
      await db.operations.delete(operationId);
      if (choice === 'local') await queueDraft(resolved);
    },
  );
}
