# W3 report — authentication and sessions re-homed onto Redis and production tables

Branch `w3/auth-rehome` (from `7ebed66`). Spec: `phase-c-auth-redis-spec.md` (decisions D1–D7 as resolved in the brief),
`security-decisions.md` S1–S9. Legacy oracle `backend-pos-web@78d5b63`.

Status: implementation complete for the W3 scope below. This is **not** parity certification: the MySQL-backed
paths (`identity.authenticate`, rehash write, store eligibility, `last_login`) were not run against MySQL (no local
instance); see "Remaining gaps".

## What changed

**Login (legacy `CustomLoginView` → `AjaxSendLoginOtpView` → `AjaxMfaLoginView`)** — `src/auth/identity.ts`, `mfa.ts`, `routes.ts`
- Password step = Django `authenticate()`: EmailBackend (`username LIKE x OR email LIKE x`, Django `iexact` escaping,
  NFKC + strip of the username) then ModelBackend (exact username). Each candidate's password is verified once (S7).
  The multi-match branch now verifies the password and `is_active` of the lowest-id exact-email row (S1).
  Unknown users cost one 600k PBKDF2.
- Django 4.2 hashers (`crypto.ts`): verify `pbkdf2_sha256`, `pbkdf2_sha1`, `scrypt`; new hashes
  `pbkdf2_sha256$600000$<22 alnum>$…`; rehash and save `pos_user.password` on a correct password when Django's
  `must_update` would (iterations ≠ 600k, salt < 128 bits, other hasher) (S6). The 1M setting is gone.
- OTP: 6 digits from `crypto.randomInt`, stored as `HMAC-SHA256(key derived from SESSION_SECRET, uid:otp)` (S3),
  legacy semantics for failure window, lockout, one attempt per retry interval, resend cooldown, "resend" = second send
  of a login attempt, password re-submit inside the cooldown keeps the existing OTP, no phone → nothing stored.
- Fixed OTP: `LOGIN_FIXED_OTP_ENABLED` (Python `int()`), `LOGIN_FIXED_OTP` (stripped), `LOGIN_FIXED_OTP_USER_IDS`
  (comma list, `strip().isdigit()` entries), checked after the phone check, stored hashed, nothing sent.
- Delivery (`delivery.ts`): email when `otp_method == 2` and `contact_email`, SMS when `otp_method == 1`, nothing
  otherwise; WhatsApp only on resend, off the request path, Slack alert with masked phone when unconfirmed. Provider
  failures are logged and swallowed (legacy). Adapters: `live` and `sandbox` (`LOGIN_OTP_DELIVERY`, default sandbox
  outside production, refused in production). Tests use the sandbox or a stub `fetch` only.
- Lockout alert: legacy text `:lock: *[SERVICE_NAME]* Staff login: user_id \`N\` locked for 3h after 3 wrong OTP attempts.`
  to `LOGIN_SECURITY_SLACK_WEBHOOK` (fallback `SLACK_WHATSAPP_ALERT_WEBHOOK`), fire-and-forget. Legacy's lockout
  text has no phone; the WhatsApp-failure alert carries the legacy masked phone (`98****10`). No OTP anywhere.
- TOTP (`totp.ts`): `pos_user.mfa_hash` / `is_mfa`, pyotp parameters (SHA1, 6, 30 s, window 0, NFKC compare,
  case-insensitive base32). NULL/invalid secret → 409 instead of legacy 500.
- Check-in at login (`checkin.ts`): legacy `user_can_check_in` (store 0 "Not at the store" allowed, inactive stores
  allowed, STORE/CORE_WAREHOUSE, `user_stores` unless role 1) after the code is verified; legacy
  `set_check_in_store` writes (`check_in_{uid}` = Python `json.dumps([id, name])`, `check_in_list_{store}`) in one MULTI.
