# Authentication evidence and remaining release work

Source: `users/login_otp.py`, `users/views.py`, `users/tests.py`, and Django
identity/session settings at source commit
`78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.

Every password login requires delivered OTP or TOTP before a full session.
Password proof is server-bound to one pending account; clients cannot choose a
verification user ID. A correct code is consumed before store authorization,
matching the source's denied-store behavior. Failed attempts are per account
across challenges/resends, use a fixed first-failure window, enforce a retry
pause and resend cooldown, and lock after the configured threshold. SQL row
locks serialize competing verifications. Default source limits are preserved.

Identity, role/store assignment, credential fingerprints, session revocation
and financial check-in use the writer. Store/counter check-in shares the OTP
transaction, so no nested transaction or successful session can bypass it.
Sessions expire at the business-day boundary; password, MFA/contact, role and
user-type changes invalidate their credential version. Cookies are sealed,
HTTP-only and secure in production; stored session secrets and delivered OTPs
are hashes rather than plaintext.

The security worker persists one nonfinancial alert with the lockout transaction,
claims it with a bounded lease, retries safely with backoff, retains failed work
for explicit recovery and prunes expired proof/session rows in bounded batches.
Its Slack delivery is at least once, with a stable alert ID for duplicate
recognition. Delivery never blocks the login response. Logs contain identifiers
and static outcomes only.

`tests/auth.mysql.integration.test.ts` uses a uniquely named localhost-only
database and synthetic identities. It checks password-only denial, OTP/store
binding, global failures, lock/cooldown, concurrent code use, TOTP, credential
change invalidation, delivery uncertainty, expiry, input validation, competing
alert workers, retry/log privacy, cleanup and daily-report rollout access.
`tests/otp-delivery.test.ts` verifies body-only provider credentials, bounded
responses, escaped email content and explicit acknowledgments. The browser
login test verifies the two-stage UI with a fixture boundary; it is not live
SMS/email or identity-provider evidence.

Intentional security changes: no legacy fixed-OTP override; strict six ASCII
digits at the new API boundary; unsupported password hash algorithms fail
closed; provider credentials/contact/OTP are sent in HTTPS POST bodies instead
of URLs; persistent revoked sessions are rejected server-side. These changes
need review alongside a complete source request/response parity certificate.

Google and desktop single sign-on were removed (19 November 2026). Login is the
legacy password plus OTP/TOTP flow. Existing enabled account roles/store
assignments remain authoritative. Aggregate-only read-only verification found
all 1,237 active accounts use `pbkdf2_sha256`, and all active user types are 1/2;
no hashes, names or contact values were returned. Evidence is
`evidence/auth-password-formats.json`. No production lockout,
Slack message, OTP delivery or identity-provider login was executed by these
tests. Full authentication route certification is still pending.
