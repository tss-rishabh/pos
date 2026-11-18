import { pbkdf2Sync, scryptSync } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';
import {
  checkDjangoPassword,
  DJANGO_PBKDF2_ITERATIONS,
  djangoPasswordHash,
} from '../../src/auth/crypto.js';
import { fixedOtpSettings } from '../../src/auth/login-otp.js';
import { legacyCheckInValue } from '../../src/auth/checkin.js';
import { endOfDaySeconds } from '../../src/auth/sessions.js';
import { verifyTotp, totpSecretUsable } from '../../src/auth/totp.js';
import { loginOtpEmailBody, maskPhone, slackAlertText } from '../../src/auth/delivery.js';

const pbkdf2 = (algorithm: 'sha256' | 'sha1', password: string, salt: string, rounds: number) =>
  `pbkdf2_${algorithm}$${rounds}$${salt}$${pbkdf2Sync(password, salt, rounds, algorithm === 'sha256' ? 32 : 20, algorithm).toString('base64')}`;

describe('Django 4.2 password hashing (S6, S7)', () => {
  it('hashes at 600k with a 22-character alphanumeric salt and verifies its own output', async () => {
    const encoded = await djangoPasswordHash('pässword');
    expect(encoded).toMatch(/^pbkdf2_sha256\$600000\$[A-Za-z0-9]{22}\$[A-Za-z0-9+/]{43}=$/);
    const [, , salt] = encoded.split('$');
    expect(encoded).toBe(pbkdf2('sha256', 'pässword', salt!, DJANGO_PBKDF2_ITERATIONS));
    expect(await checkDjangoPassword('pässword', encoded)).toEqual({
      valid: true,
      mustUpdate: false,
    });
    expect(await checkDjangoPassword('password', encoded)).toEqual({
      valid: false,
      mustUpdate: false,
    });
  });
  it('asks for a rehash exactly when Django would (iterations, short salt, other hasher)', async () => {
    const salt = 'abcdefghijklmnopqrstuv';
    expect(await checkDjangoPassword('p', pbkdf2('sha256', 'p', salt, 216000))).toEqual({
      valid: true,
      mustUpdate: true,
    });
    expect(await checkDjangoPassword('p', pbkdf2('sha256', 'p', 'short', 600000))).toEqual({
      valid: true,
      mustUpdate: true,
    });
    expect(await checkDjangoPassword('p', pbkdf2('sha1', 'p', salt, 1000))).toEqual({
      valid: true,
      mustUpdate: true,
    });
    const scrypt = `scrypt$16384$${salt}$8$1$${scryptSync('p', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
    expect(await checkDjangoPassword('p', scrypt)).toEqual({ valid: true, mustUpdate: true });
    expect(await checkDjangoPassword('q', scrypt)).toEqual({ valid: false, mustUpdate: false });
  });
  it('never authenticates unusable, unknown or library-less hashes', async () => {
    for (const encoded of [
      '!unusable',
      '',
      'argon2$argon2id$v=19$m=102400,t=2,p=8$c2FsdA$aGFzaA',
      'bcrypt_sha256$$2b$12$abcdefghijklmnopqrstuv',
      'md5$salt$hash',
      'pbkdf2_sha256$x$salt$hash',
    ])
      expect((await checkDjangoPassword('p', encoded)).valid).toBe(false);
  });
});
describe('legacy settings and wire formats', () => {
  it('parses the fixed OTP settings as POSAdmin/settings.py does', () => {
    const fixed = fixedOtpSettings({
      LOGIN_FIXED_OTP_ENABLED: ' 1 ',
      LOGIN_FIXED_OTP: '  0042 ',
      LOGIN_FIXED_OTP_USER_IDS: '1, 2,,x, 007,3a',
    });
    expect(fixed.otp).toBe('0042');
    expect([...fixed.userIds].sort()).toEqual(['1', '2', '7']);
    expect(fixed.appliesTo('7')).toBe(true);
    expect(fixed.appliesTo('3')).toBe(false);
    expect(
      fixedOtpSettings({
        LOGIN_FIXED_OTP_ENABLED: '0',
        LOGIN_FIXED_OTP: '1',
        LOGIN_FIXED_OTP_USER_IDS: '1',
      }).appliesTo('1'),
    ).toBe(false);
    expect(
      fixedOtpSettings({
        LOGIN_FIXED_OTP_ENABLED: '1',
        LOGIN_FIXED_OTP: '   ',
        LOGIN_FIXED_OTP_USER_IDS: '1',
      }).appliesTo('1'),
    ).toBe(false);
    expect(fixedOtpSettings({}).enabled).toBe(false);
    expect(() => fixedOtpSettings({ LOGIN_FIXED_OTP_ENABLED: 'yes' })).toThrow();
  });
  it('writes check_in_{uid} byte-compatible with Python json.dumps', () => {
    expect(legacyCheckInValue('12', 'Andheri')).toBe('[12, "Andheri"]');
    expect(legacyCheckInValue('0', '')).toBe('[0, ""]');
    expect(legacyCheckInValue('5', null)).toBe('[5, null]');
    expect(legacyCheckInValue('5', 'Café "B" 😀\u007f')).toBe(
      '[5, "Caf\\u00e9 \\"B\\" \\ud83d\\ude00\\u007f"]',
    );
  });
  it('expires sessions at 23:59:59 business-local time, as time_until_end_of_day() - 1', () => {
    // 2026-11-19 10:00:00 IST
    expect(endOfDaySeconds('Asia/Kolkata', Date.UTC(2026, 10, 19, 4, 30, 0))).toBe(14 * 3600 - 1);
    // 23:59:58 IST → 1 second
    expect(endOfDaySeconds('Asia/Kolkata', Date.UTC(2026, 10, 19, 18, 29, 58))).toBe(1);
    expect(endOfDaySeconds('Asia/Kolkata', Date.UTC(2026, 10, 19, 18, 29, 59))).toBe(1);
  });
  it('matches pyotp TOTP verification, including NFKC digits and lowercase secrets', () => {
    const secret = 'JBSWY3DPEHPK3PXP',
      at = 1_794_787_200_000,
      totp = new TOTP({
        secret: Secret.fromBase32(secret),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      }),
      code = totp.generate({ timestamp: at }),
      previous = totp.generate({ timestamp: at - 30_000 });
    expect(verifyTotp(secret, code, at)).toBe(true);
    expect(verifyTotp(secret.toLowerCase(), code, at)).toBe(true);
    const fullWidth = [...code].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
    expect(verifyTotp(secret, fullWidth, at)).toBe(true);
    expect(verifyTotp(secret, ' ' + code, at)).toBe(false);
    if (previous !== code) expect(verifyTotp(secret, previous, at)).toBe(false);
    expect(totpSecretUsable(null)).toBe(false);
    expect(totpSecretUsable('not base32!')).toBe(false);
    expect(totpSecretUsable(secret.toLowerCase())).toBe(true);
  });
  it('formats delivery text as legacy helpers do, with a masked phone and escaped name', () => {
    expect(maskPhone('9876543210')).toBe('98****10');
    expect(maskPhone('1234')).toBe('****');
    expect(slackAlertText(':lock: Staff login', 'backend-pos-web')).toBe(
      ':lock: *[backend-pos-web]* Staff login',
    );
    expect(loginOtpEmailBody('<b>Ann</b>', '012345')).toBe(
      'Hey &lt;b&gt;Ann&lt;/b&gt;,\n\n        012345 is your OTP to login into the POS Admin.\n\n        Have a soulful day!\n        The Souled Store Team',
    );
  });
});
