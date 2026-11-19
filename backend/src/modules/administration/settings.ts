import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosHyperlocalSlot, Store, TssSetting } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { requireRole, requireStore, type Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import type { JobLogger } from '../../jobs/runtime.js';
import { currentRequestTrace } from '../../observability/context.js';
import { assertCurrentOperatorRole, assertCurrentStoreAccess } from './authorization.js';
import type { AdministrationTransaction } from './checkins.js';
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
  type SettingsEffectPayload,
  type SettingsMutationResult,
  type SettingsOptions,
} from './settings-domain.js';

/** Ledger: `pos:idem:settings:{operationId}` -> {actorId, hash, state, result}, EX 86400. */
export const settingsOperationKey = (operationId: string) => `pos:idem:settings:${operationId}`;
/** Legacy cooldown key (`core/views.py:2108-2112`), on the POS Redis (`redis_instance`). */
export const ecommerceCooldownKey = (storeId: string) => `ecom_delivery_${storeId}`;
const operationTtlSeconds = 86_400;
interface StoredOperation {
  actorId: string;
  hash: string;
  state: 'pending' | 'done';
  result?: SettingsMutationResult;
}
/** Changes committed by a settings transaction and the effects legacy runs inline after them. */
interface Mutation {
  result: SettingsMutationResult;
  effects: SettingsEffectPayload[];
  after?: () => Promise<void>;
}

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
  if (!Number.isSafeInteger(cooldown) || cooldown < 1 || cooldown > 2_592_000)
    throw new AppError(503, 'ECOMMERCE_CONFIGURATION_INVALID', 'Choose a valid settings cooldown.');
  const log: JobLogger = options.log ?? (() => {});
  const ephemeral = (): EphemeralStore =>
    options.moduleRuntime?.ephemeral ?? unavailable('Settings operation state');
  /** Legacy runs these inline after the update; a failure is logged, never raised. */
  async function deliverEffects(user: Principal, effects: SettingsEffectPayload[]) {
    const requestId = currentRequestTrace()?.requestId ?? null;
    for (const payload of effects) {
      const effect = {
        ...payload,
        actorId: user.id,
        requestId,
        occurredAt: utcMediaTimestamp(),
      } as SettingsEffect;
      const event = {
        module: 'administration',
        resource: 'settings-effect',
        kind: effect.kind,
        requestId,
        userId: user.id,
      };
      try {
        if (!options.settingsDelivery?.supports(effect.kind))
          throw new AppError(503, 'SETTINGS_EFFECT_UNCONFIGURED', 'Settings effect unavailable.');
        await options.settingsDelivery.deliver(effect);
      } catch (error) {
        log(
          'warn',
          {
            ...event,
            eventId: 'administration.settings-effect.failed',
            errorCode: error instanceof AppError ? error.code : 'SETTINGS_EFFECT_FAILED',
          },
          'Settings effect was not delivered',
        );
      }
    }
  }
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
    mutate: (transaction: AdministrationTransaction) => Promise<Mutation>,
  ) {
    requireRole(user, [1, 2, 3]);
    const hash = settingVersion(context),
      store = ephemeral(),
      key = settingsOperationKey(operationId);
    const reserved = await store.set(
      key,
      JSON.stringify({ actorId: user.id, hash, state: 'pending' } satisfies StoredOperation),
      { NX: true, EX: operationTtlSeconds },
    );
    if (!reserved) {
      const raw = await store.get(key),
        previous = raw === null ? null : (JSON.parse(raw) as StoredOperation);
      if (!previous || previous.actorId !== user.id || previous.hash !== hash)
        throw new AppError(409, 'SETTINGS_OPERATION_REUSED', 'Choose a new settings operation.');
      if (previous.state !== 'done' || !previous.result)
        throw new AppError(
          409,
          'SETTINGS_OPERATION_IN_PROGRESS',
          'This settings change is still being saved.',
        );
      return previous.result;
    }
    let mutation: Mutation;
    try {
      mutation = await retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await authorize(transaction);
          return mutate(transaction);
        }),
      );
    } catch (error) {
      await store.del(key);
      throw error;
    }
    await store.set(
      key,
      JSON.stringify({
        actorId: user.id,
        hash,
        state: 'done',
        result: mutation.result,
      } satisfies StoredOperation),
      { EX: operationTtlSeconds },
    );
    await deliverEffects(user, mutation.effects);
    await mutation.after?.();
    return mutation.result;
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
  ): Promise<Mutation> {
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
    return {
      result: { status: 'success', message: 'Updated' },
      effects: [
        {
          kind: 'slot.availability.notice',
          storeId,
          weekday: all ? null : slots[0]!.weekday,
          active,
        },
      ],
    };
  }
  function settingsProjection(rows: (typeof TssSetting.$inferSelect)[], key: SettingKey) {
    const selected = rows.filter((row) => row.platform === key);
    return {
      name: key,
      value: selected[0]?.value || '0',
      version: settingVersion(selected.map((row) => [String(row.id), row.value])),
      configured: selected.length > 0,
      editable: selected.length > 0,
    };
  }
  async function updateGeneral(
    user: Principal,
    key: SettingKey,
    input: z.infer<typeof thresholdInput> | z.infer<typeof orderBufferInput>,
  ) {
    requireRole(user, [1, 2, 3]);
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
        const effects: SettingsEffectPayload[] = [{ kind: 'setting.cache', key, value }];
        if (key === 'ORDER_CREATION_BUFFER_TIME_IN_SEC')
          effects.push({ kind: 'buffer.notice', value: String(input.value) });
        return { result: { status: 'success', message: 'Data Successfully Updated' }, effects };
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
        editable: true,
        availabilityEditable: true,
      }));
    },
    async updateDeliverySlot(
      user: Principal,
      storeId: string,
      slotId: string,
      input: z.infer<typeof deliverySlotUpdateInput>,
    ) {
      requireStore(user, storeId);
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
          return {
            result: { status: 'success', message: 'Delivery Time Slot has been updated!' },
            effects: [
              {
                kind: 'slot.timing.notice',
                storeId: destination,
                weekday: input.weekday,
                previous: slotRange(slot.start_timeslot, slot.end_timeslot),
                current: slotRange(input.start, input.end),
              },
            ],
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
      const remaining = options.moduleRuntime
        ? await options.moduleRuntime.ephemeral.ttl(ecommerceCooldownKey(storeId))
        : -2;
      return {
        ...store,
        id: String(store.id),
        active: store.active === 1,
        version: settingVersion([store.threshold, store.active]),
        lockedUntil:
          remaining > 0 ? Temporal.Now.instant().add({ seconds: remaining }).toString() : null,
        editable: !!options.moduleRuntime,
      };
    },
    /** `AjaxEcomSettingUpdate.post` (`core/views.py:2094-2167`). */
    async updateEcommerce(user: Principal, storeId: string, input: z.infer<typeof ecommerceInput>) {
      requireRole(user, [1]);
      const runtime = options.moduleRuntime ?? unavailable('Job queue');
      const cooldownKey = ecommerceCooldownKey(storeId);
      let claimed = false;
      try {
        return await run(
          user,
          input.operationId,
          { storeId, input },
          async (transaction) => {
            await assertCurrentStoreAccess(transaction, user.id, storeId, [1]);
            // Source refuses while `ecom_delivery_{store}` exists, else sets it for
            // ECOM_DELIVERY_CHANGES_TIME; SET NX closes its EXISTS-then-SET race.
            if (!claimed) {
              claimed = await runtime.ephemeral.set(cooldownKey, '1', { NX: true, EX: cooldown });
              if (!claimed)
                throw new AppError(
                  409,
                  'ECOMMERCE_CHANGE_COOLDOWN',
                  'You cannot perform the action at this time, Please try again after sometime',
                );
            }
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
            if (!store)
              throw new AppError(404, 'STORE_NOT_FOUND', 'An active store was not found.');
            if (
              settingVersion([store.ecom_threshold, store.ecom_delivery]) !== input.expectedVersion
            )
              throw conflict();
            const thresholdChanged = store.ecom_threshold !== input.threshold;
            const availabilityChanged = store.ecom_delivery !== (input.active ? 1 : 0);
            const base = { storeId, operationId: input.operationId, actorId: user.id };
            if (!thresholdChanged && !availabilityChanged)
              return {
                result: { status: 'success', message: 'No changes detected', ...base },
                effects: [],
                // Source deletes the cooldown key when nothing changed (`core/views.py:2132`).
                after: async () => {
                  await runtime.ephemeral.del(cooldownKey);
                },
              };
            await transaction
              .update(Store)
              .set({ ecom_threshold: input.threshold, ecom_delivery: input.active ? 1 : 0 })
              .where(eq(Store.id, store.id));
            const effects: SettingsEffectPayload[] = [];
            if (thresholdChanged)
              effects.push({
                kind: 'ecommerce.threshold.notice',
                storeId,
                previous: store.ecom_threshold,
                current: input.threshold,
              });
            if (availabilityChanged)
              effects.push({
                kind: 'ecommerce.availability.notice',
                storeId,
                active: input.active,
              });
            return {
              result: {
                status: 'success',
                message: 'Ecom Setting Updated! Please wait, It will take time to reflect',
                ...base,
              },
              effects,
              // Source `run_sync`: `tasks.sync_ecom_inventory.delay(store_id)` (`core/views.py:2166-2167`).
              after: async () => {
                try {
                  await runtime.jobs.enqueue(
                    'core.tasks.sync_ecom_inventory',
                    { store_id: storeId },
                    { queue: 'core' },
                  );
                } catch (error) {
                  log(
                    'error',
                    {
                      module: 'administration',
                      resource: 'ecommerce-inventory-sync',
                      eventId: 'administration.ecommerce-inventory-sync.enqueue-failed',
                      requestId: currentRequestTrace()?.requestId ?? null,
                      userId: user.id,
                      storeId,
                      errorCode: error instanceof AppError ? error.code : 'JOB_QUEUE_UNAVAILABLE',
                    },
                    'Ecommerce inventory sync was not queued',
                  );
                }
              },
            };
          },
        );
      } catch (error) {
        // Rewrite-only refusals (conflict, missing store) must not hold the legacy cooldown.
        if (claimed) await runtime.ephemeral.del(cooldownKey);
        throw error;
      }
    },
  };
}
