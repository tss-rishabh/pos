import { Secret, TOTP } from 'otpauth';

/** Source-compatible staff TOTP: SHA1, six digits, 30 seconds, no adjacent-window acceptance. */
export function verifyTotp(secret: string, code: string, timestamp = Date.now()): boolean {
  if (
    !/^\d{6}$/.test(code) ||
    secret.length > 255 ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  )
    return false;
  try {
    return (
      new TOTP({
        secret: Secret.fromBase32(secret),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      }).validate({ token: code, timestamp, window: 0 }) === 0
    );
  } catch {
    return false;
  }
}
