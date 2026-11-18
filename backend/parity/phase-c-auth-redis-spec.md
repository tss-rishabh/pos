# Phase C — Auth re-home spec (W3): legacy login, sessions, permissions → Redis

Status: read-only spec. Changes no code. Implementer: W3 (`backend/src/auth/**`).

Citation conventions:
- **Legacy** paths are relative to the pinned export of `backend-pos-web@78d5b63`
  (e.g. `users/views.py:104`). No other legacy checkout was read.
- **Rewrite** paths are relative to `backend/` on `refactor/single-stack-schema-freeze` @ `324d62d`
  (e.g. `src/auth/mfa.ts:141`). `324d62d` is the W2 merge that already removed Google SSO, desktop SSO, screening,
  CSV order import and the compatibility tree; it landed while this spec was being written, and every rewrite
  line number below was re-checked against it.
- **Production DDL** is `tests/golden/schema/production-schema.json` (captured 2026-11-18, MySQL 8.0.39).
- Versions (legacy `requirements.txt`): Django 4.2.5 (`:28`), pyotp 2.9.0 (`:68`), redis-py 4.6.0 (`:72`),
  celery 5.3.1 (`:12`). Statements about Django defaults refer to Django 4.2.
- Anything not determinable from these sources is marked **UNKNOWN**.

Hard rules applied: no new tables/columns/indexes; ephemeral state in Redis; legacy key names reused verbatim
where the flow is the same legacy flow, otherwise prefix `pos:`; Google SSO and desktop SSO are deleted
(another agent owns that deletion); login = legacy password + OTP/TOTP only.

---

## 1. Legacy login flow, end to end

### 1.1 Routes and wiring

| Step | Legacy URL | View | Citation |
|---|---|---|---|
| Login page / password step | `GET/POST /users/login/` and `GET/POST /` | `CustomLoginView` | `users/urls.py:8`, `POSAdmin/urls.py:11`, `users/views.py:101-166` |
| Send / resend OTP | `POST /users/ajax-send-login-otp/` | `AjaxSendLoginOtpView` | `users/urls.py:9`, `users/views.py:259-282` |
| OTP/TOTP verify + check-in + login | `POST /users/ajax-mfa-login/` | `AjaxMfaLoginView` | `users/urls.py:10`, `users/views.py:181-257` |
| Logout | `GET /users/logout/` | `CustomLogoutView` | `users/urls.py:11`, `users/views.py:169-178` |
| Password change | `/users/password-change/` | `CustomPasswordChangeView` | `users/urls.py:13`, `users/views.py:508-516` |
| TOTP enrolment (admin for a user) | `GET /users/<pk>/activate-mfa/`, `POST /users/activate-mfa/` | `AjaxActivateMfaView` | `users/urls.py:26-27`, `users/views.py:1007-1048` |
| mPOS app login (QR TOTP) | `POST /users/mpos-login/` | `MPosLogin` | `users/urls.py:30`, `users/views.py:1116-1169` |
| mPOS QR page / QR JSON | `/users/auth-qr-gen/`, `/users/ajax-gen-auth-qr/` | `AuthQRGen`, `AjaxGenAuthQR` | `users/urls.py:33-34`, `users/views.py:1171-1255` |

All POST views except `MPosLogin` (`users/views.py:1116` `csrf_exempt`) are CSRF-protected by
`CsrfViewMiddleware` (`POSAdmin/settings.py:84`). Logout is a GET (no CSRF).

### 1.2 Password step — request fields

`CustomLoginView.post` (`users/views.py:104-146`) binds Django's `AuthenticationForm(data=request.POST)`
(`users/views.py:105`):

