import { z } from 'zod';
import { administrationIdentifier } from './api';

const version = z.string().regex(/^[a-f0-9]{64}$/);
export const generalSettingSchema = z.object({
  name: z.enum(['HYPERLOCAL_STOCK_THRESHOLD', 'ORDER_CREATION_BUFFER_TIME_IN_SEC']),
  value: z.string(),
  version,
  configured: z.boolean(),
  editable: z.boolean(),
});
export type GeneralSetting = z.infer<typeof generalSettingSchema>;
export const deliverySlotSchema = z.object({
  id: administrationIdentifier,
  weekday: z.string(),
  available: z.union([z.literal(0), z.literal(1)]),
  start: z.string(),
  end: z.string(),
  version,
  editable: z.boolean(),
  availabilityEditable: z.boolean(),
});
export type DeliverySlot = z.infer<typeof deliverySlotSchema>;
export const ecommerceSettingSchema = z.object({
  id: administrationIdentifier,
  name: z.string(),
  threshold: z.number().int(),
  active: z.boolean(),
  version,
  lockedUntil: z.iso.datetime().nullable(),
  editable: z.boolean(),
});
export type EcommerceSetting = z.infer<typeof ecommerceSettingSchema>;
export const bufferDuration = (seconds: string): string => {
  const value = Number(seconds);
  return Number.isSafeInteger(value) && value >= 0
    ? `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor((value % 3600) / 60)).padStart(2, '0')}`
    : '';
};
