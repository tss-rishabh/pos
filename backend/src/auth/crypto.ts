import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2 as pbkdf2Callback,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(pbkdf2Callback);
export async function djangoPasswordHash(password: string): Promise<string> {
  const salt = randomBytes(12).toString('base64url');
  const rounds = 1_000_000;
  const digest = await pbkdf2(password, salt, rounds, 32, 'sha256');
  return `pbkdf2_sha256$${rounds}$${salt}$${digest.toString('base64')}`;
}
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
/** Compatible with Django's PBKDF2PasswordHasher; unsupported hashes never authenticate. */
export async function verifyDjangoPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterations, salt, hash, ...extra] = encoded.split('$');
  if (algorithm !== 'pbkdf2_sha256' || !iterations || !salt || !hash || extra.length) return false;
  const rounds = Number(iterations);
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 5_000_000) return false;
  const actual = await pbkdf2(password, salt, rounds, 32, 'sha256');
  const expected = Buffer.from(hash, 'base64');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
