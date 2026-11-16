import { z } from 'zod';
import { request } from '../../api/client';

const identifier = z
  .string()
  .regex(/^\d+$/)
  .refine((value) => BigInt(value) <= 2147483647n);
const location = z.object({
  status: z.literal('success'),
  message: z.string(),
  data: z
    .object({
      postalCode: z.string(),
      city: z.string(),
      state: z.string(),
      country: z.string(),
      countryId: identifier,
      stateId: identifier,
      latitude: z.string(),
      longitude: z.string(),
    })
    .nullable(),
});
/** The lookup fills only source-provided fields. Existing city/address references are preserved. */
export async function postalCodeFields(
  operatorId: string,
  postalCode: string,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9 -]{0,30}[A-Za-z0-9])?$/.test(postalCode.trim()))
    throw new Error('Enter a valid postal code.');
  const result = await request(
    '/api/v1/locations/postal-code-lookups',
    { method: 'POST', operatorId, signal, cache: 'no-store', body: JSON.stringify({ postalCode }) },
    location,
  );
  if (!result.data) throw new Error('No location was found for this PIN code.');
  return {
    pincode: result.data.postalCode,
    city: result.data.city,
    state: result.data.state,
    countryId: result.data.countryId,
    stateId: result.data.stateId,
    latitude: result.data.latitude,
    longitude: result.data.longitude,
  };
}
