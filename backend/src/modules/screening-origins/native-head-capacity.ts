import { nativeHeadDescriptor } from './native-head-metadata.generated.js';

/** Generated installation capacity, never a request/configuration override. */
export const nativeHeadLimits = nativeHeadDescriptor.limits;

/** mysql2's completed execute result has reached EOF. Never slice its prefix:
 * a 513th row, malformed row or statement-byte overflow refuses qualification. */
export function nativeHeadCallerGrants(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > nativeHeadLimits.callerGrantRows)
    return undefined;
  const grants: string[] = [];
  let bytes = 0;
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 1)
      return undefined;
    const grant = Object.values(row)[0];
    if (typeof grant !== 'string' || !grant.length || /[\uD800-\uDFFF]/u.test(grant))
      return undefined;
    const size = Buffer.byteLength(grant, 'utf8');
    bytes += size;
    if (
      size > nativeHeadLimits.callerGrantRowBytes ||
      bytes > nativeHeadLimits.callerGrantTotalBytes
    )
      return undefined;
    grants.push(grant);
  }
  return grants;
}

export function nativeHeadMetadataDocument(raw: unknown): unknown {
  try {
    if (Buffer.isBuffer(raw)) {
      if (raw.byteLength > nativeHeadLimits.metadataBytes) return undefined;
      raw = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    }
    if (typeof raw === 'string') {
      if (Buffer.byteLength(raw, 'utf8') > nativeHeadLimits.metadataBytes) return undefined;
      return JSON.parse(raw) as unknown;
    }
    const encoded = JSON.stringify(raw);
    if (
      encoded === undefined ||
      Buffer.byteLength(encoded, 'utf8') > nativeHeadLimits.metadataBytes
    )
      return undefined;
    return raw;
  } catch {
    return undefined;
  }
}
