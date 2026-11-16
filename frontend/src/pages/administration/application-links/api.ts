import { z } from 'zod';
import { request } from '../../../api/client';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  image = z
    .string()
    .max(200000)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
  sameOriginLink = z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.origin === window.location.origin &&
      ['/application-links/staff', '/application-links/customer'].includes(url.pathname) &&
      !url.search &&
      token.safeParse(url.hash.slice(1)).success
    );
  });
export const applicationCapabilitiesSchema = z.object({
  staffAvailable: z.boolean(),
  customerAvailable: z.boolean(),
  checkedInStore: z.string().nullable(),
  qrPeriodSeconds: z.number().int().min(30).max(300),
});
export const staffQrSchema = z.object({
  id: z.uuid(),
  url: sameOriginLink,
  qrDataUrl: image,
  serverNow: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  filename: z.literal('mpos.apk'),
  bytes: z.number().int().min(4).max(536870912),
});
export const customerQrSchema = z.object({
  storeId: z.string(),
  storeName: z.string(),
  url: sameOriginLink,
  qrDataUrl: image,
});
export type StaffApplicationQr = z.infer<typeof staffQrSchema>;
export type CustomerApplicationQr = z.infer<typeof customerQrSchema>;
const activationSchema = z.object({
  activationToken: token,
  serverNow: z.number().int(),
  expiresAt: z.number().int(),
  filename: z.literal('mpos.apk'),
  bytes: z.number().int().min(4).max(536870912),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export const destinationSchema = z.object({
  destination: z
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
    }),
});
export const applicationBase = '/api/v1/operators/current/application-links';
const publicBase = '/api/v1/auth/application-links';
export function issueStaffQr(operatorId: string, operationId: string, signal: AbortSignal) {
  return request(
    applicationBase + '/staff-qr',
    {
      method: 'POST',
      operatorId,
      signal,
      body: JSON.stringify({ operationId }),
      cache: 'no-store',
      redirect: 'error',
    },
    staffQrSchema,
  );
}
export function issueCustomerQr(operatorId: string, signal: AbortSignal) {
  return request(
    applicationBase + '/customer-qr',
    { method: 'POST', operatorId, signal, body: '{}', cache: 'no-store', redirect: 'error' },
    customerQrSchema,
  );
}

export function applicationFragment(hash: string) {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  return token.safeParse(value).success ? value : null;
}
function safeError(code: string | undefined) {
  return new Error(
    code === 'APPLICATION_LINK_EXPIRED'
      ? 'This application link expired or was already used. Request a new QR code.'
      : code === 'CUSTOMER_APPLICATION_PREPARING'
        ? 'The application link is being prepared. Try again shortly.'
        : 'Could not open the application link. Try again.',
  );
}
async function publicResponse(
  action: 'staff-download-activations' | 'staff-download-content' | 'customer-scans',
  body: unknown,
  signal: AbortSignal,
) {
  let response: Response;
  try {
    response = await fetch(publicBase + '/' + action, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(action === 'staff-download-content' ? 600000 : 15000),
      ]),
    });
  } catch {
    signal.throwIfAborted();
    throw safeError(undefined);
  }
  signal.throwIfAborted();
  if (!response.ok) {
    const envelope = z.object({ error: z.object({ code: z.string() }) });
    let code: string | undefined;
    try {
      code = envelope.parse((await response.json()) as unknown).error.code;
    } catch {
      /* Only static messages are exposed. */
    }
    signal.throwIfAborted();
    throw safeError(code);
  }
  return response;
}
export function applicationDownloadSession(qrToken: string) {
  const value = token.parse(qrToken),
    activationOperationId = crypto.randomUUID(),
    downloadOperationId = crypto.randomUUID();
  let activation: z.infer<typeof activationSchema> | undefined;
  return async (signal: AbortSignal) => {
    if (!activation)
      activation = activationSchema.parse(
        (await (
          await publicResponse(
            'staff-download-activations',
            { token: value, operationId: activationOperationId },
            signal,
          )
        ).json()) as unknown,
      );
    signal.throwIfAborted();
    const response = await publicResponse(
      'staff-download-content',
      { activationToken: activation.activationToken, operationId: downloadOperationId },
      signal,
    );
    if (
      !response.body ||
      response.headers.get('Content-Type')?.split(';')[0] !==
        'application/vnd.android.package-archive' ||
      response.headers.get('Content-Length') !== String(activation.bytes)
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw safeError(undefined);
    }
    const reader = response.body.getReader();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > activation.bytes) throw safeError(undefined);
        parts.push(Uint8Array.from(part.value));
      }
      if (bytes !== activation.bytes) throw safeError(undefined);
      return new Blob(parts, { type: 'application/vnd.android.package-archive' });
    } catch {
      await reader.cancel().catch(() => undefined);
      signal.throwIfAborted();
      throw safeError(undefined);
    } finally {
      reader.releaseLock();
    }
  };
}
export function customerApplicationSession(qrToken: string) {
  const input = { token: token.parse(qrToken), operationId: crypto.randomUUID() };
  return async (signal: AbortSignal) => {
    const response = await publicResponse('customer-scans', input, signal),
      parsed = destinationSchema.parse((await response.json()) as unknown);
    signal.throwIfAborted();
    return parsed.destination;
  };
}
export function downloadApplicationBlob(
  blob: Blob,
  filename: 'mpos.apk' | 'customer-application-qr.png',
) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
