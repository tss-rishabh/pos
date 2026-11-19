import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { ApiError, NetworkError, captureOperatorScope, params, request } from '../../api/client';

export const administrationIdentifier = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine((value) => /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n);
const id = administrationIdentifier;
const text = z
  .string()
  .nullable()
  .transform((value) => value || '');
export const storeSchema = z
  .object({
    id,
    store_name: text,
    location_code: z.string(),
    type: z.string(),
    category: z.string(),
    latitude: text,
    longitude: text,
    email: text,
    address: text,
    alt_address: text,
    city_id: z.number(),
    country_id: z.number(),
    phone: text,
    pincode: text,
    per_day_threshold: z.number().nullable(),
    per_hour_threshold: z.number().nullable(),
    gstin: text,
    short_name: text,
    slack_group_url: text,
    city_name: text,
    state_name: text,
    state_id: z.number().nullable(),
    created_at: text.optional(),
    country_name: z.string().nullable().optional(),
    is_active: z.boolean(),
    store_image: text,
    franchise: z
      .object({ id: id.optional(), name: text, description: text, cin: text })
      .nullable()
      .optional(),
  })
  .transform((value) => ({
    id: value.id,
    name: value.store_name,
    locationCode: value.location_code,
    type: value.type,
    category: value.category,
    latitude: value.latitude,
    longitude: value.longitude,
    email: value.email,
    address: value.address,
    alternateAddress: value.alt_address,
    cityId: value.city_id,
    countryId: value.country_id,
    phone: value.phone,
    pincode: value.pincode,
    dailyThreshold: value.per_day_threshold,
    hourlyThreshold: value.per_hour_threshold,
    gstin: value.gstin,
    shortName: value.short_name,
    slackGroupUrl: value.slack_group_url,
    createdAt: value.created_at ?? '',
    countryName: value.country_name ?? '',
    city: value.city_name,
    state: value.state_name,
    stateId: value.state_id,
    active: value.is_active,
    imagePath: value.store_image,
    franchise: value.franchise,
  }));
export type AdministrationStore = z.infer<typeof storeSchema>;
export const salespersonSchema = z
  .object({
    id,
    employee_id: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    email: z.string(),
    phone: z.string(),
    is_active: z.number(),
    user_type: z.number(),
    storeIds: z.array(id),
    storeNames: z.array(z.string()).default([]),
    activeStoreId: id.nullable(),
  })
  .transform((value) => ({
    id: value.id,
    employeeId: value.employee_id,
    firstName: value.first_name,
    lastName: value.last_name,
    email: value.email,
    phone: value.phone,
    active: value.is_active === 1,
    userType: value.user_type,
    storeIds: value.storeIds,
    storeNames: value.storeNames,
    activeStoreId: value.activeStoreId,
  }));
export type AdministrationSalesperson = z.infer<typeof salespersonSchema>;
export const operatorSchema = z.object({
  id,
  username: z.string().optional(),
  firstName: z.string(),
  lastName: z.string(),
  email: text,
  phone: text,
  contactEmail: text,
  role: z.number(),
  userType: z.number(),
  otpMethod: z.number(),
  mfa: z.boolean().nullable(),
  active: z.boolean(),
  storeIds: z.array(id),
  storeNames: z.array(z.string()).default([]),
});
export type AdministrationOperator = z.infer<typeof operatorSchema>;
export const counterSchema = z
  .object({
    id,
    store: id,
    counter_name: text,
    counter_type: z.string(),
    counter_desc: text,
    is_active: z.boolean(),
    storeName: z.string().nullable().optional(),
  })
  .transform((value) => ({
    id: value.id,
    storeId: value.store,
    storeName: value.storeName ?? '',
    name: value.counter_name,
    type: value.counter_type,
    description: value.counter_desc,
    active: value.is_active,
  }));
export const storageSchema = z
  .object({
    id,
    store: id,
    storage_name: text,
    storage_type: z.string(),
    storage_desc: text,
    is_active: z.boolean(),
    storeName: z.string().nullable().optional(),
  })
  .transform((value) => ({
    id: value.id,
    storeId: value.store,
    storeName: value.storeName ?? '',
    name: value.storage_name,
    type: value.storage_type,
    description: value.storage_desc,
    active: value.is_active,
  }));
