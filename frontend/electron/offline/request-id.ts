import { createHash } from 'node:crypto';

/**
 * The request ID of one HTTP call (sent as `X-Request-Id`), derived from the operation's shared
 * trace ID and the call's step (`session`, `catalog:3`, `upload:<saleId>`). Each call gets its own
 * ID on the server, yet anyone holding the desktop trace can recompute it. The result is an RFC
 * 9562 version-8 UUID, the only form the server honours (S51).
 */
export function callRequestId(traceId: string, step: string): string {
  const hex = createHash('sha256').update(`${traceId}\u0000${step}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