- Every auth route validates params, query, headers and body with zod; statuses per S4; message map appended to
  `phase-c-auth-redis-spec.md`. Structured identity events (`events.ts`) carry eventId, eventInstanceId, module,
  resource, requestId/traceId and userId only. Per-route rate limits removed (spec §4.4 item 7).

**Sessions** (`sessions.ts`, `session-cookies.ts`)
- `pos:session:{uuid}` with `EX` = seconds to 23:59:59 business-local (legacy `time_until_end_of_day() - 1`, min 1).
- Each request: Redis read, timing-safe secret check, `pos_user` re-read on the writer, `is_active` and an HMAC of the
  current password hash (Django `_auth_user_hash` analogue). Nothing else revokes (S5, D1/D6): no epochs, no check-out
  revocation. Self password change re-arms the current session (`update_session_auth_hash`); other sessions end.
- Cookie `pos_session` (sealed `{id, sessionId, secret, expires}`): HttpOnly, SameSite=Lax, Secure unless
  `SESSION_COOKIE_SECURE=false` (refused in production). Login deletes the browser's previous session (Django `cycle_key`).
- Logout: delete the session, `SCAN check_in_list_*` + `LREM uid` (legacy used `KEYS`), keep `check_in_{uid}`.
- `sessions.alive(sessionId, userId, tx)` lets grants tied to a POS session (website handoff) check it by id.

**Permissions**: principal = `pos_user` role/user_type + `user_stores`, re-read per request (spec §3). Unchanged
`requireStore`/`requireRole` semantics in `domain/access.ts`.

**Device handoff (S2, S9)**: `auth_qr_{uid}` unchanged (legacy key/value); hardening keys renamed to `pos:auth_qr:*`;
binding switched from auth epochs to the password hash; Redis comes from `REDIS_URL` (`POS_DEVICE_HANDOFF_REDIS_URL`
removed). QR codes are issued only for the signed-in operator (S2 for `AjaxGenAuthQR`). Added the legacy MPosLogin
email+password branch (S16).

**Profile**: no registry lock, no epoch invalidation; duplicate contact → 409 from the unique keys. Profile/cover
image uploads reserved in Redis (`image-reservations.ts`), written synchronously to `pos_user.profile_image/cover_image`;
no cleanup worker (legacy never deletes replaced files). Upload is still verified as an image (Django ImageField does).

**Removed**: tables `pos_rewrite_sessions`, `pos_rewrite_login_challenges`, `pos_rewrite_login_security`,
`pos_rewrite_login_security_alerts`, `pos_rewrite_operator_auth_epochs`, `pos_rewrite_profile_uploads`,
`pos_rewrite_profile_media_jobs` (Drizzle defs, `migrations/0002–0006`, registrations); `security-worker*`,
`profile-media-worker*`, `operator-binding.ts` (x-operator-id 409 hook), `worker:security` and `worker:profile-media`
scripts, `memorySessions`, `identity.byVerifiedEmail`, `OTP_DELIVERY_UNCERTAIN`, the 6-digit input regex for login codes.

**Frontend**: `login.tsx` shows the legacy step messages, lock state and the "Not at the store" option; schema updated.

## Redis key families

All in `REDIS_URL` database 0. Production Redis must be `maxmemory-policy noeviction` (documented in `.env.example`).

