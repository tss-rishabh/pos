import { generatedId } from '../../db/generated-id.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosHyperlocalSlot, PosMachine, PosPaytmMachine, Store } from '../../db/legacy-schema.js';
import { requireRole, requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { DeliverySlotInput } from './contracts.js';
import { retryTransaction } from '../../db/retry.js';
import { assertCurrentStoreAccess } from './authorization.js';

export function supportService(config: Config, db: Databases) {
  return {
    async createDeliverySlot(user: Principal, storeId: string, input: DeliverySlotInput) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await assertCurrentStoreAccess(transaction, user.id, storeId, [1, 2, 3]);
          const [store] = await transaction
            .select({ id: Store.id })
            .from(Store)
            .where(
              and(
                eq(Store.id, BigInt(storeId)),
                eq(Store.is_active, true),
                inArray(Store.type, ['STORE', 'CORE_WAREHOUSE']),
              ),
            )
            .limit(1)
            .for('update');
          if (!store)
            throw new AppError(404, 'STORE_NOT_FOUND', 'An active sales store was not found.');
          const [existing] = await transaction
            .select({ id: PosHyperlocalSlot.id })
            .from(PosHyperlocalSlot)
            .where(
              and(
                eq(PosHyperlocalSlot.store_id, BigInt(storeId)),
                eq(PosHyperlocalSlot.weekday, input.weekday),
              ),
            )
            .limit(1);
          if (existing)
            throw new AppError(
              409,
              'DELIVERY_SLOT_EXISTS',
              'You cannot add multiple weekdays for the same store.',
            );
          const timestamp = Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
            .toPlainDateTime()
            .toString({ smallestUnit: 'second' })
            .replace('T', ' ');
          const inserted = await transaction.insert(PosHyperlocalSlot).values({
            store_id: BigInt(storeId),
            weekday: input.weekday,
            is_avail: 1n,
            start_timeslot: input.start,
            end_timeslot: input.end,
            pos_admin_id: BigInt(user.id),
            created_at: timestamp,
            updated_at: timestamp,
          });
          const id = generatedId(inserted);
          if (!id)
            throw new AppError(
              500,
              'DELIVERY_SLOT_CREATE_FAILED',
              'Could not create delivery timings.',
            );
          return { id: String(id), status: 'success', message: 'Store has been created!' };
        }),
      );
    },
    async paymentTerminals(user: Principal, storeId: string) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      const database = db.get('primary');
      const [pineLabs, paytm] = await Promise.all([
        database
          .select({
            id: PosMachine.id,
            counterId: PosMachine.counter_id,
            name: PosMachine.machine_name,
            merchantName: PosMachine.merchant_name,
            storeName: PosMachine.store_name,
            terminalId: PosMachine.tid,
            active: PosMachine.is_active,
          })
          .from(PosMachine)
          .where(eq(PosMachine.store_id, Number(storeId)))
          .orderBy(asc(PosMachine.id)),
        database
          .select({
            id: PosPaytmMachine.id,
            counterId: PosPaytmMachine.counter_id,
            name: PosPaytmMachine.machine_name,
            merchantName: PosPaytmMachine.merchant_name,
            storeName: PosPaytmMachine.store_name,
            terminalId: PosPaytmMachine.paytm_tid,
            active: PosPaytmMachine.is_active,
          })
          .from(PosPaytmMachine)
          .where(eq(PosPaytmMachine.store_id, Number(storeId)))
          .orderBy(asc(PosPaytmMachine.id)),
      ]);
      return [
        ...pineLabs.map((row) => ({ ...row, provider: 'pine-labs' })),
        ...paytm.map((row) => ({ ...row, provider: 'paytm' })),
      ];
    },
  };
}
