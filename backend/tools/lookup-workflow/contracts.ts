import { z } from 'zod';

export const countryReply = z
  .object({
    status: z.literal('success'),
    message: z.literal('Country name'),
    data: z
      .object({
        country: z.array(z.object({ id: z.string(), text: z.string() }).strict()).optional(),
      })
      .strict(),
  })
  .strict();
const sourcePostalLocation = z
  .object({
    pincode: z.string(),
    city: z.string(),
    state: z.string(),
    country: z.string(),
    country_id: z.number(),
    state_id: z.number(),
    latitude: z.string(),
    longitude: z.string(),
  })
  .strict();
export const sourcePostalReply = z
  .object({
    status: z.literal('success'),
    message: z.literal('location fetched'),
    data: z.union([sourcePostalLocation, z.object({}).strict()]),
  })
  .strict();
export const candidatePostalReply = z
  .object({
    status: z.literal('success'),
    message: z.literal('location fetched'),
    data: z
      .object({
        postalCode: z.string(),
        city: z.string(),
        state: z.string(),
        country: z.string(),
        countryId: z.string(),
        stateId: z.string(),
        latitude: z.string(),
        longitude: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();
/** Only the documented wire-name/empty-result mapping; never candidate lookup logic. */
export function mappedPostal(source: z.infer<typeof sourcePostalReply>) {
  const row = source.data;
  return {
    status: source.status,
    message: source.message,
    data:
      'pincode' in row
        ? {
            postalCode: row.pincode,
            city: row.city,
            state: row.state,
            country: row.country,
            countryId: String(row.country_id),
            stateId: String(row.state_id),
            latitude: row.latitude,
            longitude: row.longitude,
          }
        : null,
  };
}
export const oracleResult = z.object({
  countries: z.array(countryReply),
  postals: z.array(sourcePostalReply),
  anonymous: z.array(z.number()),
  sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  nativeSelects: z.number().int(),
  nativeWrites: z.literal(0),
  pythonVersion: z.string(),
  djangoVersion: z.literal('4.2.5'),
});
export const fixturePrincipal = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  userType: z.union([z.literal(1), z.literal(2)]),
  storeIds: z.array(z.string()),
});
export const readyMessage = z.object({
  kind: z.literal('ready'),
  apiOrigin: z.url(),
  accounts: z.array(z.object({ user: fixturePrincipal, cookie: z.string() })),
  searches: z.array(z.string().nullable()),
  postals: z.array(z.string().nullable()),
  source: oracleResult,
  nativeLookupRows: z.number().int(),
  mysqlVersion: z.string(),
});
export const initializeMessage = z
  .object({
    kind: z.literal('initialize'),
    database: z.url(),
    webOrigin: z.url(),
    sourceRoot: z.string().min(1),
    python: z.string().min(1),
  })
  .strict();
export const commandMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('close') }).strict(),
  z.object({ kind: z.literal('disable'), operatorId: z.string().regex(/^9000\d{2}$/) }).strict(),
  z.object({ kind: z.literal('fingerprint') }).strict(),
]);
