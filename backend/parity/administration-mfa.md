# Operator authenticator (MFA) administration

Legacy: `users/views.py:1008-1048` `AjaxActivateMfaView` (GET writes a new base32 secret to
`pos_user.mfa_hash` unless `is_mfa==1`; POST verifies the TOTP against `mfa_hash` and sets
`is_mfa=1`), and the Django `UserAdmin` `is_mfa`/`mfa_hash` fields (replace/disable).

Rewrite (W8a, schema freeze): the pending secret is written to `pos_user.mfa_hash` with `is_mfa`
unchanged, as legacy does. Rewrite-only attempt state lives in Redis:
- `pos:mfa_enroll:{operatorId}` → JSON `{id, actorId, actorVersion, operatorVersion, secretDigest,
  attempts, lastAttemptAt, verified, expiresAt}`, PX = 10 minutes. It never holds the secret. A new
  enrollment replaces it; five wrong codes delete it; a one-second retry interval applies.
- `pos:idem:mfa:{operationId}` → JSON `{actorId, operatorId, hash, result}`, EX 86400 (super-admin
  replace/disable receipts), written after commit with `SET NX`.
- Writers hold `pos:lock:admin:operators`.
- Confirmation refuses a changed target (`MFA_SETTINGS_CHANGED`) or a revoked/changed actor
  authentication version (`MFA_ENROLLMENT_EXPIRED`).
`pos_rewrite_operator_mfa_enrollments` / `_mutations` are no longer used (the deprecated
`operatorMfaEnrollments` export stays only for `src/auth/revocation.ts`).

| Case | Legacy (HTTP 200 body) | Rewrite |
|---|---|---|
| Already active | `{status:400, message:"Already Activated"}` | 409 "Already Activated" |
| Enrollment created | "Hash Has been generated, scan the above QR Code from you authenticator app and enter the otp." | 201 `{id, expiresAt, qrDataUrl}` (QR rendered locally, not via Google Charts) |
| Wrong code | `{status:400, message:"Wrong OTP, Enter correct OTP"}` | 422 "Wrong OTP, Enter correct OTP" |
| Verified | "Hash has been verified, MFA activated on your account" | 200, same text |
| Missing user / OTP | "Please Provide Valid User." / "Please Provide Valid OTP." | 404 "Operator was not found." / 400 request validation |
