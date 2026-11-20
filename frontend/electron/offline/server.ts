import { z } from 'zod';
import { conflictCodeSchema, type ConflictCode } from '../../src/offline/billing/contracts';
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
/** The request provably never left the device (no connection was made), so the server
 * cannot have acted on it. Every other transport failure may have reached the server. */
export class RequestNotSentError extends NetworkUnavailableError {}

/** Chromium net errors raised before a connection exists: DNS, refused or unreachable
 * connections, connect timeouts, proxy/tunnel set-up and certificate rejection. Errors that
 * can happen after the request was written (resets, empty responses, timeouts, aborts) are
 * deliberately absent. */
const PRE_SEND_NET_ERRORS = new Set([
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_RESOLUTION_FAILED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_ADDRESS_INVALID',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
]);
export function preSendNetworkError(message: string): boolean {
  const match = /net::(ERR_[A-Z_]+)/.exec(message);
  if (!match) return false;
  return PRE_SEND_NET_ERRORS.has(match[1]!) || match[1]!.startsWith('ERR_CERT_');
}

/** Server error codes raised before the sale reaches order creation: the only refusals the
 * device retries by itself. */
export const PRE_DISPATCH_CODES: ReadonlySet<string> = new Set([
  'OFFLINE_SYNC_IN_PROGRESS',
  'CHECK_IN_REQUIRED',
  'OPERATOR_CHANGED',
]);
export const UNKNOWN_OUTCOME_MESSAGE =
  'The store service may already have created this order. A manager must check Orders for this provisional reference before resolving.';

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
/** A sale is retried automatically only for 'retry' (provably not sent, or refused before
 * dispatch) and 'unauthorized' (refused by the session check); every other outcome is final
 * until a manager decides. */
export type UploadOutcome =
  | { kind: 'synced'; orderId: string; invoiceNumber: string | null }
  | { kind: 'conflict'; code: ConflictCode; message: string }
  | { kind: 'unauthorized' }
  | { kind: 'retry'; code: string };

function errorOf(body: unknown) {
  const parsed = serverErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error : null;
}
const unknownOutcome = (message = UNKNOWN_OUTCOME_MESSAGE): UploadOutcome => ({
  kind: 'conflict',
  code: 'OUTCOME_UNKNOWN',
  message,
});

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
      } catch (error) {
        // Only a request that never left the device is safe to send again.
        if (error instanceof RequestNotSentError)
          return { kind: 'retry', code: 'NETWORK_UNAVAILABLE' };
        return unknownOutcome();
      }
      if (response.status === 200 || response.status === 201) {
        const result = offlineSaleResultSchema.safeParse(response.body);
        if (!result.success || result.data.provisionalRef !== sale.provisionalRef)
          return unknownOutcome();
        return {
          kind: 'synced',
          orderId: result.data.orderId,
          invoiceNumber: result.data.invoiceNumber,
        };
      }
      const error = errorOf(response.body);
      // The session check runs before the sale is looked at.
      if (response.status === 401) return { kind: 'unauthorized' };
      if (!error) return unknownOutcome();
      if (response.status === 409 && error.code.startsWith('OFFLINE_CONFLICT_'))
        return {
          kind: 'conflict',
          code: conflictCodeSchema
            .catch('OUTCOME_UNKNOWN')
            .parse(error.code.slice('OFFLINE_CONFLICT_'.length)),
          message: error.message,
        };
      if (PRE_DISPATCH_CODES.has(error.code)) return { kind: 'retry', code: error.code };
      // Anything else (5xx, 408, 429, or a refusal the device cannot place) may have followed
      // order creation: the manager checks Orders; the sale is never resent automatically.
      return unknownOutcome(
        response.status >= 400 && response.status < 500
          ? `${error.message} ${UNKNOWN_OUTCOME_MESSAGE}`
          : UNKNOWN_OUTCOME_MESSAGE,
      );
    },
  };
}
export type ServerApi = ReturnType<typeof serverApi>;
