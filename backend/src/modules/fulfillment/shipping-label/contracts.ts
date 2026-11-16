import { z } from 'zod';
import { identifier } from '../../../domain/validation.js';

export const shippingAddressSchema = z
  .object({
    name: z.string().max(512),
    addressLine: z.string().max(4096),
    cityLine: z.string().max(1024),
    phone: z.string().max(255),
  })
  .strict();
export const shippingLabelSchema = z
  .object({
    orderId: identifier,
    storeId: identifier,
    orderReference: z.string().max(255),
    orderDate: z.string().max(32).nullable(),
    storeAddress: z.string().max(4096),
    shippingAddress: shippingAddressSchema.nullable(),
    paymentMode: z.literal('Prepaid'),
    product: z.literal('Cloths'),
    totalQuantity: z.string().regex(/^-?\d{1,25}$/),
    awb: z.string().min(1).max(255),
    dimensionsCm: z.tuple([z.literal('30.000'), z.literal('30.000'), z.literal('2.000')]),
    weightKg: z.literal('0.384'),
  })
  .strict();
export type ShippingLabel = z.infer<typeof shippingLabelSchema>;
export interface ShippingAddressParts {
  firstName: string | null;
  lastName: string | null;
  flat: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  city: string | null;
  postcode: string | null;
  phone: string | null;
  zoneName: string | null;
  countryName: string | null;
}
/** Mirrors ShowOnlineOrderShippingView._get_shipping_address, including whitespace. */
export function sourceShippingAddress(
  value: ShippingAddressParts,
): ShippingLabel['shippingAddress'] {
  const address1 =
    value.flat && value.address1
      ? `${value.flat}, ${value.address1}`
      : value.flat || value.address1 || '';
  const address3 =
    value.address3 && value.address4
      ? `${value.address3}, ${value.address4}`
      : value.address3 || value.address4 || '';
  const cityPin =
    value.city && value.postcode
      ? `${value.city} - ${value.postcode}`
      : value.city || value.postcode || '';
  return shippingAddressSchema.parse({
    name: `${value.firstName || ''} ${value.lastName || ''}`.replace(
      /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,
      '',
    ),
    addressLine: [address1, value.address2 || '', address3].filter(Boolean).join(', '),
    cityLine: [cityPin, value.zoneName || '', value.countryName || ''].filter(Boolean).join(', '),
    phone: value.phone || '',
  });
}
export function sourceShippingStoreAddress(value: {
  address: string | null;
  alternateAddress: string | null;
  phone: string | null;
}) {
  const pythonText = (text: string | null) => (text === null ? 'None' : text);
  return `${pythonText(value.address)}  ${pythonText(value.alternateAddress)}  ${pythonText(value.phone)}`;
}
