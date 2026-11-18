import { Secret, TOTP } from 'otpauth';

/** pyotp `byte_secret()`: case-insensitive base32 with optional padding. */
function secretFrom(secret: string): Secret | null {
  if (!secret || secret.length > 255) return null;
  const normalized = secret.toUpperCase().replace(/=+$/, '');
  if (!/^[A-Z2-7]+$/.test(normalized)) return null;
  try {
    return Secret.fromBase32(normalized);
  } catch {
    return null;
  }
}
/** False for a NULL or malformed `pos_user.mfa_hash` (legacy raises and returns HTTP 500). */
export function totpSecretUsable(secret: string | null): secret is string {
  return secret !== null && secretFrom(secret) !== null;
}
/**
 * pyotp 2.9 `TOTP(secret).verify(code)`: SHA1, six digits, 30-second step, no adjacent
 * window, and NFKC-normalised constant-time comparison (so full-width digits match).
 */
export function verifyTotp(secret: string, code: string, timestamp = Date.now()): boolean {
  const key = secretFrom(secret);
  if (!key || !Number.isSafeInteger(timestamp) || timestamp < 0 || code.length > 64) return false;
  const expected = new TOTP({ secret: key, algorithm: 'SHA1', digits: 6, period: 30 }).generate({
    timestamp,
  });
  const actual = Buffer.from(code.normalize('NFKC'), 'utf8'),
    wanted = Buffer.from(expected, 'utf8');
  let difference = actual.length ^ wanted.length;
  for (let index = 0; index < wanted.length; index++)
    difference |= (actual[index] ?? 0) ^ wanted[index]!;
  return difference === 0;
}
