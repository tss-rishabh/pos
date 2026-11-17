import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { PosUser, Store } from '../../../db/legacy-schema.js';
import { operatorAuthEpochs } from '../../../auth/revocation.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { identifier } from '../../../domain/validation.js';
import type { checkInService } from '../../administration/checkins.js';
import { assertCurrentStoreAccess } from '../../administration/authorization.js';
import { contactActorVersion } from '../../customer-contacts/authority.js';
import { checkoutSessions, checkoutOperations } from '../schema.js';
import { checkoutStateSchema } from '../contracts.js';
import { readCustomerContactBinding } from '../customer-contact-authority.js';
import type { Payload } from '../payloads.js';
import { signNodeScreeningWriter, type NodeScreeningWriterConfiguration } from './capability.js';

const inputSchema = z
  .object({ storeId: identifier, checkoutId: z.uuid(), operationId: z.uuid() })
  .strict();
const changed = () =>
  new AppError(
    409,
    'SCREENING_WRITER_SCOPE_CHANGED',
    'The sale changed. Refresh its final quote before continuing.',
  );
/** Internal server producer only. The payload comes from orderPayload, never a browser capability. */
export function nodeScreeningWriterIssuer(options: {
  db: Databases;
  environment: NodeScreeningWriterConfiguration;
  checkins: Pick<ReturnType<typeof checkInService>, 'assertCheckIn'>;
  authSessionValid: (user: Principal) => Promise<boolean>;
  clock?: () => number;
}) {
  const clock = options.clock ?? Date.now;
  return {
    async issue(user: Principal, scope: z.infer<typeof inputSchema>, payload: Payload) {
      scope = inputSchema.parse(scope);
      if (!(await options.authSessionValid(user)))
        throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      const [hint] = await options.db
        .get('writer')
        .select({ state: checkoutSessions.state })
        .from(checkoutSessions)
        .where(
          and(
            eq(checkoutSessions.id, scope.checkoutId),
            eq(checkoutSessions.operatorId, user.id),
            eq(checkoutSessions.storeId, scope.storeId),
          ),
        )
        .limit(1);
      if (!hint) throw changed();
      const hinted = checkoutStateSchema.parse(hint.state);
      const result = await options.db.get('writer').transaction(
        async (tx) => {
          // Actor/epoch precede Store/check-in, matching archive and source admission.
          const [actor] = await tx
            .select({ id: PosUser.id, active: PosUser.is_active })
            .from(PosUser)
            .where(eq(PosUser.id, BigInt(user.id)))
            .limit(1)
            .for('share');
          if (!actor?.active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
          const [epoch] = await tx
            .select({ value: operatorAuthEpochs.epoch })
            .from(operatorAuthEpochs)
            .where(eq(operatorAuthEpochs.userId, user.id))
            .limit(1)
            .for('share');
          const [store] = await tx
            .select({ id: Store.id })
            .from(Store)
            .where(eq(Store.id, BigInt(scope.storeId)))
            .limit(1)
            .for('update');
          if (!store) throw changed();
          await assertCurrentStoreAccess(tx, user.id, scope.storeId);
          // Hint only selects counter; acquire check-in before the checkout row and
          // compare again after waiting for both current native locks.
          await options.checkins.assertCheckIn(user.id, scope.storeId, hinted.counterId, tx);
          const [current] = await tx
            .select()
            .from(checkoutSessions)
            .where(eq(checkoutSessions.id, scope.checkoutId))
            .limit(1)
            .for('update');
          if (!current || current.operatorId !== user.id || current.storeId !== scope.storeId)
            throw changed();
          const state = checkoutStateSchema.parse(current.state);
          if (state.counterId !== hinted.counterId || state.busyOperationId !== scope.operationId)
            throw changed();
          const [operation] = await tx
            .select({ status: checkoutOperations.status })
            .from(checkoutOperations)
            .where(
              and(
                eq(checkoutOperations.checkoutId, state.id),
                eq(checkoutOperations.id, scope.operationId),
              ),
            )
            .limit(1);
          if (operation?.status !== 'inflight') throw changed();
          const contact = await readCustomerContactBinding(
            tx,
            state.customerId ?? state.operatorCustomerId,
          );
          return signNodeScreeningWriter(options.environment, {
            state,
            operationId: scope.operationId,
            actorVersion: await contactActorVersion(tx, user.id),
            actorEpoch: String(epoch?.value ?? 0n),
            contact,
            payload,
            now: clock(),
          });
        },
        { isolationLevel: 'read committed' },
      );
      if (!(await options.authSessionValid(user)))
        throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      return result;
    },
  };
}
