import { createHash } from 'node:crypto';
import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
import { deliverySlotInput } from './contracts.js';

export const settingKey = z.enum([
  'HYPERLOCAL_STOCK_THRESHOLD',
  'ORDER_CREATION_BUFFER_TIME_IN_SEC',
]);
export type SettingKey = z.infer<typeof settingKey>;
const version = z.string().regex(/^[a-f0-9]{64}$/);
const mutation = z.object({ operationId: z.uuid(), expectedVersion: version }).strict();
const stock = z.number().int().min(0).max(2_147_483_647);
export const deliverySlotUpdateInput = deliverySlotInput.extend({
  ...mutation.shape,
  destinationStoreId: identifier.optional(),
});
export const deliveryAvailabilityInput = mutation.extend({ active: z.boolean() });
export const allDeliveryAvailabilityInput = z
  .object({
    operationId: z.uuid(),
    active: z.boolean(),
    expectedSlots: z
      .array(z.object({ id: identifier, version }).strict())
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.expectedSlots.map((slot) => slot.id)).size === input.expectedSlots.length,
    'Choose each timing once.',
  );
export const thresholdInput = mutation.extend({ value: stock });
export const orderBufferInput = mutation.extend({
  value: z
    .string()
    .regex(/^\d{1,3}:[0-5]\d$/)
    .refine((value) => bufferSeconds(value) > 0, 'Choose a positive duration.'),
});
export const ecommerceInput = mutation.extend({ threshold: stock, active: z.boolean() });

/** Source accepts an hours:minutes duration, not a wall-clock time. */
export function bufferSeconds(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours || 0) * 3600 + (minutes || 0) * 60;
}
export function settingVersion(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function deliverySlotVersion(slot: {
  id: bigint | string;
  store_id: bigint | string;
  weekday: string;
  start_timeslot: string;
  end_timeslot: string;
  is_avail: number | bigint;
}): string {
  return settingVersion([
    String(slot.id),
    String(slot.store_id),
    slot.weekday,
    slot.start_timeslot,
    slot.end_timeslot,
    String(slot.is_avail),
  ]);
}
export interface SettingsMutationResult {
  status: 'success';
  message: string;
  effectsQueued: boolean;
}
interface EffectContext {
  actorId: string;
  requestId: string | null;
  occurredAt: string;
}
export type SettingsEffect = EffectContext &
  (
    | { kind: 'setting.cache'; key: SettingKey; value: number }
    | { kind: 'buffer.notice'; value: string }
    | {
        kind: 'slot.timing.notice';
        storeId: string;
        weekday: string;
        previous: string;
        current: string;
      }
    | {
        kind: 'slot.availability.notice';
        storeId: string;
        weekday: string | null;
        active: boolean;
      }
    | {
        kind: 'ecommerce.threshold.notice';
        storeId: string;
        previous: number;
        current: number;
      }
    | { kind: 'ecommerce.availability.notice'; storeId: string; active: boolean }
    | { kind: 'ecommerce.inventory.sync'; storeId: string }
  );
export type SettingsEffectKind = SettingsEffect['kind'];
const effectContext = {
  actorId: identifier,
  requestId: z.string().min(1).max(128).nullable(),
  occurredAt: z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/),
};
export const settingsEffectSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...effectContext, kind: z.literal('setting.cache'), key: settingKey, value: stock })
    .strict(),
  z
    .object({
      ...effectContext,
      kind: z.literal('buffer.notice'),
      value: z.string().regex(/^\d{1,3}:[0-5]\d$/),
    })
    .strict(),
  z
    .object({
      ...effectContext,
      kind: z.literal('slot.timing.notice'),
      storeId: identifier,
      weekday: z.string().min(1).max(255),
      previous: z.string().max(32),
      current: z.string().max(32),
    })
    .strict(),
  z
    .object({
      ...effectContext,
      kind: z.literal('slot.availability.notice'),
      storeId: identifier,
      weekday: z.string().min(1).max(255).nullable(),
      active: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...effectContext,
      kind: z.literal('ecommerce.threshold.notice'),
      storeId: identifier,
      previous: z.number().int(),
      current: stock,
    })
    .strict(),
  z
    .object({
      ...effectContext,
      kind: z.literal('ecommerce.availability.notice'),
      storeId: identifier,
      active: z.boolean(),
    })
    .strict(),
  z
    .object({ ...effectContext, kind: z.literal('ecommerce.inventory.sync'), storeId: identifier })
    .strict(),
]);
export type SettingsEffectPayload = SettingsEffect extends infer Effect
  ? Effect extends SettingsEffect
    ? Omit<Effect, 'actorId' | 'requestId' | 'occurredAt'>
    : never
  : never;
export interface SettingsEffectDelivery {
  supports(kind: SettingsEffectKind): boolean;
  deliver(id: string, effect: SettingsEffect, signal?: AbortSignal): Promise<void>;
  close?(): Promise<void>;
}
export interface SettingsOptions {
  settingsDelivery?: SettingsEffectDelivery;
  ecommerceSyncVerified?: boolean;
  ecommerceCooldownSeconds?: number;
}