export const terminalSchema = z.object({
  id,
  counterId: z.number(),
  name: z.string(),
  merchantName: z.string(),
  storeName: z.string(),
  terminalId: z.string(),
  active: z.number(),
  provider: z.enum(['pine-labs', 'paytm']),
});
export const checkInSchema = z.object({
  storeId: id,
  counterId: id.nullable(),
  expiresAt: z.string(),
});
export const commonStoreSchema = z.object({
  id,
  name: z.string(),
  locationCode: z.string(),
  city: z.string(),
  active: z.boolean(),
});
export const successSchema = z.object({
  id: id.optional(),
  status: z.string().optional(),
  message: z.string().optional(),
});
export const pageSchema = <T>(entry: z.ZodType<T>, cursorSchema: z.ZodType<string> = id) =>
  z.object({ data: z.array(entry), nextCursor: cursorSchema.nullable() });
export function useAdministrationCollection<T>(
  ownerId: string,
  path: string,
  schema: z.ZodType<T>,
  search = '',
  active = 'true',
  cursorSchema: z.ZodType<string> = id,
  view?: { pageSize: number; sort: string; direction: 'asc' | 'desc' },
) {
  const [settledSearch, setSettledSearch] = useState(search);
  useEffect(() => {
    const timeout = setTimeout(() => setSettledSearch(search), 200);
    return () => clearTimeout(timeout);
  }, [search]);
  return useInfiniteQuery({
    queryKey: [ownerId, 'administration', path, settledSearch, active, view],
    enabled: !!path,
    initialPageParam: '0',
    queryFn: ({ pageParam, signal }) => {
      const bodySearch =
        Boolean(view) ||
        ['/api/v1/admin/operators', '/api/v1/admin/salespeople'].includes(path) ||
        /^\/api\/v1\/stores\/\d+\/salespeople$/.test(path);
      return bodySearch
        ? request(
            `${path}/search`,
            {
              method: 'POST',
              operatorId: ownerId,
              signal,
              body: JSON.stringify({
                after: pageParam,
                limit: view?.pageSize ?? 30,
                search: settledSearch,
                active,
                ...(view ? { sort: view.sort, direction: view.direction } : {}),
              }),
            },
            pageSchema(
              schema,
              view ? z.string().regex(/^c1\.[A-Za-z0-9_-]{1,4096}$/) : cursorSchema,
            ),
          )
        : request(
            `${path}?${params({ after: pageParam, limit: String(view?.pageSize ?? 30), search: settledSearch, active, ...(view ? { sort: view.sort, direction: view.direction } : {}) })}`,
            { signal, operatorId: ownerId },
            pageSchema(
              schema,
              view ? z.string().regex(/^c1\.[A-Za-z0-9_-]{1,4096}$/) : cursorSchema,
            ),
          );
    },
    getNextPageParam: (page) => page.nextCursor || undefined,
    staleTime: 15000,
    retry: 1,
  });
}
export const mutateAdministration = (
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
  operatorId?: string,
) =>
  request(
    path,
    { method, operatorId, body: body === undefined ? undefined : JSON.stringify(body) },
    method === 'DELETE' ? undefined : successSchema,
  );

/** A legacy Django form re-rendered with its per-field error lists. */
export class AdministrationFormError extends Error {
  constructor(
    message: string,
    public fields: Record<string, string[]>,
  ) {
    super(message);
  }
}
const formErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    fields: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
/** Submit a legacy form; field errors are kept (the shared client keeps only code/message). */
export async function submitAdministrationForm(
  path: string,
  method: 'POST' | 'PUT',
  body: unknown,
  operatorId: string,
) {
  const scope = captureOperatorScope(operatorId),
    signal = AbortSignal.any([scope, AbortSignal.timeout(30000)]);
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Operator-ID': operatorId },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new NetworkError();
  }
  signal.throwIfAborted();
  if (!response.ok) {
    let parsed: z.infer<typeof formErrorEnvelope>['error'] | undefined;
    try {
      parsed = formErrorEnvelope.parse((await response.json()) as unknown).error;
    } catch {
      /* Non-JSON gateway errors use a safe fallback. */
    }
    if (parsed?.fields) throw new AdministrationFormError(parsed.message, parsed.fields);
    throw new ApiError(
      response.status,
      parsed?.code || 'REQUEST_FAILED',
      parsed?.message || 'Could not connect to the store service.',
      parsed?.requestId,
    );
  }
  return successSchema.parse(await response.json());
}
