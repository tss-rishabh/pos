import { z } from 'zod';
import {
  offlineSaleResultSchema,
  offlineSettingsSchema,
  serverErrorSchema,
  type OfflineSaleUpload,
} from '../../src/offline/billing/sync-contract';

export interface HttpResponse {
  status: number;
  body: unknown;
}
export interface HttpRequest {
  method: 'GET' | 'POST';
  path: string;
  traceId: string;
  operatorId?: string;
  body?: unknown;
  timeoutMs?: number;
}
/** Session-cookie HTTP client to the workspace origin (main process only). */
export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}
export class NetworkUnavailableError extends Error {
  constructor() {
    super('The store service is unreachable.');
  }
}

const id = z.string().regex(/^[1-9]\d{0,19}$/);
const sessionSchema = z.object({
  user: z.object({
    id,
    name: z.string().max(300),
    role: z.number().int().min(1).max(5),
    userType: z.number().int(),
    storeIds: z.array(id).max(5000),
  }),
  sessionExpiresAt: z.number().int().nullable(),
});
const checkInSchema = z.object({
  data: z
    .object({ storeId: id, counterId: id.nullable(), expiresAt: z.string().max(64) })
    .nullable(),
});
const productPageSchema = z.object({
  data: z.array(
    z.object({
      id,
      name: z.string().max(500),
      barcode: z.string().max(64).nullable(),
      price: z.string().max(64),
      stock: z.number().int(),
    }),
  ),
  nextCursor: id.nullable(),
});
const salespersonId = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .refine((value) => BigInt(value) <= 2147483647n);
const salespeoplePageSchema = z.object({
  data: z.array(z.object({ id: salespersonId, name: z.string().max(500) })).max(100),
  nextCursor: salespersonId.nullable(),
});
const MAX_SALESPEOPLE_PAGES = 50;
const listSchema = z.object({ data: z.array(z.object({ id, name: z.string().max(300) })) });

export type ServerSession = z.infer<typeof sessionSchema>;
export type UploadOutcome =
  | { kind: 'synced'; orderId: string; invoiceNumber: string | null }
  | { kind: 'conflict'; code: string; message: string }
  | { kind: 'unauthorized' }
  | { kind: 'retry'; code: string }
  | { kind: 'rejected'; code: string; message: string };

function errorOf(body: unknown) {
  const parsed = serverErrorSchema.safeParse(body);
  return parsed.success
    ? parsed.data.error
    : { code: 'SERVER_ERROR', message: 'The store service rejected this request.' };
}

export function serverApi(http: HttpClient) {
  return {
    async reachable(traceId: string): Promise<boolean> {
      try {
        const response = await http.request({
          method: 'GET',
          path: '/health/ready',
          traceId,
          timeoutMs: 5000,
        });
        return response.status === 200;
      } catch {
        return false;
      }
    },
    /** null means the session is gone (signed out, expired or revoked). */
    async session(traceId: string): Promise<ServerSession | null> {
      const response = await http.request({
        method: 'GET',
        path: '/api/v1/auth/sessions/current',
        traceId,
      });
      if (response.status === 401) return null;
      if (response.status !== 200) throw new NetworkUnavailableError();
      return sessionSchema.parse(response.body);
    },
    async checkIn(traceId: string, operatorId: string) {
      const response = await http.request({
        method: 'GET',
        path: '/api/v1/operators/me/check-in',
        traceId,
        operatorId,
      });
      if (response.status !== 200) return null;
      const data = checkInSchema.parse(response.body).data;
      if (!data) return null;
      const expiresAt = Date.parse(data.expiresAt);
      return Number.isFinite(expiresAt)
        ? { storeId: data.storeId, counterId: data.counterId, expiresAt }
        : null;
    },
    async settings(traceId: string, operatorId: string) {
      const response = await http.request({
        method: 'GET',
        path: '/api/v1/offline-billing/settings',
        traceId,
        operatorId,
      });
      if (response.status !== 200) throw new NetworkUnavailableError();
      return offlineSettingsSchema.parse(response.body);
    },
    async stores(traceId: string) {
      const response = await http.request({ method: 'GET', path: '/api/v1/stores', traceId });
      return response.status === 200 ? listSchema.parse(response.body).data : [];
    },
    async counters(traceId: string, storeId: string) {
      const response = await http.request({
        method: 'GET',
        path: `/api/v1/stores/${storeId}/counters`,
        traceId,
      });
      return response.status === 200 ? listSchema.parse(response.body).data : [];
    },
    /** Active checkout salespeople of the store (the same directory the counter uses). */
    async salespeople(traceId: string, operatorId: string, storeId: string) {
      const people: { id: string; name: string }[] = [];
      let after = '0';
      for (let page = 0; page < MAX_SALESPEOPLE_PAGES; page++) {
        const query = new URLSearchParams({
          purpose: 'checkout',
          active: 'true',
          after,
          limit: '100',
        });
        const response = await http.request({
          method: 'GET',
          path: `/api/v1/stores/${storeId}/salespeople?${query.toString()}`,
          traceId,
          operatorId,
        });
        if (response.status !== 200) throw new NetworkUnavailableError();
        const result = salespeoplePageSchema.parse(response.body);
        people.push(
          ...result.data.map((person) => ({ id: person.id, name: person.name.slice(0, 200) })),
        );
        if (!result.nextCursor || BigInt(result.nextCursor) <= BigInt(after)) break;
        after = result.nextCursor;
      }
      return people;
    },
    async catalogPage(traceId: string, storeId: string, after: string) {
      const query = new URLSearchParams({ limit: '100', after, includeOutOfStock: 'false' });
      const response = await http.request({
        method: 'GET',
        path: `/api/v1/stores/${storeId}/catalog/products?${query.toString()}`,
        traceId,
        timeoutMs: 20000,
      });
      if (response.status !== 200) throw new NetworkUnavailableError();
      return productPageSchema.parse(response.body);
    },
    async upload(
      traceId: string,
      operatorId: string,
      storeId: string,
      counterId: string,
      sale: OfflineSaleUpload,
    ): Promise<UploadOutcome> {
      let response: HttpResponse;
      try {
        response = await http.request({
          method: 'POST',
          path: `/api/v1/stores/${storeId}/counters/${counterId}/offline-sales`,
          traceId,
          operatorId,
          body: sale,
          timeoutMs: 60000,
        });
      } catch {
        return { kind: 'retry', code: 'NETWORK_UNAVAILABLE' };
      }
      if (response.status === 200 || response.status === 201) {
        const result = offlineSaleResultSchema.safeParse(response.body);
        if (!result.success || result.data.provisionalRef !== sale.provisionalRef)
          return { kind: 'retry', code: 'INVALID_SERVER_REPLY' };
        return {
          kind: 'synced',
          orderId: result.data.orderId,
          invoiceNumber: result.data.invoiceNumber,
        };
      }
      const error = errorOf(response.body);
      if (response.status === 401) return { kind: 'unauthorized' };
      if (error.code.startsWith('OFFLINE_CONFLICT_'))
        return {
          kind: 'conflict',
          code: error.code.slice('OFFLINE_CONFLICT_'.length),
          message: error.message,
        };
      if (
        response.status >= 500 ||
        response.status === 429 ||
        response.status === 408 ||
        ['OFFLINE_SYNC_IN_PROGRESS', 'OPERATOR_CHANGED', 'CHECK_IN_REQUIRED'].includes(error.code)
      )
        return { kind: 'retry', code: error.code };
      return { kind: 'rejected', code: error.code, message: error.message };
    },
  };
}
export type ServerApi = ReturnType<typeof serverApi>;
