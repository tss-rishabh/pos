import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2 as pbkdf2Callback,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(pbkdf2Callback);
function scrypt(password: string, salt: string, keylen: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password, salt, keylen, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}
/** Django 4.2 `PBKDF2PasswordHasher.iterations` (S6). */
export const DJANGO_PBKDF2_ITERATIONS = 600_000;
const RANDOM_STRING_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** Django `BasePasswordHasher.salt_entropy` = 128 bits → 22 characters of RANDOM_STRING_CHARS. */
const SALT_ENTROPY = 128;
const SALT_LENGTH = Math.ceil(SALT_ENTROPY / Math.log2(RANDOM_STRING_CHARS.length));
const MAX_ITERATIONS = 10_000_000;

function djangoSalt(): string {
  let salt = '';
  for (let index = 0; index < SALT_LENGTH; index++)
    salt += RANDOM_STRING_CHARS[randomInt(RANDOM_STRING_CHARS.length)];
  return salt;
}
const constantTimeEqual = (one: string, two: string) => {
  const a = Buffer.from(one, 'utf8'),
    b = Buffer.from(two, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};
async function encodePbkdf2(
  algorithm: 'pbkdf2_sha256' | 'pbkdf2_sha1',
  password: string,
  salt: string,
  iterations: number,
) {
  const digest = algorithm === 'pbkdf2_sha256' ? 'sha256' : 'sha1';
  const hash = await pbkdf2(password, salt, iterations, digest === 'sha256' ? 32 : 20, digest);
  return `${algorithm}$${iterations}$${salt}$${hash.toString('base64')}`;
}
/** Byte-compatible with Django 4.2 `make_password` using the default hasher. */
export async function djangoPasswordHash(password: string): Promise<string> {
  return encodePbkdf2('pbkdf2_sha256', password, djangoSalt(), DJANGO_PBKDF2_ITERATIONS);
}
export interface PasswordCheck {
  valid: boolean;
  /** Django `check_password` would call its setter: a successful login must re-hash. */
  mustUpdate: boolean;
}
const integer = (value: string | undefined) =>
  value !== undefined && /^\d{1,9}$/.test(value) ? Number(value) : undefined;
/**
 * Django 4.2 `check_password` for the hashers the legacy deployment can verify:
 * PBKDF2-SHA256, PBKDF2-SHA1 and scrypt (hashlib). Argon2 and BCryptSHA256 are listed in
 * Django's defaults but their libraries are not installed in legacy (requirements.txt),
 * so legacy cannot verify them either; they never authenticate here.
 * `mustUpdate` mirrors `hasher_changed or preferred.must_update(encoded)`.
 */
export async function checkDjangoPassword(
  password: string,
  encoded: string,
): Promise<PasswordCheck> {
  const invalid = { valid: false, mustUpdate: false };
  if (!encoded || encoded.startsWith('!')) return invalid;
  const algorithm = encoded.split('$', 1)[0];
  if (algorithm === 'pbkdf2_sha256' || algorithm === 'pbkdf2_sha1') {
    const first = encoded.indexOf('$'),
      second = encoded.indexOf('$', first + 1),
      third = encoded.indexOf('$', second + 1);
    if (first < 0 || second < 0 || third < 0) return invalid;
    const iterations = integer(encoded.slice(first + 1, second)),
      salt = encoded.slice(second + 1, third);
    if (!iterations || iterations > MAX_ITERATIONS || salt.includes('$')) return invalid;
    const valid = constantTimeEqual(
      encoded,
      await encodePbkdf2(algorithm, password, salt, iterations),
    );
    const mustUpdate =
      algorithm !== 'pbkdf2_sha256' ||
      iterations !== DJANGO_PBKDF2_ITERATIONS ||
      salt.length * Math.log2(RANDOM_STRING_CHARS.length) < SALT_ENTROPY;
    return { valid, mustUpdate: valid && mustUpdate };
  }
  if (algorithm === 'scrypt') {
    const parts = encoded.split('$');
    if (parts.length !== 6) return invalid;
    const [, n, salt, r, p, hash] = parts;
    const cost = integer(n),
      blockSize = integer(r),
      parallelism = integer(p);
    if (
      !cost ||
      !blockSize ||
      !parallelism ||
      salt === undefined ||
      hash === undefined ||
      cost > 2 ** 20 ||
      blockSize > 64 ||
      parallelism > 16
    )
      return invalid;
    try {
      const derived = await scrypt(password, salt, 64, {
        N: cost,
        r: blockSize,
        p: parallelism,
        maxmem: 256 * cost * blockSize * parallelism + 1024 * 1024,
      });
      const valid = constantTimeEqual(
        encoded,
        `scrypt$${cost}$${salt}$${blockSize}$${parallelism}$${derived.toString('base64')}`,
      );
      return { valid, mustUpdate: valid };
    } catch {
      return invalid;
    }
  }
  return invalid;
}
/** Compatibility export: true when `check_password` succeeds. */
export async function verifyDjangoPassword(password: string, encoded: string): Promise<boolean> {
  return (await checkDjangoPassword(password, encoded)).valid;
}
/**
 * Stable fingerprint of the account fields other modules bind short-lived grants to.
 * Authentication itself no longer uses it: sessions follow legacy and end only on a
 * password change or deactivation (S5).
 */
export function credentialVersion(account: {
  username: string;
  email: string | null;
  password: string;
  is_mfa: boolean | null;
  mfa_hash: string | null;
  phone: string | null;
  contact_email: string | null;
  otp_method: number;
  role: number;
  user_type: number;
  is_staff?: boolean | null;
  is_superuser?: boolean | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        account.username,
        account.email,
        account.password,
        Boolean(account.is_mfa),
        account.mfa_hash,
        account.phone,
        account.contact_email,
        account.otp_method,
        account.role,
        account.user_type,
        Boolean(account.is_staff),
        Boolean(account.is_superuser),
      ]),
    )
    .digest('hex');
}
export function seal(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}
export function unseal(value: string, secret: string): unknown {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < 29 || bytes.length > 8192) throw new Error('Invalid sealed cookie');
  const cipher = createDecipheriv(
    'aes-256-gcm',
    createHash('sha256').update(secret).digest(),
    bytes.subarray(0, 12),
  );
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
  );
}