| Key | Value | TTL | Written by |
|---|---|---|---|
| `pos:login_otp:{uid}` | hex HMAC-SHA256 of `uid:otp` | `LOGIN_OTP_EXPIRY` (180 s) | password step / resend; Lua compare-and-delete on use |
| `pos:login_otp_fail:{uid}` | integer | `LOGIN_OTP_LOCK_SECONDS` (10 800 s) from first failure | `MULTI{SET 0 EX NX; INCR}` |
| `pos:login_otp_lock:{uid}` | `1` | `LOGIN_OTP_LOCK_SECONDS` | `MULTI{SET EX; DEL otp fail}` on last failure |
| `pos:login_otp_wait:{uid}` | `1` | `LOGIN_OTP_RETRY_INTERVAL` (30 s) | `SET NX EX` before each check; `DEL` on success |
| `pos:login_otp_resend:{uid}` | `1` | `LOGIN_OTP_RESEND_COOLDOWN` (30 s) | `SET NX EX` |
| `pos:login_pending:{uuid}` | JSON `{userId, proofHash, startedAt}` | `LOGIN_MFA_PENDING_TTL` (300 s), not refreshed | password step, `SET NX EX` |
| `pos:login_pending_sent:{uuid}` | `0`/`1` | same as pending | Lua get-and-set `KEEPTTL` |
| `pos:session:{uuid}` | JSON `{userId, secretHash, authHash, expirySeconds, createdAt}` | to 23:59:59 local | login; `SET XX KEEPTTL` on self password change |
| `check_in_{uid}` (legacy) | `[store_id, "name"]` Python `json.dumps` | to 23:59:59 local | login |
| `check_in_list_{store}` (legacy) | LIST of uids | to 23:59:59 local | login (LREM all + LPUSH + EXPIRE); logout LREM |
| `auth_qr_{uid}` (legacy) | base32 TOTP secret | `POS_AUTH_USER_SECRET_EXP` (1800 s) | QR issue / rotate on mPOS login |
| `pos:auth_qr:version:{uid}` | HMAC of `id:password-hash` | same as `auth_qr_` | S9 |
| `pos:auth_qr:attempt:{hmac(email)}` | integer (≤ 5) | `POS_AUTH_QR_EXP_SEC` (60 s) | S9 |
| `pos:auth_qr:used:{hmac}` | `1` | 2 × `POS_AUTH_QR_EXP_SEC` | S9 single use |
| `pos:profile_upload:{uuid}` | JSON `{ownerId, kind, objectKey, contentType, size, checksum, ownerRevision, expiresAt}` | 16 min | profile/operator image reservation |

## Shared-file edits

- `src/app.ts`: auth wiring (Redis port, sessions, delivery, OTP state, check-in, device handoff, profile media),
  `buildApp` option `authRedis` (test seam), `operatorImageReservations`, website-handoff session probe; removed
  operator-binding registration.
- `src/config.ts`: `SESSION_COOKIE_SECURE` (default true); production requires Secure cookies and `REDIS_URL`.
- `.env.example`: `REDIS_URL` (+ noeviction), `SESSION_COOKIE_SECURE`, `LOGIN_FIXED_OTP_*`, `LOGIN_OTP_DELIVERY`,
  `SLACK_WHATSAPP_ALERT_WEBHOOK`, `SERVICE_NAME`; removed `AUTH_SECURITY_*`, `POS_DEVICE_HANDOFF_REDIS_URL`.
- `src/db/migrations.ts` (5 registrations removed), `package.json` (2 worker scripts removed), `deployment.md`
  (security-worker paragraph replaced).

## Caller fixes (outside `src/auth`)

- `modules/administration/operator-admin.ts`: images via `redisImageService` + option `operatorImageReservations`.
- `modules/checkout/payments/provider-evidence.ts`: dropped the `FOR SHARE` read of the epoch row.
- `modules/customer-website-handoff/{authority,service,index}.ts`: replaced the `pos_rewrite_sessions` read with an
  injected `sessions.alive` probe.
- Compatible exports kept: `revocation.ts` (`currentAuthenticationVersion` now table-free, `invalidateOperator…`
  no-ops), `credentialVersion`, `verifyDjangoPassword`, `djangoPasswordHash` (now 600k), `createOtpTransport`,
  `phoneOtpDelivery`, `verifyTotp` (pyotp semantics), `authenticated`.
- Tests: removed deleted-SQL paths from 12 MySQL fixtures; `store-default-operators`, `online-detail`,
  `website-handoff/service` now use `tests/helpers/auth-sessions.ts`; `administration/mysql.integration`,
  `checkin-lock-order` import `tests/helpers/retired-auth.ts`, which fails loudly when a case still uses a retired table.

