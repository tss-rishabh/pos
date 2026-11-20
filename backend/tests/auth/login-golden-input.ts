/**
 * Oracle input for tests/golden/auth/login-flow.json. The capture fed exactly
 * `JSON.stringify(loginGoldenInput)` to the legacy oracle; any change here needs a recapture
 * from the pinned source (see tests/golden/INVENTORY.md, "V2").
 */
import { pbkdf2Sync, scryptSync } from 'node:crypto';

export interface GoldenLoginUser {
  id: number;
  otp_method: 1 | 2;
  is_mfa: 0 | 1;
  mfa_hash: string | null;
  phone: string;
  contact_email: string | null;
  first_name: string;
  role: number;
  is_active: boolean;
  stores: number[];
}
export type GoldenCode =
  | string
  | { use: 'last-sent' | 'previous-sent' | 'wrong' }
  | { use: 'totp'; offset: number };
export type GoldenLoginStep =
  | { op: 'password' }
  | { op: 'resend' }
  | { op: 'advance'; seconds: number }
  | { op: 'verify'; code: GoldenCode; platform?: string; store?: number | string };
export interface GoldenLoginScenario {
  name: string;
  user: number;
  users: GoldenLoginUser[];
  stores?: number[];
  fixedOtp?: { enabled: number; otp: string; userIds: number[] };
  steps: GoldenLoginStep[];
}

const sms: GoldenLoginUser = {
  id: 7,
  otp_method: 1,
  is_mfa: 0,
  mfa_hash: null,
  phone: '9000000007',
  contact_email: null,
  first_name: 'Asha',
  role: 5,
  is_active: true,
  stores: [1],
};
const email: GoldenLoginUser = {
  ...sms,
  id: 8,
  otp_method: 2,
  contact_email: 'ops8@example.test',
  phone: '9000000008',
};
const noPhone: GoldenLoginUser = { ...sms, id: 9, phone: '' };
const totp: GoldenLoginUser = {
  ...sms,
  id: 10,
  is_mfa: 1,
  mfa_hash: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  phone: '9000000010',
};
const badTotp: GoldenLoginUser = { ...totp, id: 11, mfa_hash: 'not base32!' };
const admin: GoldenLoginUser = { ...sms, id: 12, role: 1, stores: [] };
const otp = (code: GoldenCode, store: number | string = 1): GoldenLoginStep => ({
  op: 'verify',
  code,
  platform: 'otp',
  store,
});
const sent: GoldenCode = { use: 'last-sent' },
  wrong: GoldenCode = { use: 'wrong' };
const wait = (seconds: number): GoldenLoginStep => ({ op: 'advance', seconds });
const salt = 'abcdefghijklmnopqrstuv';
const pbkdf2 = (algorithm: 'sha256' | 'sha1', password: string, saltText: string, rounds: number) =>
  `pbkdf2_${algorithm}$${rounds}$${saltText}$${pbkdf2Sync(password, saltText, rounds, algorithm === 'sha256' ? 32 : 20, algorithm).toString('base64')}`;
