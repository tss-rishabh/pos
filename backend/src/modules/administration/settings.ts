import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosHyperlocalSlot, Store, TssSetting } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { requireRole, requireStore, type Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { currentRequestTrace } from '../../observability/context.js';
import { assertCurrentOperatorRole, assertCurrentStoreAccess } from './authorization.js';
import type { AdministrationTransaction } from './checkins.js';
import { lockAdministrationRegistry } from './locks.js';
import { utcMediaTimestamp } from './media-domain.js';
import {
  bufferSeconds,
  deliverySlotVersion,
  settingVersion,
  type allDeliveryAvailabilityInput,
  type deliveryAvailabilityInput,
  type deliverySlotUpdateInput,
  type ecommerceInput,
  type orderBufferInput,
  type thresholdInput,
  type SettingKey,
  type SettingsEffect,
  type SettingsEffectKind,
  type SettingsEffectPayload,
  type SettingsMutationResult,
  type SettingsOptions,
} from './settings-domain.js';
import { ecommerceChanges, settingsEffects, settingsMutations } from './settings-schema.js';

const conflict = () =>
  new AppError(409, 'SETTINGS_CONFLICT', 'Settings changed. Refresh before saving.');
const slotRange = (start: string, end: string) => `${start.slice(0, 5)} - ${end.slice(0, 5)}`;
type Slot = typeof PosHyperlocalSlot.$inferSelect;
export function settingsService(config: Config, db: Databases, options: SettingsOptions = {}) {
  const localNow = () =>
    Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  const cooldown = options.ecommerceCooldownSeconds ?? 180;
  if (!Number.isSafeInteger(cooldown) || cooldown < 1 || cooldown > 3600)
    throw new AppError(503, 'ECOMMERCE_CONFIGURATION_INVALID', 'Choose a valid settings cooldown.');
  const requireEffects = (...kinds: SettingsEffectKind[]) => {
    if (kinds.some((kind) => !options.settingsDelivery?.supports(kind)))
      return unavailable('Delivery settings effects');
  };
  async function stores(transaction: AdministrationTransaction, user: Principal, ids: string[]) {
    for (const id of [...new Set(ids)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))) {
      await assertCurrentStoreAccess(transaction, user.id, id, [1, 2, 3]);
      const [store] = await transaction
        .select({ id: Store.id })
        .from(Store)
        .where(
          and(
            eq(Store.id, BigInt(id)),
            eq(Store.is_active, true),
            inArray(Store.type, ['STORE', 'CORE_WAREHOUSE']),
          ),
        )
        .limit(1)
        .for('update');
      if (!store)
        throw new AppError(404, 'STORE_NOT_FOUND', 'An active sales store was not found.');
    }
  }
  async function run(
    user: Principal,
    operationId: string,
    context: unknown,
    authorize: (transaction: AdministrationTransaction) => Promise<void>,
    mutate: (transaction: AdministrationTransaction) => Promise<SettingsMutationResult>,
  ) {
    requireRole(user, [1, 2, 3]);
    const hash = settingVersion(context);
    return retryTransaction(() =>
      db.get('writer').transaction(async (transaction) => {
        await lockAdministrationRegistry(transaction, 'settings');
        await authorize(transaction);
        const [previous] = await transaction
          .select()
          .from(settingsMutations)
          .where(eq(settingsMutations.id, operationId))
          .limit(1);
        if (previous) {
          if (previous.actorId !== user.id || previous.hash !== hash)
            throw new AppError(
              409,
              'SETTINGS_OPERATION_REUSED',
              'Choose a new settings operation.',
            );
          return previous.result;
        }
        const result = await mutate(transaction);
        await transaction.insert(settingsMutations).values({
          id: operationId,
          actorId: user.id,
          hash,
          result,
          createdAt: utcMediaTimestamp(),
        });
        return result;
      }),
    );
  }
  async function enqueue(
    transaction: AdministrationTransaction,
    user: Principal,
    partitionKey: string,
    payload: SettingsEffectPayload,
  ) {
    const effect = {
      ...payload,
      actorId: user.id,
      requestId: currentRequestTrace()?.requestId || null,
      occurredAt: utcMediaTimestamp(),
    } as SettingsEffect;
    const id = randomUUID();
    await transaction.insert(settingsEffects).values({
      id,
      partitionKey,
      kind: effect.kind,
      payload: effect,
      attempts: 0,
      createdAt: effect.occurredAt,
    });
    return id;
  }
  async function currentSlot(transaction: AdministrationTransaction, storeId: string, id: string) {
    const [slot] = await transaction
      .select()
      .from(PosHyperlocalSlot)
      .where(
        and(eq(PosHyperlocalSlot.id, BigInt(id)), eq(PosHyperlocalSlot.store_id, BigInt(storeId))),
      )
      .limit(1)
      .for('update');
    if (!slot)
      throw new AppError(404, 'DELIVERY_SLOT_NOT_FOUND', 'Delivery timings were not found.');
    return slot;
  }
  async function availability(
    transaction: AdministrationTransaction,
    user: Principal,
    storeId: string,
    slots: Slot[],
    active: boolean,
    all: boolean,
  ): Promise<SettingsMutationResult> {
    if (!slots.length)
      throw new AppError(404, 'DELIVERY_SLOT_NOT_FOUND', 'Delivery timings were not found.');
    await transaction
      .update(PosHyperlocalSlot)
      .set({ is_avail: active ? 1n : 0n })
      .where(
        inArray(
          PosHyperlocalSlot.id,
          slots.map((slot) => slot.id),
        ),
      );
    await enqueue(transaction, user, `store:${storeId}`, {
      kind: 'slot.availability.notice',
      storeId,
      weekday: all ? null : slots[0]!.weekday,
      active,
    });
    return { status: 'success', message: 'Updated', effectsQueued: true };
  }
  function settingsProjection(rows: (typeof TssSetting.$inferSelect)[], key: SettingKey) {
    const selected = rows.filter((row) => row.platform === key);
    return {
      name: key,
      value: selected[0]?.value || '0',
      version: settingVersion(selected.map((row) => [String(row.id), row.value])),
      configured: selected.length > 0,
      editable:
        selected.length > 0 &&
        !!options.settingsDelivery?.supports('setting.cache') &&
        (key !== 'ORDER_CREATION_BUFFER_TIME_IN_SEC' ||
          !!options.settingsDelivery?.supports('buffer.notice')),
    };
  }
  async function updateGeneral(
    user: Principal,
    key: SettingKey,
    input: z.infer<typeof thresholdInput> | z.infer<typeof orderBufferInput>,
  ) {
    requireRole(user, [1, 2, 3]);
    requireEffects(
      'setting.cache',
      ...(key === 'ORDER_CREATION_BUFFER_TIME_IN_SEC' ? ['buffer.notice' as const] : []),
    );
    const value = typeof input.value === 'number' ? input.value : bufferSeconds(input.value);
    return run(
      user,
      input.operationId,
      { key, input },
      async (transaction) => {
        await assertCurrentOperatorRole(transaction, user.id, [1, 2, 3]);
      },
      async (transaction) => {
        const rows = await transaction
          .select()
          .from(TssSetting)
          .where(eq(TssSetting.platform, key))
          .orderBy(asc(TssSetting.id))
          .limit(1001)
          .for('update');
        if (rows.length > 1000) return unavailable('Reconciled general settings');
        if (!rows.length)
          throw new AppError(404, 'SETTING_NOT_CONFIGURED', 'This setting is not configured.');
        if (settingsProjection(rows, key).version !== input.expectedVersion) throw conflict();
        await transaction
          .update(TssSetting)
          .set({ value: String(value) })
          .where(eq(TssSetting.platform, key));
        await enqueue(transaction, user, `setting:${key}`, { kind: 'setting.cache', key, value });
        if (key === 'ORDER_CREATION_BUFFER_TIME_IN_SEC')
          await enqueue(transaction, user, `setting:${key}`, {
            kind: 'buffer.notice',
            value: String(input.value),
          });
        return { status: 'success', message: 'Data Successfully Updated', effectsQueued: true };
      },
    );
  }
  return {
    async generalSettings(user: Principal) {
      requireRole(user, [1, 2, 3]);
      const rows = await db
        .get('primary')
        .select()
        .from(TssSetting)
        .where(
          inArray(TssSetting.platform, [
            'HYPERLOCAL_STOCK_THRESHOLD',
            'ORDER_CREATION_BUFFER_TIME_IN_SEC',
          ]),
        )
        .orderBy(asc(TssSetting.id))
        .limit(1001);
      if (rows.length > 1000) return unavailable('Reconciled general settings');
      return (['HYPERLOCAL_STOCK_THRESHOLD', 'ORDER_CREATION_BUFFER_TIME_IN_SEC'] as const).map(
        (key) => settingsProjection(rows, key),
      );
    },
    updateThreshold: (user: Principal, input: z.infer<typeof thresholdInput>) =>
      updateGeneral(user, 'HYPERLOCAL_STOCK_THRESHOLD', input),
    updateOrderBuffer: (user: Principal, input: z.infer<typeof orderBufferInput>) =>
      updateGeneral(user, 'ORDER_CREATION_BUFFER_TIME_IN_SEC', input),
    async deliverySlots(user: Principal, storeId: string) {
      requireRole(user, [1, 2, 3]);
      requireStore(user, storeId);
      const rows = await db
        .get('primary')
        .select()
        .from(PosHyperlocalSlot)
        .where(eq(PosHyperlocalSlot.store_id, BigInt(storeId)))
        .orderBy(asc(PosHyperlocalSlot.id))
        .limit(101);
      if (rows.length > 100) return unavailable('Reconciled delivery timings');
      return rows.map((slot) => ({
        id: String(slot.id),
        weekday: slot.weekday,
        available: slot.is_avail === 1n ? 1 : 0,
        start: slot.start_timeslot,
        end: slot.end_timeslot,
        version: deliverySlotVersion(slot),
        editable: !!options.settingsDelivery?.supports('slot.timing.notice'),
        availabilityEditable: !!options.settingsDelivery?.supports('slot.availability.notice'),
      }));
    },
    async updateDeliverySlot(
      user: Principal,
      storeId: string,
      slotId: string,
      input: z.infer<typeof deliverySlotUpdateInput>,
    ) {
      requireStore(user, storeId);
      requireEffects('slot.timing.notice');
      const destination = input.destinationStoreId || storeId;
      requireStore(user, destination);
      return run(
        user,
        input.operationId,
        { storeId, slotId, input },
        (transaction) => stores(transaction, user, [storeId, destination]),
        async (transaction) => {
          const slot = await currentSlot(transaction, storeId, slotId);
          if (deliverySlotVersion(slot) !== input.expectedVersion) throw conflict();
          const [duplicate] = await transaction
            .select({ id: PosHyperlocalSlot.id })
            .from(PosHyperlocalSlot)
            .where(
              and(
                eq(PosHyperlocalSlot.store_id, BigInt(destination)),
                eq(PosHyperlocalSlot.weekday, input.weekday),
                ne(PosHyperlocalSlot.id, BigInt(slotId)),
              ),
            )
            .limit(1);
          if (duplicate)
            throw new AppError(
              409,
              'DELIVERY_SLOT_EXISTS',
              'You cannot add multiple weekdays for the same store.',
            );
          await transaction
            .update(PosHyperlocalSlot)
            .set({
              store_id: BigInt(destination),
              weekday: input.weekday,
              start_timeslot: input.start,
              end_timeslot: input.end,
              updated_at: localNow(),
            })
            .where(eq(PosHyperlocalSlot.id, slot.id));
          await enqueue(transaction, user, `store:${destination}`, {
            kind: 'slot.timing.notice',
            storeId: destination,
            weekday: input.weekday,
            previous: slotRange(slot.start_timeslot, slot.end_timeslot),
            current: slotRange(input.start, input.end),
          });
          return {
            status: 'success',
            message: 'Delivery Time Slot has been updated!',
            effectsQueued: true,
          };
        },
      );
    },
    async setDeliveryAvailability(
      user: Principal,
      storeId: string,
      slotId: string,
      input: z.infer<typeof deliveryAvailabilityInput>,
    ) {
      requireStore(user, storeId);
      requireEffects('slot.availability.notice');
      return run(
        user,
        input.operationId,
        { storeId, slotId, input },
        (transaction) => stores(transaction, user, [storeId]),
        async (transaction) => {
          const slot = await currentSlot(transaction, storeId, slotId);
          if (deliverySlotVersion(slot) !== input.expectedVersion) throw conflict();
          return availability(transaction, user, storeId, [slot], input.active, false);
        },
      );
    },
    async setAllDeliveryAvailability(
      user: Principal,
      storeId: string,
      input: z.infer<typeof allDeliveryAvailabilityInput>,
    ) {
      requireStore(user, storeId);
      requireEffects('slot.availability.notice');
      return run(
        user,
        input.operationId,
        { storeId, input },
        (transaction) => stores(transaction, user, [storeId]),
        async (transaction) => {
          const slots = await transaction
            .select()
            .from(PosHyperlocalSlot)
            .where(eq(PosHyperlocalSlot.store_id, BigInt(storeId)))
            .orderBy(asc(PosHyperlocalSlot.id))
            .for('update');
          if (
            slots.length !== input.expectedSlots.length ||
            slots.some(
              (slot) =>
                !input.expectedSlots.some(
                  (expected) =>
                    expected.id === String(slot.id) &&
                    expected.version === deliverySlotVersion(slot),
                ),
            )
          )
            throw conflict();
          return availability(transaction, user, storeId, slots, input.active, true);
        },
      );
    },
    async ecommerceSettings(user: Principal, storeId: string) {
      requireRole(user, [1]);
      requireStore(user, storeId);
      await db
        .get('writer')
        .transaction((tx) => assertCurrentStoreAccess(tx, user.id, storeId, [1]));
      const [store] = await db
        .get('primary')
        .select({
          id: Store.id,
          name: Store.store_name,
          threshold: Store.ecom_threshold,
          active: Store.ecom_delivery,
        })
        .from(Store)
        .where(
          and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true), eq(Store.type, 'STORE')),
        )
        .limit(1);
      if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'An active store was not found.');
      const [change] = await db
        .get('primary')
        .select()
        .from(ecommerceChanges)
        .where(eq(ecommerceChanges.storeId, store.id))
        .limit(1);
      return {
        ...store,
        id: String(store.id),
        active: store.active === 1,
        version: settingVersion([store.threshold, store.active]),
        lockedUntil: change?.lockedUntil
          ? Temporal.PlainDateTime.from(change.lockedUntil.replace(' ', 'T'))
              .toZonedDateTime('UTC')
              .toInstant()
              .toString()
          : null,
        editable:
          !!options.ecommerceSyncVerified &&
          [
            'ecommerce.threshold.notice',
            'ecommerce.availability.notice',
            'ecommerce.inventory.sync',
          ].every((kind) => options.settingsDelivery?.supports(kind as SettingsEffectKind)),
      };
    },
    async updateEcommerce(user: Principal, storeId: string, input: z.infer<typeof ecommerceInput>) {
      requireRole(user, [1]);
      if (!options.ecommerceSyncVerified)
        return unavailable('Verified e-commerce inventory synchronization');
      requireEffects(
        'ecommerce.threshold.notice',
        'ecommerce.availability.notice',
        'ecommerce.inventory.sync',
      );
      return run(
        user,
        input.operationId,
        { storeId, input },
        async (transaction) => {
          await assertCurrentStoreAccess(transaction, user.id, storeId, [1]);
        },
        async (transaction) => {
          const [store] = await transaction
            .select()
            .from(Store)
            .where(
              and(
                eq(Store.id, BigInt(storeId)),
                eq(Store.is_active, true),
                eq(Store.type, 'STORE'),
              ),
            )
            .limit(1)
            .for('update');
          if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'An active store was not found.');
          if (settingVersion([store.ecom_threshold, store.ecom_delivery]) !== input.expectedVersion)
            throw conflict();
          const now = utcMediaTimestamp();
          const [change] = await transaction
            .select()
            .from(ecommerceChanges)
            .where(eq(ecommerceChanges.storeId, store.id))
            .limit(1)
            .for('update');
          if (change && change.lockedUntil > now)
            throw new AppError(
              409,
              'ECOMMERCE_CHANGE_COOLDOWN',
              'You cannot perform the action at this time, Please try again after sometime',
            );
          const thresholdChanged = store.ecom_threshold !== input.threshold;
          const availabilityChanged = store.ecom_delivery !== (input.active ? 1 : 0);
          if (!thresholdChanged && !availabilityChanged)
            return {
              status: 'success',
              message: 'No changes detected',
              effectsQueued: false,
              storeId,
              operationId: input.operationId,
              actorId: user.id,
            };
          await transaction
            .update(Store)
            .set({ ecom_threshold: input.threshold, ecom_delivery: input.active ? 1 : 0 })
            .where(eq(Store.id, store.id));
          const lockedUntil = utcMediaTimestamp(Temporal.Now.instant().add({ seconds: cooldown }));
          await transaction
            .insert(ecommerceChanges)
            .values({ storeId: store.id, lockedUntil })
            .onDuplicateKeyUpdate({ set: { lockedUntil } });
          if (thresholdChanged)
            await enqueue(transaction, user, `store:${storeId}`, {
              kind: 'ecommerce.threshold.notice',
              storeId,
              previous: store.ecom_threshold,
              current: input.threshold,
            });
          if (availabilityChanged)
            await enqueue(transaction, user, `store:${storeId}`, {
              kind: 'ecommerce.availability.notice',
              storeId,
              active: input.active,
            });
          const ecommerceSyncId = await enqueue(transaction, user, `store:${storeId}`, {
            kind: 'ecommerce.inventory.sync',
            storeId,
          });
          return {
            status: 'success',
            message: 'Ecom Setting Updated! Please wait, It will take time to reflect',
            effectsQueued: true,
            storeId,
            ecommerceSyncId,
            operationId: input.operationId,
            actorId: user.id,
          };
        },
      );
    },
  };
}
