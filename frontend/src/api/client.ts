import { z } from 'zod';
import {
  desktopStoreServiceUnreachable,
  OfflineBillingClientError,
} from '../offline/billing/bridge';
let operatorId: string | null = null;
let operatorScope = new AbortController();
export function setRequestOperator(id: string | null) {
  if (id === operatorId) return;
  operatorScope.abort();
  operatorScope = new AbortController();
  operatorId = id;
}
/** Capture before reading files/hashing; check again before publishing owner-bound local work. */
export function captureOperatorScope(expectedOperatorId: string): AbortSignal {
  if (!operatorId || expectedOperatorId !== operatorId)
    throw new DOMException('The signed-in operator changed.', 'AbortError');
  return operatorScope.signal;
}
/**
 * `requestId` is sent as `X-Request-Id`. Each logical request gets a fresh UUID; a caller that
 * retries the same logical request passes the ID it used before (or the same `X-Request-Id`
 * header), so the server correlates every attempt under one trace.
 */
export type OperatorRequestInit = RequestInit & { operatorId?: string; requestId?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A new request ID for one logical request; reuse it for that request's retries. */
export function newRequestId(): string {
  return crypto.randomUUID();
}
/** The server's request ID, when it is a well-formed UUID (shown to support, never parsed further). */
export function serverRequestId(value: string | null | undefined): string | undefined {
  return value && uuid.test(value) ? value.toLowerCase() : undefined;
}
const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }),
});
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
export class NetworkError extends Error {
  constructor() {
    super('Could not connect to the store service. Check your connection and try again.');
  }
}
/** The server request ID support can quote for a failed request, if the server answered. */
export function errorRequestId(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.requestId;
  // Desktop offline billing: the IPC request ID the main process logged the failure under.
  return error instanceof OfflineBillingClientError ? (error.requestId ?? undefined) : undefined;
}
async function openResponse(
  path: string,
  options: OperatorRequestInit = {},
): Promise<{ response: Response; signal: AbortSignal }> {
  const headers = new Headers(options.headers);
  if (!path.startsWith('/api/v1/auth/')) {
    const assertedOperator = headers.get('X-Operator-ID');
    if (
      (options.operatorId !== undefined && options.operatorId !== operatorId) ||
      (assertedOperator !== null && assertedOperator !== operatorId)
    )
      throw new DOMException('The signed-in operator changed.', 'AbortError');
  }
  const expectedOperator = options.operatorId ?? operatorId;
  if (expectedOperator && !headers.has('X-Operator-ID'))
    headers.set('X-Operator-ID', expectedOperator);
  const requestId =
    serverRequestId(options.requestId) ??
    serverRequestId(headers.get('X-Request-Id')) ??
    newRequestId();
  headers.set('X-Request-Id', requestId);
  const { operatorId: _operatorId, requestId: _requestId, ...transport } = options;
  const signal = path.startsWith('/api/v1/auth/')
    ? options.signal || AbortSignal.timeout(12000)
    : AbortSignal.any([operatorScope.signal, options.signal || AbortSignal.timeout(12000)]);
  if (options.body !== undefined && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  // The browser already knows there is no network: answer as unreachable without a request that
  // can only fail, so callers take their offline path (cached reads, queued work).
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    signal.throwIfAborted();
    throw new NetworkError();
  }
  let response: Response;
  try {
    response = await fetch(path, {
      ...transport,
      credentials: 'include',
      headers,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new NetworkError();
  }
  signal.throwIfAborted();
  if (!response.ok) {
    let error: z.infer<typeof errorEnvelope>['error'] | undefined;
    try {
      error = errorEnvelope.parse((await response.json()) as unknown).error;
    } catch {
      /* Non-JSON gateway errors use a safe fallback. */
    }
    signal.throwIfAborted();
    if (desktopStoreServiceUnreachable(response.status, error !== undefined))
      throw new NetworkError();
    if (error?.code === 'OPERATOR_CHANGED' && typeof window !== 'undefined')
      window.dispatchEvent(new Event('pos-operator-changed'));
    throw new ApiError(
      response.status,
      error?.code || 'REQUEST_FAILED',
      error?.message || 'Could not connect to the store service.',
      serverRequestId(error?.requestId) ??
        serverRequestId(response.headers.get('X-Request-Id')) ??
        requestId,
    );
  }
  return { response, signal };
}
/** Consume binary/text inside this callback so a changed owner cannot publish a late result. */
export async function requestWithResponse<T>(
  path: string,
  options: OperatorRequestInit,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const { response, signal } = await openResponse(path, options);
  const value = await read(response);
  signal.throwIfAborted();
  return value;
}
export async function request<T>(
  path: string,
  options: OperatorRequestInit = {},
  schema?: z.ZodType<T>,
): Promise<T> {
  return requestWithResponse(path, options, async (response) => {
    if (response.status === 204) return undefined as T;
    const body: unknown = await response.json();
    return schema ? schema.parse(body) : (body as T);
  });
}
export const post = <T>(path: string, body?: unknown, schema?: z.ZodType<T>, operatorId?: string) =>
  request<T>(
    path,
    { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), operatorId },
    schema,
  );
export const put = <T>(
  path: string,
  body: unknown,
  options: OperatorRequestInit = {},
  schema?: z.ZodType<T>,
) => request<T>(path, { ...options, method: 'PUT', body: JSON.stringify(body) }, schema);
export const params = (values: Record<string, string | undefined>) =>
  new URLSearchParams(
    Object.entries(values).filter((e): e is [string, string] => e[1] !== undefined),
  ).toString();
