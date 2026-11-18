import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError } from '../domain/errors.js';
import type { AuthEventLogger } from './events.js';
import type { IdentityService, LoginStore } from './identity.js';
import type { LoginOtpDelivery } from './delivery.js';
import type { FixedOtpSettings, LoginOtpState } from './login-otp.js';
import { lockedMessage, retryWaitMessage } from './login-otp.js';
import type { PendingLogin, PendingLogins } from './login-pending.js';
import type { SessionAccount } from './sessions.js';
import { totpSecretUsable, verifyTotp } from './totp.js';

export type { PendingLogin } from './login-pending.js';
/** Response of the password step and of the pending-login read (legacy login.html context). */
export interface LoginChallengeDto {
  authentication: 'challenge';
  /** legacy `is_mfa`: TOTP users see the authenticator prompt and may request an OTP. */
  method: 'otp' | 'totp';
  /** legacy `otp_method` label: "SMS" or "Email". */
  otpChannel: 'sms' | 'email';
  /** legacy `mfa_message`. */
  message: string;
  /** True when the OTP step is locked (the password step still succeeds, as in legacy). */
  locked: boolean;
  expiresAt: number;
  stores: LoginStore[];
}
/** Raw OTP-step body, validated for shape only so checks run in the legacy order. */
export const verificationInput = z
  .object({
    code: z.string().max(64).optional(),
    factor: z.string().max(16).optional(),
    storeId: z
      .union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.string().max(24)])
      .optional(),
  })
  .strict();
const checkInStore = z.union([
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).transform(String),
  z
    .string()
    .trim()
    .regex(/^\d{1,19}$/)
    .transform((value) => BigInt(value).toString()),
]);
export interface LoginChallengeOptions {
  now?: () => number;
  checkIn: {
    allowed(userId: string, role: number, storeId: string): Promise<boolean>;
  };
}
export const expiredLogin = () =>
  new AppError(
    401,
    'LOGIN_SESSION_EXPIRED',
    'Your sign-in step has expired. Enter your password again.',
  );
