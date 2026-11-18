/**
 * Redis key families owned by authentication. Rewrite-owned keys use the `pos:` prefix;
 * legacy keys are reused verbatim only where the rewrite serves the same legacy flow and
 * a running legacy app reads them (check-in lists, mPOS QR secret).
 * TTLs and value shapes are documented in backend/parity/w3-report.md.
 */
export const authKeys = {
  /** HMAC-SHA256 of the current login OTP (S3). Legacy `login_otp:{uid}` held plaintext. */
  otp: (userId: string) => `pos:login_otp:${userId}`,
  /** Wrong OTP/TOTP count, window starts at the first failure (legacy `login_otp_fail:`). */
  failures: (userId: string) => `pos:login_otp_fail:${userId}`,
  /** Lockout marker (legacy `login_otp_lock:`). */
  lock: (userId: string) => `pos:login_otp_lock:${userId}`,
  /** One verification attempt per retry interval (legacy `login_otp_wait:`). */
  wait: (userId: string) => `pos:login_otp_wait:${userId}`,
  /** Resend cooldown (legacy `login_otp_resend:`). */
  resend: (userId: string) => `pos:login_otp_resend:${userId}`,
  /** Password-step binding; replaces the legacy anonymous-session keys `pending_mfa_*`. */
  pending: (pendingId: string) => `pos:login_pending:${pendingId}`,
  /** Legacy `pending_mfa_otp_sent`: whether this login attempt already received an OTP. */
  pendingSent: (pendingId: string) => `pos:login_pending_sent:${pendingId}`,
  /** Authenticated session; replaces the legacy `django_session` row. */
  session: (sessionId: string) => `pos:session:${sessionId}`,
  /** Legacy check-in keys (helpers/helpers.py:794-812), shared with a running legacy app. */
  checkIn: (userId: string) => `check_in_${userId}`,
  checkInList: (storeId: string) => `check_in_list_${storeId}`,
  checkInListPattern: 'check_in_list_*',
  /** Legacy mPOS QR TOTP secret (users/views.py:1161-1169). */
  deviceSecret: (userId: string) => `auth_qr_${userId}`,
  /** S9 hardening: binds the QR secret to the operator's current password hash. */
  deviceVersion: (userId: string) => `pos:auth_qr:version:${userId}`,
  /** S9 hardening: per-email verification attempts inside one QR period. */
  deviceAttempt: (digest: string) => `pos:auth_qr:attempt:${digest}`,
  /** S9 hardening: a verified QR code is single use. */
  deviceUsed: (digest: string) => `pos:auth_qr:used:${digest}`,
  /** Signed profile-image upload reservation (replaces pos_rewrite_profile_uploads). */
  profileUpload: (uploadId: string) => `pos:profile_upload:${uploadId}`,
} as const;