const scrypt = (password: string) =>
  `scrypt$16384$${salt}$8$1$${scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;

export const loginGoldenInput: {
  scenarios: GoldenLoginScenario[];
  passwords: { password: string; encoded: string }[];
} = {
  scenarios: [
    { name: 'sms otp signs in', user: 7, users: [sms], steps: [{ op: 'password' }, otp(sent)] },
    { name: 'email otp signs in', user: 8, users: [email], steps: [{ op: 'password' }, otp(sent)] },
    {
      name: 'wrong code, retry pause, then the right code',
      user: 7,
      users: [sms],
      steps: [{ op: 'password' }, otp(wrong), otp(sent), wait(30), otp(sent)],
    },
    {
      name: 'three wrong codes lock the OTP step',
      user: 7,
      users: [sms],
      steps: [
        { op: 'password' },
        otp(wrong),
        wait(30),
        otp(wrong),
        wait(30),
        otp(wrong),
        wait(30),
        otp(sent),
        { op: 'resend' },
        { op: 'password' },
        wait(3 * 3600),
        { op: 'password' },
        otp(sent),
      ],
    },
    {
      name: 'resend cooldown, resend replaces the code and adds WhatsApp',
      user: 7,
      users: [sms],
      steps: [
        { op: 'password' },
        { op: 'resend' },
        wait(30),
        { op: 'resend' },
        otp({ use: 'previous-sent' }),
        wait(30),
        otp(sent),
      ],
    },
    {
      name: 'password again inside the cooldown keeps the code',
      user: 7,
      users: [sms],
      steps: [{ op: 'password' }, { op: 'password' }, otp(sent)],
    },
    {
      name: 'a user without a phone gets no code but the same message',
      user: 9,
      users: [noPhone],
      steps: [{ op: 'password' }, otp('123456')],
    },
    {
      name: 'authenticator user',
      user: 10,
      users: [totp],
      steps: [
        { op: 'password' },
        { op: 'verify', code: { use: 'totp', offset: -30 }, platform: 'totp', store: 1 },
        wait(30),
        { op: 'verify', code: { use: 'totp', offset: 0 }, platform: 'totp', store: 1 },
      ],
    },
    {
      name: 'authenticator user asks for an OTP instead',
      user: 10,
      users: [totp],
      steps: [{ op: 'password' }, { op: 'resend' }, otp(sent)],
    },
    {
      name: 'invalid input and store checks',
      user: 7,
      users: [sms],
      stores: [1, 2],
      steps: [
        { op: 'password' },
        { op: 'verify', code: sent, platform: 'otp' },
        { op: 'verify', code: sent, platform: 'otp', store: 'abc' },
        { op: 'verify', code: '', platform: 'otp', store: 1 },
        { op: 'verify', code: sent, platform: 'totp', store: 1 },
        { op: 'verify', code: sent, platform: 'sms', store: 1 },
        otp(sent, 2),
        wait(30),
        otp(sent, 1),
      ],
    },
    {
      name: 'the password step expires',
      user: 7,
      users: [sms],
      steps: [{ op: 'password' }, wait(301), otp(sent), { op: 'resend' }],
    },
    {
      name: 'the OTP expires',
      user: 7,
      users: [sms],
      steps: [{ op: 'password' }, wait(181), otp(sent)],
    },
    {
      name: 'fixed OTP for a listed user',
      user: 7,
      users: [sms],
      fixedOtp: { enabled: 1, otp: '424242', userIds: [7] },
      steps: [{ op: 'password' }, otp('424242')],
    },
    {
      name: 'authenticator user with an unusable secret',
      user: 11,
      users: [badTotp],
      steps: [{ op: 'password' }, { op: 'verify', code: '123456', platform: 'totp', store: 1 }],
    },
    {
      name: 'administrator checks in to an unassigned store',
      user: 12,
      users: [admin],
      stores: [1, 3],
      steps: [{ op: 'password' }, otp(sent, 3)],
    },
  ],
  passwords: [
    { password: 'correct-horse', encoded: pbkdf2('sha256', 'correct-horse', salt, 600000) },
    { password: 'wrong-horse', encoded: pbkdf2('sha256', 'correct-horse', salt, 600000) },
    { password: 'pässword', encoded: pbkdf2('sha256', 'pässword', salt, 600000) },
    { password: 'old', encoded: pbkdf2('sha256', 'old', salt, 216000) },
    { password: 'short-salt', encoded: pbkdf2('sha256', 'short-salt', 'short', 600000) },
    { password: 'sha1', encoded: pbkdf2('sha1', 'sha1', salt, 1000) },
    { password: 'p', encoded: scrypt('p') },
    { password: 'q', encoded: scrypt('p') },
    { password: 'p', encoded: '!unusable-password-fixture' },
    { password: 'p', encoded: '' },
    { password: 'p', encoded: 'md5$salt$hash' },
    { password: 'p', encoded: 'pbkdf2_sha256$x$salt$hash' },
    { password: 'p', encoded: 'argon2$argon2id$v=19$m=102400,t=2,p=8$c2FsdA$aGFzaA' },
    { password: '', encoded: pbkdf2('sha256', '', salt, 600000) },
  ],
};