## Tests

New: `tests/auth/login-flow.test.ts`, `redis-port.test.ts`, `legacy-compat.test.ts`; rewritten `sessions.test.ts`,
`otp-delivery.test.ts`, `device-handoff*.test.ts`. Redis tests run on a private loopback `redis-server` and on the
in-process port. Removed: `auth.mysql.integration.test.ts`, `operator-binding.test.ts` (retired tables/feature).
Backend: tsc, eslint clean; vitest 173 files passed, 66 skipped (MySQL-gated). Frontend: tsc, eslint clean; vitest passed.

## Remaining gaps

1. Not run against MySQL: `identity.authenticate` (LIKE/collation, S1 candidates, rehash compare-and-set),
   `storeDirectory`, `recordLogin`. Needs an isolated MySQL test before parity is claimed.
2. Check-in: login/logout write legacy keys, but `modules/administration/checkins.ts` (W5) still reads
   `pos_rewrite_operator_checkins`; an interim mirror calls `checkins.set` (store 0 → `clear`) and logs failures.
   Remove the mirror once W5 reads the legacy keys. The change-check-in endpoint is W5's.
3. Roles outside 1–5 or user types outside 1–2 are refused at the password step (403): `Principal` cannot represent
   them. Legacy has no such gate. Production values are not verified.
4. `hla_store_ids` session data (hyperlocal filter) not implemented; owner: hyperlocal dashboard.
5. Cut-over: legacy `django_session` sessions and plaintext `login_otp:*` codes are not honoured; staff sign in again.
6. DEMO_MODE login (`/api/v1/auth/demo-sessions`, `demo-session.ts`, in-process Redis) is kept only because six test
   files and `tools/container-fixture.cjs` depend on it; delete with DEMO_MODE.
7. Owner rewrites needed (MySQL-gated, currently skipped here): epoch-based cases in
   `tests/administration/mysql.integration.test.ts`, `checkin-lock-order.mysql.test.ts`,
   `application-links.mysql.integration.test.ts` ("does not revive … after disable and restoration"),
   `dashboard/service.mysql.test.ts`, `invoice-documents/mysql.integration.test.ts`,
   `checkout-order-copy/customer-authority.mysql.test.ts`, `customer-otp`/`customer-contacts` service tests,
   `return-window/native-fixture.ts`, `tools/dashboard/fixture.ts` (they create/bump `pos_rewrite_operator_auth_epochs`).
8. MFA enrolment still uses W5's `pos_rewrite_operator_mfa_enrollments`.
9. `LOGIN_FIXED_OTP_USER_IDS` entries with non-ASCII digits (accepted by Python `isdigit()`) are dropped.
10. W7 schema (`2921ac0`): `pos_user.first_name/last_name` nullable, `last_login` timestamp, `stores.store_name` not
    null, `stores.type` enum. `src/auth`, `src/redis` and `app.ts` type-check against both the current and the
    `2921ac0` `legacy-schema.ts` (`password-policy.ts` now accepts nullable names). Other modules were not checked.
11. S2: `AjaxGenAuthQR` fixed here. Rewrite counterparts of `AjaxUpdateEndUserDataView` (customer-insights) and
    `AjaxGenMposDownloadQR` (application-links issue routes) require a session; `MposUserDownloadApp`/`UserToApp`
    counterparts are device-facing and gated by single-use capabilities issued to an authenticated operator. Owned elsewhere.

## New security decisions

S11–S16 appended to `security-decisions.md` (POST instead of GET for Gupshup, escaped OTP email name with timeout,
webhook/Redis transport rules, fail-closed unknown hashes with single dummy hash, production guards, guarded mPOS
password branch). S1–S3, S5–S7, S9 marked implemented; S4 and S8 implemented for auth.
