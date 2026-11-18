/** Provisional offline receipt reference, recorded at sync in a legacy-style
 * comments row on the created order (the order's own reference number belongs
 * to API-v2): OFF-<storeId>-<counterId>-<deviceShort>-<seq>, at most 55 chars. */
export const MAX_REFERENCE_LENGTH = 55;
export const DEVICE_SHORT_PATTERN = /^[A-Z0-9]{8}$/;
export const PROVISIONAL_REFERENCE_PATTERN =
  /^OFF-([1-9]\d{0,19})-([1-9]\d{0,19})-([A-Z0-9]{8})-([1-9]\d{0,8})$/;
const identifier = /^[1-9]\d{0,19}$/;

export interface ReferenceParts {
  storeId: string;
  counterId: string;
  deviceShort: string;
  sequence: number;
}

export function provisionalReference(parts: ReferenceParts): string {
  if (!identifier.test(parts.storeId) || !identifier.test(parts.counterId))
    throw new RangeError('Store and counter must be positive identifiers.');
  if (!DEVICE_SHORT_PATTERN.test(parts.deviceShort))
    throw new RangeError('Device short code must be 8 upper-case alphanumerics.');
  if (!Number.isSafeInteger(parts.sequence) || parts.sequence < 1 || parts.sequence > 999_999_999)
    throw new RangeError('Sequence must be a positive integer below one billion.');
  const value = `OFF-${parts.storeId}-${parts.counterId}-${parts.deviceShort}-${parts.sequence}`;
  if (value.length > MAX_REFERENCE_LENGTH)
    throw new RangeError('Provisional reference exceeds the order reference column.');
  return value;
}

export function parseProvisionalReference(value: string): ReferenceParts | null {
  if (value.length > MAX_REFERENCE_LENGTH) return null;
  const match = PROVISIONAL_REFERENCE_PATTERN.exec(value);
  if (!match) return null;
  return {
    storeId: match[1]!,
    counterId: match[2]!,
    deviceShort: match[3]!,
    sequence: Number(match[4]),
  };
}

/** Derive the stable 8-character device code from the random device ID. */
export function deviceShortCode(deviceId: string): string {
  if (!/^[a-f0-9]{32}$/.test(deviceId)) throw new RangeError('Invalid device identifier.');
  return deviceId.slice(0, 8).toUpperCase();
}
