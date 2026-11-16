import { z } from 'zod';
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
export type OperatorRequestInit = RequestInit & { operatorId?: string };
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
  const { operatorId: _operatorId, ...transport } = options;
  const signal = path.startsWith('/api/v1/auth/')
    ? options.signal || AbortSignal.timeout(12000)
    : AbortSignal.any([operatorScope.signal, options.signal || AbortSignal.timeout(12000)]);
  if (options.body !== undefined && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
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
    if (error?.code === 'OPERATOR_CHANGED' && typeof window !== 'undefined')
      window.dispatchEvent(new Event('pos-operator-changed'));
    throw new ApiError(
      response.status,
      error?.code || 'REQUEST_FAILED',
      error?.message || 'Could not connect to the store service.',
      error?.requestId,
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
