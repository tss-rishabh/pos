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
/**
 * `GetLocationByPincodeView` as the legacy store form uses it (`create.html:186-216`): fills
 * city, state, country, coordinates and the hidden ids; no data leaves the form unchanged.
 */
export async function postalCodeFields(
  operatorId: string,
  postalCode: string,
  signal: AbortSignal,
): Promise<Record<string, string> | null> {
  const result = await request(
    '/api/v1/locations/postal-code-lookups',
    { method: 'POST', operatorId, signal, cache: 'no-store', body: JSON.stringify({ postalCode }) },
    location,
  );
  if (!result.data) return null;
  return {
    city_name: result.data.city,
    state_name: result.data.state,
    country_name: result.data.country,
    country_id: result.data.countryId,
    latitude: result.data.latitude,
    longitude: result.data.longitude,
    state_id: result.data.stateId,
  };
}