| Field | Rules | Source |
|---|---|---|
| `username` | required; max length = `pos_user.username` max_length = 150 (Django `AuthenticationForm.__init__` copies the USERNAME_FIELD max_length); may be a username **or** an email (see backend) | `users/views.py:108`; DDL `pos_user.username varchar(150)` |
| `password` | required; not stripped (`strip=False` in Django's form) | `users/views.py:109` |
| `csrfmiddlewaretoken` | CSRF | `POSAdmin/settings.py:84` |

### 1.3 Password check

- **Model/table:** `AUTH_USER_MODEL = 'users.PosUser'` (`POSAdmin/settings.py:281`); `PosUser(AbstractUser)` with
  `db_table = 'pos_user'` (`users/models.py:66,136`). `auth_user` exists in production DDL but is **not** read by
  POS login (Django's `auth.User` is swapped out).
- **Backends, in order:** `users.auth_backends.EmailBackend`, then `django.contrib.auth.backends.ModelBackend`
  (`POSAdmin/settings.py:90-93`).
- `EmailBackend.authenticate` (`users/auth_backends.py:7-18`):
  - `pos_user` row where `username ILIKE username OR email ILIKE username` (Django `__iexact`), `:9-11`.
  - Not found: `UserModel().set_password(password)` to equalise timing, returns `None` (`:12-13`).
  - **More than one row: returns `User.objects.filter(email=username).order_by('id').first()` with no password
    check and no `is_active` check** (`:14-15`). See NEEDS USER DECISION D2.
  - One row: `user.check_password(password) and self.user_can_authenticate(user)` (`:17-18`);
    `user_can_authenticate` = `is_active` truthy (Django ModelBackend).
  - If `EmailBackend` returns `None`, Django tries `ModelBackend` (exact `username` match; production column
    collation is `utf8mb4_general_ci`, so the comparison is case-insensitive anyway — DDL `pos_user`).
- **Hasher:** Django 4.2 default `PASSWORD_HASHERS` (not overridden in `POSAdmin/settings.py`), i.e. PBKDF2-SHA256 with
  600 000 iterations for new hashes; also verifies PBKDF2-SHA1, Argon2, BCryptSHA256, Scrypt encoded hashes.
  **Which algorithms appear in production `pos_user.password` is UNKNOWN** (no read-only query was run).
- **Rehash-on-login side effect:** `AbstractBaseUser.check_password` passes a setter; when the stored hash's
  iteration count ≠ 600 000 (or the salt is too short), Django re-hashes and runs
  `save(update_fields=["password"])` → **a write to `pos_user.password` during login**. The rewrite does not do
  this (`src/auth/crypto.ts:71-79` only verifies).
- **Double authentication:** `AuthenticationForm.is_valid()` already calls `authenticate()`; the view calls it
  again (`users/views.py:110`) → two PBKDF2 computations per login.
- **Active flag:** enforced by `user_can_authenticate` (above), and re-checked at every OTP step via
  `User.objects.filter(pk=user_id, is_active=True)` (`users/views.py:81-86`).
- **`user_type` / `role`:** **not checked at login.** Any `role` (1–5) and any `user_type` can sign in.
  (`role` 1 only changes the store list, `users/views.py:135-140`.)
- **Error outcomes of the password step:**
  - Form invalid (bad credentials): Django `AuthenticationForm` error, verbatim:
    `Please enter a correct username and password. Note that both fields may be case-sensitive.`
  - Form invalid because the multi-row branch returned an inactive user: `This account is inactive.`
  - Required fields: `This field is required.`
  - Form valid but the second `authenticate()` returns `None`: silent `redirect('login')` (`users/views.py:143-144`).
  - Success renders `auth/login.html` (HTTP 200) with context (`users/views.py:114-142`):
    `is_authenticated=1`, `user_id`, `otp_method` (`"SMS"` if `otp_method==1` else `"Email"`), `is_mfa` (0/1),
    `mfa_message`, `stores` (see 1.9).

### 1.4 OTP generation and storage (legacy Redis, `POSAdmin/redis.py:5-6`, db 0)

At the password step, for a user with `is_mfa != 1` (`users/views.py:121-134`):
1. If `login_otp_lock:{uid}` exists → no send; `mfa_message = LOCKED_MESSAGE` (still HTTP 200, page rendered).
2. Else, if `SET login_otp_resend:{uid} 1 EX RESEND_COOLDOWN NX` succeeds **or** `login_otp:{uid}` is absent →
   call `tasks.send_login_otp(user.id)` **synchronously** (no `.delay`, `users/views.py:133`).
3. `mark_otp_sent(request)` sets session `pending_mfa_otp_sent = 1` (`users/views.py:134`, `users/login_otp.py:71-78`).

For `is_mfa == 1` users nothing is sent at the password step (`users/views.py:118-120`).

`send_login_otp(user_id, resend=False)` (`core/tasks.py:83-144`):
- Reads `pos_user` by id; if no row or **no `phone`** → log and return, **no OTP stored** (`:86-90`), even for email users.
- **Fixed OTP** (`:92-95`): if `LOGIN_FIXED_OTP_ENABLED` and `LOGIN_FIXED_OTP` (non-empty after strip) and
  `user_id in LOGIN_FIXED_OTP_USER_IDS` → `store_otp(user_id, LOGIN_FIXED_OTP)`; skip SMS, email **and WhatsApp**;
  return. Settings: `LOGIN_FIXED_OTP_ENABLED = int(env, default 0)`, `LOGIN_FIXED_OTP = env.strip()`,
  `LOGIN_FIXED_OTP_USER_IDS = [int(i) for i in env.split(',') if i.strip().isdigit()]`
  (`POSAdmin/settings.py:494-496`). Note `'1, 2'.split(',')` gives `' 2'`, `.strip().isdigit()` is true and
  `int(' 2') == 2`, so spaces are tolerated. The fixed value is not validated as 6 digits.
- Otherwise `otp = f"{secrets.randbelow(10**6):06d}"` (6 digits, zero-padded, CSPRNG) (`users/login_otp.py:59-60`);
  `store_otp` → `SET login_otp:{uid} <otp> EX OTP_TTL` (`users/login_otp.py:101-103`).
  `OTP_TTL = int(LOGIN_OTP_EXPIRY or 180)` (`users/login_otp.py:33`, `POSAdmin/settings.py:487`).
  A new OTP replaces the old; the failure counter is **not** reset (`users/login_otp.py:102`, `core/tasks.py:99-100`).

Redis keys (all `redis_instance`, db 0; values are raw bytes):

| Key | Value | Write | TTL | Citation |
|---|---|---|---|---|
| `login_otp:{uid}` | 6-digit OTP **plaintext** (or `LOGIN_FIXED_OTP`) | `SET … EX` | `LOGIN_OTP_EXPIRY` (default 180 s) | `users/login_otp.py:39-40,101-103` |
| `login_otp_fail:{uid}` | integer | `MULTI{SET k 0 EX LOCK NX; INCR k}` | `LOGIN_OTP_LOCK_SECONDS` from first failure (fixed window) | `users/login_otp.py:43-44,125-133,168` |
| `login_otp_lock:{uid}` | `1` | `SET … EX` | `LOGIN_OTP_LOCK_SECONDS` (default 10 800 s) | `users/login_otp.py:47-48,174` |
| `login_otp_wait:{uid}` | `1` | `SET … EX … NX` | `LOGIN_OTP_RETRY_INTERVAL` (default 30 s) | `users/login_otp.py:51-52,148-154` |
| `login_otp_resend:{uid}` | `1` | `SET … EX … NX` | `LOGIN_OTP_RESEND_COOLDOWN` (default 30 s) | `users/login_otp.py:55-56,190-192` |

Settings (`POSAdmin/settings.py:487-498`): `LOGIN_MFA_PENDING_TTL` 300, `LOGIN_OTP_MAX_ATTEMPTS` 3,
`LOGIN_OTP_RETRY_INTERVAL` 30, `LOGIN_OTP_LOCK_SECONDS` 3·3600, `LOGIN_OTP_RESEND_COOLDOWN` 30,
`LOGIN_SECURITY_SLACK_WEBHOOK` (falls back to `SLACK_WHATSAPP_ALERT_WEBHOOK`).

### 1.5 Delivery (all inside `send_login_otp`, run synchronously in the request thread)

| Channel | Condition | Behaviour | Citation |
|---|---|---|---|
| Email | `contact_email` truthy **and** `otp_method == 2` | `Helpers.send_otp_mail(contact_email, otp, first_name)` → Netcore `POST NETCORE_EMAIL_URL`, header `api_key`, from `connect@thesouledstore.com` / `The Souled Store`, subject `POS login OTP`, body `Hey {name},\n\n{otp} is your OTP to login into the POS Admin.\n\nHave a soulful day!\nThe Souled Store Team` (not HTML-escaped); **no timeout**; exceptions swallowed | `core/tasks.py:108-111`, `helpers/helpers.py:1477-1492,1434-1459` |
| SMS | `otp_method == 1` | Gupshup **GET** `https://enterprise.smsgupshup.com/GatewayAPI/rest` with query params `msg="{otp} is your OTP to log in to The Souled Store."`, `v=1.1`, `userid`, `password`, `send_to=phone`, `msg_type=text`, `method=sendMessage`, `mask=TSSOUL`; timeout 5 s; errors logged and swallowed | `core/tasks.py:105,113-133` |
| None | `otp_method == 2` with empty `contact_email`, or any other `otp_method` | OTP is stored but **not sent** (only WhatsApp on a resend) | `core/tasks.py:108-133` |
| WhatsApp | `resend=True` | `Helpers.spawn_whatsapp_otp(otp, phone, "staff_login|user_id:{uid}")` → **daemon thread**, Gupshup WhatsApp GET (`WHATSAPP_GUPSHUP_API_URL`, default `https://mediaapi.smsgupshup.com/GatewayAPI/rest`) msg `"{otp} is your verification code. For your security, do not share this code."`, footer `This code expires in 10 minute.`, timeout 10 s; success = `"success"` substring; on failure a Slack alert `:warning: WhatsApp OTP delivery failed \| flow: \`staff_login\|user_id:{uid}\` \| phone: \`{masked}\`` to `SLACK_WHATSAPP_ALERT_WEBHOOK` | `core/tasks.py:135-142`, `helpers/helpers.py:1511-1541,1591-1613`, `POSAdmin/settings.py:481-483` |

"Resend" means the session flag `pending_mfa_otp_sent` was already set when `AjaxSendLoginOtpView` ran
(`users/views.py:279-281`). The first "Get OTP" by a TOTP user is therefore **not** a resend (no WhatsApp);
every send after the password-step auto-send **is** a resend.

`AjaxSendLoginOtpView.post` (`users/views.py:261-282`), in order:
1. `pending_login_user(request)`; none → **401** `Your login session has expired. Please sign in again.` (`:264-266`, `:89-92`).
2. Locked → **429** `LOCKED_MESSAGE` (`:268-269`).
3. `claim_resend_slot` fails → **429** `Please wait a few seconds before requesting another OTP.` (`:270-273`).
4. Send with `resend=mark_otp_sent(request)`; respond 200
   `{"status":200,"message":"OTP has been sent.","otp_method_message": …}` where the message is
   `One Time Password (OTP) has been sent on your registered mobile number.` (`otp_method == 1`, with period) or
   `One Time Password (OTP) has been sent on your registered email address` (no period) (`:275-282`).
   Any POSTed `user_id` is ignored (`:262-264`).

### 1.6 OTP / TOTP verification, attempts and lockout

`AjaxMfaLoginView.post` (`users/views.py:183-243`). Request fields: `s_otp`, `platform` (`"otp"`/`"totp"`),
`check_in_store` (int; `0` allowed), plus an ignored `user_id`
(`users/views.py:185-187`; `users/templates/auth/login.html` JS posts `s_otp`, `check_in_store`, `platform`).

Exact order:
1. `check_in_store` not an int → **400** `Please select a store to check in to.` (`:189-192`; parser `helpers/helpers.py:768-775`).
   This runs *before* the pending-user check.
2. No live pending user → **401** `Your login session has expired. Please sign in again.` (`:196-198`).
3. `login_otp_lock:{uid}` exists → **429** `LOCKED_MESSAGE` (`:200-202`).
4. `use_totp = platform == "totp" and is_mfa == 1`; if `s_otp` empty or not (`use_totp` or `platform == "otp"`) →
   body `{"status": 400, "message": "Please Provide Valid OTP."}` with **HTTP 200** (no `status=` on the
   `HttpResponse`) (`:204-206`). No attempt is consumed.
5. `SET login_otp_wait:{uid} 1 EX RETRY_INTERVAL NX` fails → **429** `RETRY_WAIT_MESSAGE` (`:210-213`).
6. Re-check lock → **429** (`:216-217`).
7. Verify:
   - TOTP: `pyotp.TOTP(user.mfa_hash).verify(s_otp)` (`:219-220`) → SHA1, 6 digits, 30 s step, `valid_window=0`
     (pyotp defaults), compares `str(otp)` with the current code (unicode NFKC-normalised equality).
     A `NULL` `mfa_hash` raises → HTTP 500 (UNKNOWN whether it occurs in production).
   - OTP: `check_otp` (`users/login_otp.py:111-120`): `GET login_otp:{uid}`; compare bytes with
     `str(otp).strip().encode()` using `secrets.compare_digest`; on match `DEL login_otp:{uid}` (single use).
     Non-ASCII digits never match.
8. Wrong code → `record_failure(uid, platform)` (`users/login_otp.py:162-183`): `INCR login_otp_fail:{uid}`
   (window = LOCK_SECONDS from first failure). If `failures >= MAX_ATTEMPTS`: `SET login_otp_lock:{uid} 1 EX LOCK`,
   `DEL login_otp:{uid} login_otp_fail:{uid}`, Slack alert (1.8), return 0 → **429** `LOCKED_MESSAGE`.
   Else body `{"status":401,"message":"Wrong OTP. {n} attempt{s} left. Please wait 30 seconds before trying again."}`
   with **HTTP 200** (`:224-230`; `s` only when n > 1). The wait key stays set (that *is* the 30 s pause).
   TOTP and OTP failures share one counter.
9. Correct code → `DEL login_otp_wait:{uid}` (`:233`).
10. Store check `Helpers.user_can_check_in(uid, role, store)` (`helpers/helpers.py:778-791`): store 0 always allowed;
    otherwise `stores.id = store AND type IN ('STORE','CORE_WAREHOUSE')` (**inactive stores allowed**), and for
    `role != 1` also `store IN user_stores(django_user_id=uid)`. Refused → **403**
    `You are not assigned to this store.` (`:245-257`). Failures are **not** reset, pending is **not** cleared, and an
    SMS/email OTP has already been consumed (`DEL` in step 7).
11. Success (`:237-243`): `DEL login_otp_fail:{uid}`; clear session pending keys; `login(request, user,
    backend="users.auth_backends.EmailBackend")`; `session.set_expiry(eod_sec)` where
    `eod_sec = Helpers.time_until_end_of_day() - 1` (seconds to local midnight minus 1, `helpers/helpers.py:759-765`;
    server TZ `Asia/Kolkata`, `Dockerfile:8`; `USE_TZ=False`, `POSAdmin/settings.py:263`);
    `Helpers.set_check_in_store(uid, store, eod_sec)` (§2.4); respond `{"status":200,"message":"verified","data":{}}`.

Constants (`users/login_otp.py:35-36`), verbatim with defaults:
- `LOCKED_MESSAGE` = `Too many wrong OTP attempts. Please try again after 3 hours.` (`LOCK_SECONDS // 3600`)
- `RETRY_WAIT_MESSAGE` = `Please wait 30 seconds before trying again.` (`RETRY_INTERVAL`)

TOTP replay: the same TOTP code may be reused within its 30 s step (no used-code memory). OTP is single-use.

### 1.7 TOTP secret storage and enrolment

- Secret: `pos_user.mfa_hash varchar(255)` (plaintext base32); flag `pos_user.is_mfa tinyint(1)`
  (`users/models.py:123-124`; DDL).
- Enrolment (`AjaxActivateMfaView`, `@advance_permisson("[1,2,3]")`, `users/views.py:1007-1048`):
  - `GET /users/<pk>/activate-mfa/`: pk falsy → `Please Provide Valid User.`; `is_mfa == 1` →
    `Already Activated`; else `mfa_hash = pyotp.random_base32()` (32 chars) and **save immediately**; returns
    `provisioning_uri(email, issuer_name="TssPosApp")` wrapped in a Google Charts QR URL and message
    `Hash Has been generated, scan the above QR Code from you authenticator app and enter the otp.` (`:1020-1026`).
  - `POST /users/activate-mfa/` with `user_id`, `s_otp`: `pyotp.TOTP(mfa_hash).verify(s_otp)` → `is_mfa = 1`,
    `Hash has been verified, MFA activated on your account`; else `Wrong OTP, Enter correct OTP`; missing →
    `Please Provide Valid OTP.` (`:1030-1048`). All with HTTP 200, `status` in body. No attempt limit.
  - The acting admin may target any `pk` (no store scoping in this view).

### 1.8 Lockout alert

`send_alert` posts on a **daemon thread** (`users/login_otp.py:136-141`) via `Helpers.send_slack_alert`
(`helpers/helpers.py:1544-1553`): body `":lock: Staff login: user_id `{uid}` locked for {LOCK//3600}h after
{n} wrong {PLATFORM} attempts."` (`users/login_otp.py:179-180`; `PLATFORM` = `platform.upper()` or `OTP`),
reformatted to `"{emoji} *[{SERVICE_NAME}]* {rest}"`, JSON `{"text": …}`, timeout 5 s, errors logged.
At-most-once, fire-and-forget.

### 1.9 Pending-login state (password step → OTP step)

Stored in the **Django session** of the not-yet-authenticated browser (`users/login_otp.py:29-31,65-96`):
`pending_mfa_uid` (int), `pending_mfa_at` (epoch seconds), `pending_mfa_otp_sent` (1). Valid while
`now - pending_mfa_at <= LOGIN_MFA_PENDING_TTL` (300 s); expired → keys cleared (`:81-90`). A new password
submission overwrites them and clears `otp_sent` (`:65-68`). The store list shown at this step
(`users/views.py:135-141`): role 1 → all `stores` with `is_active=1 AND type IN ('STORE','CORE_WAREHOUSE')`;
others → the same filter intersected with `user_stores`.

### 1.10 Rewrite vs legacy — login deltas W3 must fix

| # | Rewrite (current) | Legacy | Citation |
|---|---|---|---|
| L1 | No fixed-OTP support | Fixed OTP per §1.4 | `core/tasks.py:92-95` vs `src/auth/mfa.ts:141-190` |
| L2 | OTP stored as HMAC in `pos_rewrite_login_security.otp_hash` | Plaintext in `login_otp:{uid}` | `src/auth/mfa.ts:55-56,166-173` |
| L3 | Locked OTP user gets **429 from the password POST** (`send()` → `locked()`) | Password step succeeds (200) and shows `LOCKED_MESSAGE` | `src/auth/mfa.ts:148,239` vs `users/views.py:126-127` |
| L4 | Password-step send is skipped only on cooldown **and** a live OTP; rewrite also throws `LOGIN_RESEND_WAIT` in some initial cases | Send if resend slot claimed **or** no live OTP | `src/auth/mfa.ts:149-163` vs `users/views.py:132-133` |
| L5 | Code must match `^\d{6}$` (zod 400 before any attempt is counted); TOTP verifier also rejects non-6-digit | Any non-empty string is checked and a miss is counted | `src/auth/routes.ts:145`, `src/auth/totp.ts:6` vs `users/views.py:205,222` |
| L6 | Failure message `Wrong OTP. {n} attempts left.` (no singular, no retry suffix); lock message `Too many wrong OTP attempts. Try again after the lockout period.` | Strings in §1.6 | `src/auth/mfa.ts:336-338` |
| L7 | `INVALID_LOGIN_FACTOR` `Use the delivered login OTP.` for TOTP by a non-MFA user | `Please Provide Valid OTP.` (HTTP 200, body 400) | `src/auth/mfa.ts:263-264` vs `users/views.py:205-206` |
| L8 | Store check delegated to `checkins.set` (W5 owns); must accept store 0 and inactive stores like legacy (verify) | Inactive stores allowed; store 0 allowed | `src/app.ts:282` vs `helpers/helpers.py:778-791` |
| L9 | `ACCOUNT_DISABLED` if `role ∉ 1..5` or `user_type ∉ {1,2}` | No role/user_type check | `src/auth/identity.ts:43,106` |
| L10 | Login requires exactly one matching row; multi-row = invalid | Multi-row returns a user **without password check** (D2) | `src/auth/identity.ts:85-104` vs `users/auth_backends.py:14-15` |
| L11 | Email user without `contact_email` → 503 `Login email delivery is not configured.` | OTP stored, nothing sent, success message | `src/auth/delivery.ts:184-192` vs `core/tasks.py:108` |
| L12 | Any user without `phone` → 503 `Ask your administrator to configure your login contact.` | Nothing stored, but UI says sent; verify then fails | `src/auth/delivery.ts:178-183` vs `core/tasks.py:88-90` |
| L13 | Delivery failure → 502 `OTP_DELIVERY_UNCERTAIN`; WhatsApp sent synchronously | SMS/email errors swallowed; WhatsApp on a daemon thread with Slack alert on failure | `src/auth/delivery.ts:25-30,243-246` |
| L14 | Gupshup SMS via **POST form body** | **GET query params** | `src/auth/delivery.ts:79-87` vs `core/tasks.py:126-130` |
| L15 | No password rehash on login | Django rehash writes `pos_user.password` | §1.3 |
| L16 | New hashes: 1 000 000 iterations, 16-char base64url salt | Django 4.2: 600 000 iterations, 22-char alphanumeric salt | `src/auth/crypto.ts:12-17` |
| L17 | Challenge bound to `authVersion` (credential hash); any credential change kills the pending login | Only `is_active` re-checked | `src/auth/mfa.ts:86-114` vs `users/views.py:81-86` |

---

## 2. Sessions

### 2.1 Engine and settings

| Setting | Value | Citation |
|---|---|---|
| `INSTALLED_APPS` includes `django.contrib.sessions` | yes | `POSAdmin/settings.py:64` |
| `SessionMiddleware`, `AuthenticationMiddleware` | yes | `POSAdmin/settings.py:82,85` |
| `SESSION_ENGINE` | not set → Django default `django.contrib.sessions.backends.db` | grep of `POSAdmin/settings.py` (only `SESSION_SAVE_EVERY_REQUEST` at `:500`) |
| Table | `django_session(session_key varchar(40) PK, session_data longtext, expire_date datetime(6))`, latin1 — **present in the production snapshot** (the ledger row for `pos_rewrite_sessions` says "NOT IN SNAPSHOT"; that is wrong) | production DDL |
| DB alias | `default` (router commented out) | `POSAdmin/settings.py:163,166-186` |
| `SESSION_SAVE_EVERY_REQUEST` | `False` | `POSAdmin/settings.py:500` |
| `SESSION_COOKIE_NAME` / `AGE` / `EXPIRE_AT_BROWSER_CLOSE` / `SECURE` / `HTTPONLY` / `SAMESITE` | not set → Django defaults `sessionid` / 1 209 600 s / `False` / `False` / `True` / `Lax` | absence in settings |
| `SESSION_SERIALIZER` | default JSON | absence in settings |
| `CSRF_USE_SESSIONS` | default `False` (cookie `csrftoken`) | absence in settings; `CSRF_TRUSTED_ORIGINS` at `:625-629` |
| `LOGIN_URL` / `LOGIN_REDIRECT_URL` / `LOGOUT_REDIRECT_URL` | `login` / `shortcut_dashboard` / `login` | `POSAdmin/settings.py:318-320` |

### 2.2 Lifetime

- Before login (pending step) the anonymous session uses the default 2-week cookie; the 300 s window is enforced
  by `pending_mfa_at` (§1.9).
- At login `session.set_expiry(eod_sec)` stores the **integer** `_session_expiry = eod_sec`
  (`users/views.py:240-241`). With an integer, Django computes `expire_date = save time + eod_sec` and sends the
  cookie with `max-age = eod_sec`. Because `SESSION_SAVE_EVERY_REQUEST=False`, the session is re-saved only when it is
  modified; **any later modification re-arms expiry to `now + eod_sec` (the value computed at login)**. The only
  post-login session writer found is `hla_store_ids` (`order/views.py:5409,5414,5445`), so normally the session ends at
  23:59:59 local time on the login day.
- `ProfileView.get_session_date` displays `now + (eod - 1)` as the expiry (`users/views.py:330-340`).

### 2.3 Session contents

| Key | Written by | Citation |
|---|---|---|
| `_auth_user_id`, `_auth_user_backend` (`users.auth_backends.EmailBackend`), `_auth_user_hash` (HMAC of `pos_user.password`, Django `get_session_auth_hash`) | `django.contrib.auth.login` | `users/views.py:239` |
| `_session_expiry` (int seconds) | `set_expiry` | `users/views.py:241` |
| `pending_mfa_uid`, `pending_mfa_at`, `pending_mfa_otp_sent` | pending login; cleared before `login()` | `users/login_otp.py:29-31,93-96`; `users/views.py:238` |
| `hla_store_ids` (list of store ids) | All-stores hyperlocal dashboard filter | `order/views.py:5409-5418,5445,5482` |
| messages | `MessageMiddleware` default `FallbackStorage` (cookie first, session overflow) | `POSAdmin/settings.py:86` |

Django `login()` also: cycles the session key (fixation protection), rotates the CSRF token, fires
`user_logged_in` → `update_last_login` → writes `pos_user.last_login` (naive local time; column is
`timestamp NULL`). The rewrite already writes `last_login` (`src/auth/sessions.ts:84-88`).

Per request, `AuthenticationMiddleware` loads `pos_user` by `_auth_user_id` and rejects the session if
`is_active` is false or `_auth_user_hash` no longer equals the HMAC of the current `pos_user.password`
(Django `get_user`). So:
- **Archive** (`DeleteUserView` sets `is_active=False`, `users/views.py:395-396`) ends sessions on the next request;
  re-activation (`users/views.py:420-421`) revives unexpired ones.
- **Password change** by anyone (`users/views.py:457` admin `set_password`; `users/views.py:512-514` self-change)
  invalidates other sessions; self-change keeps the current session via `update_session_auth_hash`.
- **Role / store / user_type changes do not end sessions**; they take effect on the next request because the user
  row and `user_stores` are re-read.

### 2.4 Logout and check-in / check-out

- **Logout** (`users/views.py:171-178`): if authenticated, `KEYS check_in_list_*` then `LREM key 0 uid` on each,
  then `django.contrib.auth.logout` (flushes the session row). **`check_in_{uid}` is not deleted.** Redirect to login.
- **Check-in at login**: mandatory `check_in_store` (§1.6 step 1); `set_check_in_store` after `login()`.
- **Change check-in** (`POST /ajax-set-checkin-data/`, `core/urls.py:120`, `core/views.py:2406-2425`):
  `check_in_store` int (missing defaults to 0) else **400** `{'status':'fail','message':'Please select a store to check in to.'}`;
  not allowed → **403** `You are not assigned to this store` (**no period**); success
  `{'status':'success','message':'Check-in changed'}`. Store 0 = "checked out / no store".
- **Read check-in** (`POST /ajax-get-checkin-data/`, `core/views.py:2386-2403`): returns assignable stores and
  `checkin_id`.
- `set_check_in_store(uid, store, eod_sec)` (`helpers/helpers.py:794-812`), non-atomic:
  `SET check_in_{uid} json.dumps([store, store_name]) EX eod_sec`; `KEYS check_in_list_*` + `LREM … uid` on each;
  `LPUSH check_in_list_{store} uid`; `EXPIRE check_in_list_{store} eod_sec`. Store name is `""` when no row
  (store 0 → value `[0, ""]`, and list `check_in_list_0` is created).
- Readers: `Helpers.get_checkin_data` (`helpers/helpers.py:1235-1240`, default `[0, ""]`),
  `Helpers.get_checkin_store` (active `type='STORE'` only, `helpers/helpers.py:1791-1800`),
  `Helpers.get_checked_in_user` (`helpers/helpers.py:815-824`, notification targets),
  context processor on every page (`core/context_processors.py:13-14`), day-close store
  (`report/day_close_services.py:148-150`).
- **Counter** is not part of check-in. It is a per-tab form value (`order/views.py:1442-1497`); no server state.
- **Check-in/out does not touch the session.** No session revocation on check-out exists in legacy.

### 2.5 Verified-user and tab objects in Redis

All in `redis_instance` db 0. TTL env vars have **no default** (`POSAdmin/settings.py:469-470`): if unset,
redis-py receives `ex=None` and the key **never expires**. Production values are **UNKNOWN**.

| Key | Value | TTL | Written | Read / deleted |
|---|---|---|---|---|
| `{tab_id}` (bare integer key) | customer `users.id` attached to the tab | `REDIS_TAB_USER_OBJECT_EXPIRY` | `order/views.py:2004,2059` | `order/views.py:1529-1530`; DEL `order/views.py:1769` |
| `{customer_user_id}_{tab_id}` ("verified user") | `1` after customer OTP verified via API-v2 `omnichannel-verifyotp` | `REDIS_VERIFIED_USER_OBJECT_EXPIRY` | `order/views.py:2579` | `order/views.py:1531-1533`; DEL `order/views.py:1768` |
| `{store_id}_{tab_id}` | master salesperson id | `REDIS_TAB_USER_OBJECT_EXPIRY` | `order/views.py:2980` | `order/views.py:1569,1738,1804,2833-2856`; SCAN+DEL `order/views.py:1772-1773` |
| `{store_id}_{tab_id}_{product_id}` | per-line salesperson id | same | `order/views.py:1582,1611,1740-1742,3004,3015` | `order/views.py:1578,1736,2779,3298`; DEL `:1755,2786,3305` |
| `gift_card_{tab_id}_{gv_id}` | gift-card barcode | `GC_SRNO_DATE_EX` (default 21 600) | `order/views.py:4334` | `order/views.py:1592,2630,4327` |
| `{user_id}_{store_id}_{counter_id}_{tab_id}` | PG-discount OTP map `{otp: [manager_id, pg_discount]}` | `PG_DISC_OTP_EX_VALUE` (600) | `core/tasks.py:234,266` | `order/views.py:2718-2720,4623-4651` |
| `auth_qr_{uid}` | mPOS QR TOTP base32 secret | `POS_AUTH_USER_SECRET_EXP` (1800) | `users/views.py:1161-1169,1203-1211,1247-1255` | `users/views.py:1149-1153` (TOTP interval `POS_AUTH_QR_EXP_SEC`, default 60); rotated on successful mPOS login |

The bare `{tab_id}` key collides across stores and with any other integer key; `tab_id` is client-supplied
(`order/views.py:1998`). These keys belong to checkout (W4), not W3; listed because the brief asked.

### 2.6 Rewrite vs legacy — session deltas

| # | Rewrite | Legacy |
|---|---|---|
| S1 | `pos_rewrite_sessions` row per session; cookie `pos_session` sealed AES-GCM `{id, expires, sessionId, secret}` (`src/auth/session-cookies.ts:8-16,26-50`, `src/auth/sessions.ts:53-139`) | `django_session` row; cookie `sessionid` |
| S2 | Validity = `authenticationVersion(credentialVersion(pos_user) + epoch)` (`src/auth/revocation.ts:20-37`, `src/auth/crypto.ts:18-50`) — any change to username/email/password/MFA/phone/contact/otp_method/role/user_type/is_staff/is_superuser kills sessions | Only password change or `is_active=0` |
| S3 | Logout does not touch `check_in_list_*` (`src/auth/routes.ts:176-198`) | LREM uid from all `check_in_list_*` |
| S4 | Expiry = next business-day start − 1 s (`src/auth/routes.ts:46-50`) — matches legacy 23:59:59 | plus re-arm on modification (§2.2) |
| S5 | `writeSessionCookie` revokes the browser's previous session on re-login (`src/auth/session-cookies.ts:42`) | `login()` cycles key; old key deleted by Django `cycle_key` — equivalent |

---

## 3. Permissions

### 3.1 Mechanisms

| Mechanism | Rule | Citation | Uses |
|---|---|---|---|
| `LoginRequiredMixin` | authenticated else redirect `LOGIN_URL` | Django; `POSAdmin/settings.py:319` | most views |
| `advance_permisson("[…]")` | anonymous → redirect `login`; `role not in list` → message `Permisssion denied` (three s), redirect `shortcut_dashboard` | `helpers/decorators.py:46-58` | `[1,2,3]`×29, `[1]`×9, `[1,3]`×5, `[1,2]`×5, `[1,2,3,4]`×1 |
| `permission` | `role == 1` else `Permisssion denied` | `helpers/decorators.py:36-43` | 0 uses found |
| `user_type_exempt("[2]")` | anonymous → login; `user_type in [2]` (FRANCHISE) → `Permisssion denied` | `helpers/decorators.py:71-83` | ×9 |
| `async_role_required(roles)` / `async_login_required` | async views: anonymous → `LOGIN_URL`; role not in roles → `shortcut_dashboard` | `helpers/decorators.py:11-32` | `[SUPERADMIN, ADMIN, OPM]`×2, `[SUPERADMIN]`×1, login-only ×7 |
| `day_close_enabled_required` | role 1, or checked-in store in `DAY_CLOSE_ENABLED_STORE_IDS` | `helpers/decorators.py:60-69`, `report/day_close_services.py:73-78,148-150` | ×5 |
| Inline checks | 121 `role`/`user_type` comparisons in views/helpers (e.g. `users/views.py:75,135,305,390,415`) | grep | — |
| Service API keys | `APPID`/`APPKEY` headers (`order/views.py:3683-3686,5257-5261`), `REPORTS_API_KEY` header `apikey` (`helpers/helpers.py:1713-1717`) | — | inbound webhooks / scheduled reports |

Counts above come from a grep of decorator call sites in the legacy tree.

Values: `role` 1 Super admin, 2 Admin, 3 OPM (old "Merchant"), 4 SM (old "Staff"), 5 Staff (old "Cashier")
(`users/models.py:79-91`); `user_type` 1 IN_HOUSE, 2 FRANCHISE (`users/models.py:107-113`);
`otp_method` 1 Mobile, 2 Email (`users/models.py:99-105`).

**Views whose `LoginRequiredMixin` is ineffective** (MRO `(View, LoginRequiredMixin)`, so `View.dispatch` runs
first and the mixin never executes): `users/views.py:1050` `AjaxUpdateEndUserDataView`,
`users/views.py:1214` `AjaxGenAuthQR`, `core/views.py:2846` `AjaxGenMposDownloadQR`,
`core/views.py:3161` `MposUserDownloadApp`, `core/views.py:3182` `UserToApp`
(`core/views.py:2795` `MposDownloadQr` is still protected by `user_type_exempt`). See D3.

Django admin is mounted (`POSAdmin/urls.py:10`) and uses `is_staff`/`is_superuser` + Django permissions;
`pos_user_groups`, `pos_user_user_permissions`, `auth_group`, `auth_group_permissions` are **missing** from the
production snapshot ("missing" list in the JSON). The POS app itself never reads Django groups/permissions.

### 3.2 Store membership

- `user_stores(id, django_user_id bigint, store_id bigint)` (`users/models.py:139-147`, `managed=False`; DDL).
- Role 1 = all stores; everyone else = rows in `user_stores` (`users/views.py:69-78,135-140`,
  `helpers/helpers.py:786-791`, `core/views.py:2392-2397`).
- Operational authority is the **checked-in store** from Redis `check_in_{uid}` (e.g. `order/views.py:910-913`
  returns require check-in == order store; `order/views.py:1445-1473` billing needs a check-in store and an active counter).

### 3.3 Production tables read for authN/authZ

`pos_user` (id, password, is_active, role, user_type, is_mfa, mfa_hash, otp_method, phone, contact_email, email,
username, first_name, last_name, last_login, is_staff, is_superuser), `user_stores`, `stores` (id, is_active, type,
store_name), `store_counters` (store_id, is_active), `django_session`. Writes: `pos_user.last_login`,
`pos_user.password` (rehash), `pos_user.mfa_hash`/`is_mfa` (enrolment), `django_session`.

---

## 4. Mapping to the rewrite

### 4.1 `pos_rewrite_*` tables used by `src/auth/**`

Direct (`grep pos_rewrite_ src/auth` at `324d62d`):

| Table | Defined | Used by |
|---|---|---|
| `pos_rewrite_sessions` | `src/auth/session-schema.ts:4` | `sessions.ts`, `revocation.ts`, `routes.ts`, security worker |
| `pos_rewrite_login_challenges` | `src/auth/mfa-schema.ts:3` | `mfa.ts`, `revocation.ts` |
| `pos_rewrite_login_security` | `src/auth/mfa-schema.ts:12` | `mfa.ts`, `revocation.ts` |
| `pos_rewrite_login_security_alerts` | `src/auth/security-schema.ts:3` | `mfa.ts:320-331`, `security-worker.ts` |
| `pos_rewrite_operator_auth_epochs` | `src/auth/revocation.ts:12` | `revocation.ts`, `sessions.ts:107-111`, plus administration and checkout readers (ledger) |
| `pos_rewrite_profile_uploads` | `src/auth/profile-media-schema.ts:7` | `profile-media*.ts` |
| `pos_rewrite_profile_media_jobs` | `src/auth/profile-media-schema.ts:8` | `profile-media-worker*.ts` |

Already removed by W2 at `324d62d` (were present at `3a3acc9`): `pos_rewrite_operator_google_identities`
(`google-identity-schema.ts`) and `pos_rewrite_desktop_sso_flows` (`desktop-sso-schema.ts`).

Transitive (imported into `src/auth/**` from other modules):

| Table | Via | Owner |
|---|---|---|
| `pos_rewrite_operator_mfa_enrollments` | `src/auth/revocation.ts:10,68-79`; pruned by `src/auth/security-worker.ts:10,220` | administration (W5) |
| `pos_rewrite_administration_registries` | `src/auth/profile.ts:10` (`lockAdministrationRegistry('operators')`) | administration (W5) |
| `pos_rewrite_slack_connections` | pruned by `src/auth/security-worker.ts:11,221` | administration (W5) |
| `pos_rewrite_staff_download_grants`, `pos_rewrite_customer_application_links`, `pos_rewrite_application_scan_receipts`, `pos_rewrite_customer_application_cache` | pruned via `pruneApplicationLinks`, `src/auth/security-worker.ts:12,222` | application-links |
| `pos_rewrite_operator_checkins` | `src/app.ts:280-282` → `mfa.ts:349` | administration (W5) |

Redis keys already used by `src/auth/**`: `auth_qr_{uid}` (legacy) and **`pos_rewrite:auth_qr:version:{uid}`,
`pos_rewrite:auth_qr:attempt:{digest}`, `pos_rewrite:auth_qr:used:{…}`** (`src/auth/device-handoff-store.ts:45,136,145`),
which break the `pos:` prefix rule.

### 4.2 Replacement per table

#### `pos_rewrite_login_challenges` → Redis (replaces legacy session keys `pending_mfa_*`)

- Key: `pos:login_pending:{pendingId}` (`pendingId` = UUID in the sealed `pos_pending_login` cookie, as today).
- Value JSON: `{"userId":"<pos_user.id as string>","proofHash":"<sha256 hex of cookie secret>","startedAt":<epoch seconds>,"otpSent":0|1}`.
- Create: `SET … NX EX LOGIN_MFA_PENDING_TTL` (300). TTL is **not** refreshed by later steps
  (legacy measures from `pending_mfa_at`).
- `mark_otp_sent`: Lua `GET`, decode, read old `otpSent`, set to 1, `SET … KEEPTTL XX`, return old value
  (atomic; legacy is per-session and non-atomic, so a race only affects whether WhatsApp is added).
- Read: `GET`; timing-safe compare `proofHash`; then read `pos_user` by id on the writer with `is_active = 1`
  (legacy `users/views.py:81-86`). **Drop** the `authVersion` binding (L17).
- Success / discard: `DEL`. Logout with a pending cookie: `DEL` (current behaviour, `src/auth/routes.ts:185-194`).
- No per-user index is needed: legacy has no "revoke all pending logins".

#### `pos_rewrite_login_security` → legacy Redis keys (verbatim)

| Concern | Key | Op | TTL |
|---|---|---|---|
| OTP | `login_otp:{uid}` → plaintext code (see D4) | `SET … EX` | `LOGIN_OTP_EXPIRY` (default 180) |
| Check + consume | `login_otp:{uid}` | Lua compare-and-delete (`if GET == ARGV then DEL return 1`), comparing UTF-8 bytes of `code.trim()` | — |
| Failure count | `login_otp_fail:{uid}` | `MULTI { SET k 0 EX LOCK NX; INCR k } EXEC` (use INCR's reply) | `LOGIN_OTP_LOCK_SECONDS` |
| Lock | `login_otp_lock:{uid}` | on reaching MAX: `MULTI { SET lock 1 EX LOCK; DEL login_otp:{uid} login_otp_fail:{uid} } EXEC` | `LOGIN_OTP_LOCK_SECONDS` |
| One attempt per interval | `login_otp_wait:{uid}` | `SET 1 EX RETRY_INTERVAL NX` before checking; `DEL` on a correct code | `LOGIN_OTP_RETRY_INTERVAL` |
| Resend cooldown | `login_otp_resend:{uid}` | `SET 1 EX RESEND_COOLDOWN NX` | `LOGIN_OTP_RESEND_COOLDOWN` |
| Reset after login | `login_otp_fail:{uid}` | `DEL` | — |

- `alertPending` column → dropped (fire-and-forget alert, §1.8).
- Sharing these keys with a running legacy app requires the **same Redis host and db 0** (`POSAdmin/redis.py:5-6`).
- Implement the fixed-OTP branch exactly as `core/tasks.py:92-95`, with env vars `LOGIN_FIXED_OTP_ENABLED`
  (int, default 0), `LOGIN_FIXED_OTP` (trimmed), `LOGIN_FIXED_OTP_USER_IDS` (comma list; non-digit entries dropped).
  Its position after the phone check is part of the behaviour (no phone → no fixed OTP either).
- Never log OTP values or phone numbers (AGENTS.md); legacy logs a masked phone, the rewrite should log only user id + request id.

#### `pos_rewrite_login_security_alerts` → DELETE

After the lock `MULTI` succeeds, post the legacy Slack text (§1.8) without awaiting it (5 s timeout, errors logged
as a registered event with no PII). At-most-once, as legacy. No queue, no table, no worker.

#### `pos_rewrite_sessions` → Redis

- Key: `pos:session:{sessionId}` (UUID). Value JSON:
  `{"userId":"<id>","secretHash":"<sha256 hex>","authHash":"<hex>","expirySeconds":<int>,"hlaStoreIds":[<id>,…]}`
  (`hlaStoreIds` optional; carries legacy `hla_store_ids`, owned by the hyperlocal dashboard module).
- `authHash` = HMAC-SHA256(key = `SESSION_SECRET`, message = `"pos.session-auth-hash:" + pos_user.password`) — the analogue
  of Django `_auth_user_hash`. It is not Django-compatible (different key) and does not need to be.
- Create (after OTP success, inside the request): `SET … NX EX expirySeconds`, where `expirySeconds` =
  seconds until 23:59:59 business-local today (legacy `eod_sec`). Cookie max-age = `expirySeconds`.
- Validate each request: `GET`; timing-safe compare `secretHash`; read `pos_user` by id **on the writer**
  (AGENTS.md writer consistency); require `is_active = 1` and `authHash == HMAC(current password)`. Principal
  role/user_type/store ids are read fresh from `pos_user` / `user_stores`, as Django does per request.
  The existing `request.authSessionValid(tx)` hook (`src/auth/routes.ts:82`) should re-read the `pos_user` row
  inside the caller's transaction (`FOR SHARE`) and compare `is_active` + `authHash`; the Redis key is a pre-read.
- Session modification (only `hlaStoreIds`): `SET … EX expirySeconds XX` (re-arms TTL to the login-time value, as
  Django does) and re-issue the cookie with the same max-age (§2.2).
- Self password change: compute the new `authHash` and `SET … KEEPTTL XX` on the current session only
  (legacy `update_session_auth_hash`). Other sessions die on their next request because their `authHash` no longer matches.
- Logout: `DEL pos:session:{id}`; then `SCAN MATCH check_in_list_*` and `LREM key 0 {uid}` on each
  (same effect as legacy `KEYS`, non-blocking). Do **not** delete `check_in_{uid}`.
- No per-user session index, no prune worker (TTL expires keys). Archive, password reset and deactivation need no
  Redis writes. The plan line "revocation on archive/check-out via Redis session index per user"
  (`docs/plans/single-stack-schema-freeze.md`, Phase C) is not legacy behaviour; see D6.
- Redis must not evict these keys (`maxmemory-policy noeviction`, per ledger conventions).

#### `pos_rewrite_operator_auth_epochs` → DELETE (legacy equivalent is `authHash`, above)

Remove `authenticationVersion`/`credentialVersion` binding from sessions and challenges. Under strict parity,
role, user_type, MFA, phone and email changes do not revoke sessions. If the team wants to keep revoke-on-permission-change,
there is no home: see D1.

#### `pos_rewrite_operator_mfa_enrollments` (transitive) → `pos_user.mfa_hash` / `pos_user.is_mfa` (ledger (b))

W3 only needs to drop the `revocation.ts:68-79` update. Enrolment itself is W5's (`src/modules/administration/mfa.ts`).
Legacy writes the new secret into `mfa_hash` at GET time and sets `is_mfa=1` after one valid TOTP
(`users/views.py:1020-1022,1038-1042`). The rewrite's attempt budget `pos:mfa_enroll:{operatorId}` (ledger) is rewrite-only.

#### `pos_rewrite_operator_google_identities`, `pos_rewrite_desktop_sso_flows` → DELETE (done)

Feature removed (AGENTS.md "Revisions, 19 November 2026"); W2 deleted both at `324d62d`. One remnant:
`identity.byVerifiedEmail` (`src/auth/identity.ts:20,118`) is an SSO helper with no remaining caller; delete it.

#### `pos_rewrite_profile_uploads` → Redis or synchronous upload; `pos_rewrite_profile_media_jobs` → DELETE

Legacy uploads profile/cover images synchronously through `UserUpdateForm` with `request.FILES` and stores the path in
`pos_user.profile_image` / `cover_image` (`users/views.py:297-308`, `users/models.py:125-126`); it never deletes old files.
Parity target: synchronous multipart upload writing those columns, with no reservation or cleanup worker. If the
signed-upload transport is kept, use the ledger's `pos:profile_upload:{uploadId}` (JSON
`{ownerId, kind, objectKey, contentType, size, checksum, profileRevision}`, `EX` = signed-POST expiry + grace).

#### `pos_rewrite_administration_registries` (transitive via `profile.ts`) → remove from profile

Legacy profile/password saves take no registry lock (`users/views.py:297-316,508-516`). Drop
`lockAdministrationRegistry('operators')` from `src/auth/profile.ts`. Other modules follow the ledger
(`pos:lock:admin:{resource}` `SET NX PX 30000`).

#### `pos_rewrite_operator_checkins` (transitive via `app.ts:288`) → legacy keys (owned by W5)

`check_in_{uid}` → `json.dumps([store_id, store_name])` byte-compatible (Python separators `", "`, e.g. `[12, "Andheri"]`),
`EX` seconds to end of day − 1; `check_in_list_{store}` LIST (SCAN+LREM all, `LPUSH`, `EXPIRE`). Wrap
`SET + LREMs + LPUSH + EXPIRE` in one `MULTI` after the SCAN. Validation must match `helpers/helpers.py:778-791`
(store 0 allowed, inactive stores allowed, type `STORE`/`CORE_WAREHOUSE`). The rewrite-only
`pos:checkin_counter:{uid}` (ledger) has no legacy counterpart (§2.4).

#### Device handoff keys (not a table)

Keep `auth_qr_{uid}` (base32 secret, `EX POS_AUTH_USER_SECRET_EXP`, TOTP interval `POS_AUTH_QR_EXP_SEC`,
rotate on successful mPOS login). The rewrite-only `pos_rewrite:auth_qr:version|attempt|used:*` keys
(`src/auth/device-handoff-store.ts:45,136,145`) are not legacy; delete them, or rename them to `pos:auth_qr:*` if
kept (see D3).

### 4.3 Atomicity summary

| Operation | Primitive |
|---|---|
| Create session / pending | `SET NX EX` |
| Attempt slot, resend slot | `SET NX EX` (legacy) |
| Failure counter | `MULTI` (`SET NX EX` + `INCR`) (legacy) |
| Lockout | `MULTI` (`SET EX` + `DEL` OTP + `DEL` fail) |
| OTP consume | Lua compare-and-delete |
| Pending `otpSent` flip | Lua (read-modify-write with `KEEPTTL`) |
| Session update (password self-change, hla filter) | `SET XX` (`KEEPTTL` or `EX expirySeconds`) |
| Check-in | `SCAN` then `MULTI` |

### 4.4 Rewrite auth features with no legacy counterpart (to remove)

1. Google SSO — deleted by W2 at `324d62d`; remnant `identity.byVerifiedEmail` (`identity.ts:20,118`).
2. Desktop SSO — deleted by W2 at `324d62d`.
3. Demo mode and demo sessions — still present: `routes.ts:34,84,87-90,166-171,194`, `app.ts:284` + `memorySessions` (`sessions.ts:141-170`) (AGENTS.md removed features).
4. Auth epochs and credential-version revocation — `revocation.ts` (whole file), `crypto.ts:18-50`, `sessions.ts:69-75,123-126`, `mfa.ts:86-114`.
5. Login-security alert outbox, `worker:security` loop, `--retry-alert` CLI — `security-worker*.ts`, `security-schema.ts`, `mfa.ts:319-331`.
6. Session/challenge pruning (Redis TTL replaces it) — `sessions.ts:43-45`, `security-worker.ts:219-222`.
7. Per-route rate limits — `routes.ts:93,123` (`8/min`, `20/min`). Legacy has none (its only limits are the Redis keys in §1.4).
8. Operator-binding header `x-operator-id` → 409 `OPERATOR_CHANGED` — `src/auth/operator-binding.ts`.
9. OTP-at-rest HMAC (`mfa.ts:55-56`) and the `delivery: 'uncertain'` / `OTP_DELIVERY_UNCERTAIN` state (`delivery.ts:25-30`).
10. 6-digit input regex for login codes (`routes.ts:145`, `totp.ts:6`).
11. Role/user_type gate at login (`identity.ts:43,106`) and `ACCOUNT_DISABLED`.
12. Profile media signed-upload reservation, image validation pipeline and cleanup worker (`profile-media*.ts`, `profile-image-validation.ts`).
13. Registry lock on profile edits (`profile.ts:10`).
14. Device-handoff hardening keys (version fence, attempt limit, used-code replay set) and the
    `UPSTREAM_POS_DEVICE_HANDOFF_CONTRACT` / `POS_DEVICE_HANDOFF_SERVICE_KEY` gating (`device-handoff.ts:15-45`, `device-handoff-store.ts`) — subject to D3.
15. MFA enrolment state machine (sealed pending secret, attempts, expiry, idempotency receipts) — W5, `modules/administration/mfa.ts`.

Keep (legacy-equivalent): Django PBKDF2 verification; fixed-cost hash for unknown usernames (legacy `auth_backends.py:13`);
`password-policy.ts` (mirrors `AUTH_PASSWORD_VALIDATORS`, `POSAdmin/settings.py:237-250`); end-of-day expiry;
`last_login` write; TOTP SHA1/6/30 s/window 0 (`totp.ts`).

---

## NEEDS USER DECISION

No solution is proposed for these; each needs a product/security call before W3 implements.

- **D1 — Revoke sessions on role/permission/MFA/contact change (auth epochs). No home.** Legacy revokes only on
  password change or deactivation. Keeping the rewrite's broader revocation needs a durable per-operator counter;
  Redis without TTL is not an approved durable store, and no production column fits. Strict parity means dropping it.
- **D2 — `EmailBackend` multi-match password bypass** (`users/auth_backends.py:14-15`). When the login string
  matches more than one `pos_user` row (e.g. one user's username equals another's email, case-insensitive), legacy
  returns the lowest-id user whose email equals the input **without checking the password**. Replicate for 1:1, or reject.
- **D3 — Unauthenticated mPOS QR generation** (`users/views.py:1214-1236`; MRO makes `LoginRequiredMixin` inert).
  Anyone with a CSRF token can POST any `user_id` and receive that user's current mPOS TOTP; with
  `MPOS_QR_TAKE_PASSWORD=0` (default, `POSAdmin/settings.py:532`) `MPosLogin` accepts email + that TOTP
  (`users/views.py:1129-1133`). The same MRO flaw affects the 4 other views listed in §3.1. Decide whether the rewrite
  copies this, and whether the rewrite-only device-handoff hardening (§4.4 item 14) stays.
- **D4 — OTP at rest: legacy plaintext key vs the ledger's hashed key.** The ledger proposes `pos:login_otp:{uid}` holding
  `sha256(otp)` (`table-disposition.md`, auth/mfa row). The "reuse legacy key names" rule and fixed-OTP parity point to
  `login_otp:{uid}` plaintext, which also interoperates with a running legacy app. Pick one; both have a home.
- **D5 — Mirror legacy HTTP statuses?** Legacy returns HTTP 200 with `"status": 400/401` in the body for
  `Please Provide Valid OTP.` and `Wrong OTP…` (`users/views.py:206,230`) and for all MFA-enrolment responses. The rewrite
  frontend is new; confirm whether to keep these as 200 or use the body status as the HTTP status.
- **D6 — Plan vs legacy on check-out revocation.** `docs/plans/single-stack-schema-freeze.md` (Phase C, Auth bullet) asks
  for "revocation on archive/check-out via Redis session index per user". Legacy does not revoke on check-out and
  needs no index for archive (per-request `is_active`). Confirm that the plan line is superseded.
- **D7 — Password rehash on login** (L15/L16). Writing `pos_user.password` during login matches legacy, and the
  rewrite's 1M-iteration hashes would be re-hashed to 600k by a still-running legacy login. Confirm the rewrite should
  hash and rehash exactly like Django 4.2.

## UNKNOWN

- Hash algorithms and iteration counts present in production `pos_user.password` (needs a read-only `SELECT LEFT(password, 30)` aggregate).
- Production values of `REDIS_TAB_USER_OBJECT_EXPIRY`, `REDIS_VERIFIED_USER_OBJECT_EXPIRY`, `LOGIN_OTP_EXPIRY`, `LOGIN_FIXED_OTP_*`, `MPOS_QR_TAKE_PASSWORD`.
- Whether any `pos_user` has `is_mfa=1` with `mfa_hash` NULL (would make legacy TOTP verify raise).
- Whether production Redis has an eviction policy that could drop `login_otp_*` / `check_in_*` keys.
