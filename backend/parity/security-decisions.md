# Security decisions (for user review)

The user delegated security decisions to the primary agent on 19 November 2026:
"I don't need security issues — these security decisions you can take and keep them in a separate file so I can review later."

**Rule:**
- Where copying legacy exactly would copy a security weakness, the rewrite takes the secure option. Business behaviour stays otherwise identical.
- Each decision is listed here with its legacy source (`backend-pos-web@78d5b63`) and status.
- Review state: **pending user review**.

| # | Area | Legacy behaviour | Rewrite decision | Decided by | Status |
|---|------|------------------|------------------|------------|--------|
| S1 | Login, multi-match | `users/auth_backends.py:14-15`: if the login string matches more than one `pos_user` row, the lowest-id user whose email equals the input is returned **without a password check** | Always verify the password and `is_active` for the resolved user. Ambiguous matches resolve the same way legacy does (lowest id with exact email) but must pass `check_password` | User (19 Nov) | To implement (W3) |
| S2 | Unauthenticated views | `users/views.py:1214-1236` (`AjaxGenAuthQR`) and the four other views in `phase-c-auth-redis-spec.md` §3.1: the MRO order makes `LoginRequiredMixin` inert, so anyone can generate any user's mPOS TOTP | Require an authenticated session plus the permission the view was meant to enforce. Generating a QR for another user needs the same authority as legacy admin user management | User (19 Nov) | To implement (W3) |
| S3 | Login OTP at rest | Plaintext 6-digit OTP at Redis `login_otp:{uid}` (`users/login_otp.py:101-103`) | Store `HMAC-SHA256(server secret, uid + ":" + otp)` at `pos:login_otp:{uid}`, with the same TTL (`LOGIN_OTP_EXPIRY`, default 180 s). Compare in constant time. The fixed OTP (`LOGIN_FIXED_OTP_*`) is stored hashed the same way. The other counters keep legacy semantics under `pos:` names. A plain SHA-256 is not used, because a 6-digit space is trivially reversible. Consequence: OTPs issued by a still-running legacy app do not verify in the rewrite, which affects at most one 180 s window during cut-over | User (19 Nov) | To implement (W3) |
| S4 | HTTP status and messages | Several endpoints return HTTP 200 with `"status": 400/401` in the body (`users/views.py:206,230`, MFA enrolment), using terse messages | Return the HTTP status that fits the scenario: 400 validation, 401 unauthenticated or expired, 403 forbidden, 404 not found, 409 conflict, 423 locked, 429 rate-limited or cooldown. Use clear, actionable messages. The legacy message for each case is recorded next to the new one in the module's parity notes | User (19 Nov) | Applies to all rewrite APIs (frontend is new) |
| S5 | Session revocation | Revoked on password change or deactivation (per-request `is_active` check) | Same as legacy. The rewrite's extra auth epochs and check-out revocation are dropped | User (19 Nov) | To implement (W3) |
| S6 | Password hashing | Django 4.2 hashers: PBKDF2-SHA256 at 600 000 iterations for new hashes, with rehash on login when parameters differ. Production has 1 332 hashes at 600k, 442 at 216k and 1 at 1M (the rewrite's old setting), all `pbkdf2_sha256` | Verify every Django-supported encoded format. New and rehashed passwords use `pbkdf2_sha256$600000$…`, byte-compatible with Django 4.2, so legacy and the rewrite accept each other's hashes. On a successful login with outdated parameters, rehash and update `pos_user.password`, as Django does. The rewrite's 1M setting is dropped, because otherwise the two systems would keep rehashing each other's passwords | Agent (delegated) | To implement (W3) |
| S7 | Double authentication | `users/views.py:110` runs PBKDF2 twice per login | Single verification. Same outcome, half the CPU | Agent (delegated) | To implement (W3) |
| S8 | OTP and secret logging | OTP values and phone numbers appear in some legacy log lines and Slack alerts | No OTP, password, TOTP secret, phone or email in logs or alerts. Phones are masked as legacy masks them in Slack | Agent (delegated) | Applies everywhere |
| S9 | Device handoff | Rewrite-only hardening around mPOS QR login (`phase-c-auth-redis-spec.md` §4.4 item 14) | Keep the hardening: single use, short TTL, bound to the requesting operator. This tightens security and adds no new business feature | Agent (delegated) | To implement (W3) |
| S10 | Live-data verification of hash formats | — | Checked by a read-only aggregate query, counting algorithm/iteration prefixes only, with no hashes or PII read | Agent | Done (19 Nov) |

Later security findings (checkout, orders, admin, jobs) are appended here as S11 onwards.