export function loginChallengeService(
  config: Config,
  identity: IdentityService,
  pending: PendingLogins,
  otp: LoginOtpState,
  delivery: LoginOtpDelivery,
  fixedOtp: FixedOtpSettings,
  log: AuthEventLogger,
  options: LoginChallengeOptions,
) {
  const now = options.now ?? Date.now;
  const locked = () => new AppError(423, 'LOGIN_LOCKED', lockedMessage(config));
  const channel = (row: SessionAccount): 'sms' | 'email' =>
    row.otp_method === 1 ? 'sms' : 'email';
  /** legacy AjaxSendLoginOtpView otp_method_message. */
  const sentMessage = (row: SessionAccount) =>
    row.otp_method === 1
      ? 'One Time Password (OTP) has been sent on your registered mobile number.'
      : 'One Time Password (OTP) has been sent on your registered email address';
  /** legacy core/tasks.py send_login_otp, run synchronously in the request. */
  async function sendLoginOtp(row: SessionAccount, resend: boolean) {
    const userId = String(row.id);
    if (!row.phone) {
      // Legacy stores nothing and sends nothing, even for email users, yet reports "sent".
      log({ eventId: 'identity.login-otp.contact-missing', userId, level: 'warn' });
      return;
    }
    if (fixedOtp.appliesTo(userId)) {
      await otp.store(userId, fixedOtp.otp);
      log({ eventId: 'identity.login-otp.fixed-issued', userId, level: 'warn' });
      return;
    }
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    await otp.store(userId, code);
    log({ eventId: 'identity.login-otp.issued', userId });
    await delivery.deliver(
      {
        userId,
        phone: row.phone,
        contactEmail: row.contact_email,
        firstName: row.first_name ?? '',
        otpMethod: row.otp_method,
      },
      code,
      resend,
    );
  }
  async function pendingAccount(credential: PendingLogin) {
    const userId = await pending.userId(credential);
    const row = userId ? await identity.activeAccount(userId) : null;
    if (!row) throw expiredLogin();
    return row;
  }
  async function view(
    credential: PendingLogin,
    row: SessionAccount,
    message: string,
    isLocked: boolean,
  ): Promise<LoginChallengeDto> {
    return {
      authentication: 'challenge',
      method: row.is_mfa ? 'totp' : 'otp',
      otpChannel: channel(row),
      message,
      locked: isLocked,
      expiresAt: credential.expires,
      stores: await identity.loginStores(row),
    };
  }
  /** legacy mfa_message for the password step (users/views.py:118-127). */
  async function stepMessage(row: SessionAccount) {
    if (row.is_mfa)
      return {
        message:
          'Open your Authenticator app on your mobile device. Enter the OTP displayed on your Authenticator app, then click on Login',
        isLocked: false,
      };
    if (await otp.isLocked(String(row.id)))
      return { message: lockedMessage(config), isLocked: true };
    return {
      message:
        row.otp_method === 1
          ? 'One Time Password (OTP) has been sent on your registered mobile number'
          : 'One Time Password (OTP) has been sent on your registered email address',
      isLocked: false,
    };
  }
  return {
    /** Password step succeeded: bind the user, and for non-MFA users send the first OTP. */
    async begin(row: SessionAccount) {
      const userId = String(row.id),
        credential = await pending.begin(userId);
      if (!row.is_mfa && !(await otp.isLocked(userId))) {
        // Re-submitting the password inside the cooldown keeps the OTP already sent,
        // unless that OTP is gone (users/views.py:128-134).
        if ((await otp.claimResendSlot(userId)) || !(await otp.hasPending(userId)))
          await sendLoginOtp(row, false);
        await pending.markOtpSent(credential);
      }
      const step = await stepMessage(row);
      return { credential, view: await view(credential, row, step.message, step.isLocked) };
    },
    async describe(credential: PendingLogin, identify?: (userId: string) => void) {
      const row = await pendingAccount(credential);
      identify?.(String(row.id));
      const step = await stepMessage(row);
      return view(credential, row, step.message, step.isLocked);
    },
    /** legacy AjaxSendLoginOtpView (users/views.py:259-282). */
    async resend(credential: PendingLogin, identify?: (userId: string) => void) {
      const row = await pendingAccount(credential),
        userId = String(row.id);
      identify?.(userId);
      if (await otp.isLocked(userId)) throw locked();
      if (!(await otp.claimResendSlot(userId)))
        throw new AppError(
          429,
          'LOGIN_RESEND_WAIT',
          'Please wait a few seconds before requesting another OTP.',
        );
      await sendLoginOtp(row, await pending.markOtpSent(credential));
      return { message: 'OTP has been sent.', otpMethodMessage: sentMessage(row) };
    },
    /** legacy AjaxMfaLoginView (users/views.py:181-257), in the same order. */
    async verify(
      credential: PendingLogin,
      input: z.infer<typeof verificationInput>,
      identify?: (userId: string) => void,
    ) {
      const store = checkInStore.safeParse(input.storeId);
      if (!store.success)
        throw new AppError(400, 'CHECK_IN_STORE_REQUIRED', 'Please select a store to check in to.');
      const row = await pendingAccount(credential),
        userId = String(row.id);
      identify?.(userId);
      if (await otp.isLocked(userId)) throw locked();
      const code = input.code ?? '',
        useTotp = input.factor === 'totp' && Boolean(row.is_mfa);
      if (!code || !(useTotp || input.factor === 'otp'))
        throw new AppError(400, 'OTP_INPUT_INVALID', 'Enter the OTP you received, then try again.');
      if (!(await otp.claimAttempt(userId)))
        throw new AppError(429, 'LOGIN_RETRY_WAIT', retryWaitMessage(config));
      if (await otp.isLocked(userId)) throw locked();
      let verified: boolean;
      if (useTotp) {
        if (!totpSecretUsable(row.mfa_hash)) {
          log({ eventId: 'identity.login-otp.totp-unavailable', userId, level: 'error' });
          throw new AppError(
            409,
            'TOTP_NOT_CONFIGURED',
            'Authenticator sign-in is not set up correctly for this account. Request an OTP instead, or ask an administrator to reset MFA.',
          );
        }
        verified = verifyTotp(row.mfa_hash, code, now());
      } else verified = await otp.check(userId, code);
      if (!verified) {
        const failure = await otp.recordFailure(userId);
        log({ eventId: 'identity.login-otp.verification-failed', userId, level: 'warn' });
        if (!failure.attemptsLeft) {
          log({ eventId: 'identity.login-otp.locked', userId, level: 'error' });
          delivery.alert(
            `:lock: Staff login: user_id \`${userId}\` locked for ${Math.floor(config.LOGIN_OTP_LOCK_SECONDS / 3600)}h after ${failure.failures} wrong ${useTotp ? 'TOTP' : 'OTP'} attempts.`,
          );
          throw locked();
        }
        throw new AppError(
          401,
          'OTP_INVALID',
          `Wrong OTP. ${failure.attemptsLeft} attempt${failure.attemptsLeft > 1 ? 's' : ''} left. ${retryWaitMessage(config)}`,
        );
      }
      await otp.releaseAttempt(userId);
      if (!(await options.checkIn.allowed(userId, row.role, store.data)))
        throw new AppError(403, 'CHECK_IN_STORE_DENIED', 'You are not assigned to this store.');
      await otp.resetFailures(userId);
      await pending.discard(credential);
      return { row, storeId: store.data };
    },
    discard: (credential: PendingLogin) => pending.discard(credential),
  };
}
export type LoginChallengeService = ReturnType<typeof loginChallengeService>;
