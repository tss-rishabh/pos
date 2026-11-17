# Inherited administrative account creation and store URL evidence

Baseline `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. Source `users/admin.py` registers `PosUser` with Django's `UserAdmin` and changes only its **change** fieldsets. Its inherited add form remains `username,password1,password2`. Source `users/models.py` defines the extra defaults; `users/apps.py` loads `users/signals.py`, whose two receivers are entirely commented out. There is no active account-created signal or inherited add hook creating a commerce customer/staff mirror. The strict existing POS staff creation remains separate and continues to create its source commerce mirror.

`tools/administration/model-accounts/source-oracle.py` hash-checks these files, the actual store model/admin registration and source password validator settings, then loads the source model AST and actual source UsersConfig/signals/admin registration in a temporary application package. It pins Django4.2.5 and its whole UserAdmin implementation-file checksum `9160a8e50274bba60806b2bc46bdab8b2df9e1b42f08c0fdb71cd69715b6bab4`. Actual UserAdmin forms and ModelForm/save methods execute only against freshly created physical-schema localhost fixtures; no live data, source sibling edits, provider calls or credentials are emitted.

## Exact persisted add defaults

Normalizing/validating the source username uses the existing shared Unicode strip/NFKC/username validator and150-code-point bound. Source case-insensitive lookup and physical `utf8mb4_general_ci` UNIQUE username behavior are retained. Existing shared Django password validation and PBKDF2 hash helpers are reused, including source similarity/common/numeric/minimum rules. Passwords up to the existing login endpoint's512-character bound are accepted; the separate POS staff128-character limit is not accidentally copied into this inherited form. Mismatched confirmation, extra fields and arbitrary privilege/default overrides are refused.

| Field | Persisted source value |
| --- | --- |
| username/password | Normalized username; password hash only |
| first_name/last_name | Empty strings |
| email | **Empty string**, not NULL |
| phone/contact_email/age/gender/last_login/mfa_hash | NULL |
| role/user_type/otp_method | 1 /1 /2 |
| is_active/is_staff/is_superuser/is_mfa | true /false /false /false |
| profile_image/cover_image | Exact existing source default image paths |
| date_joined | Current source business wall time |

The empty email is an important actual-form result. `AbstractUser.clean()` normalizes the initially absent email to `''` during ModelForm validation. The physical UNIQUE email index then permits only one such pending account. The real oracle demonstrates that the second distinct username form can validate but its save raises `IntegrityError`. The rewrite preserves the persisted value and refuses that second mutation with static `OPERATOR_MODEL_EMAIL_SETUP_REQUIRED` before insertion. Complete the previous account's email before creating another. It does not silently substitute NULL or add a fabricated contact value. The native source comparison checks every persisted nonsecret field, including blanks, NULLs and dates, not just model declarations.

Role1 is the global business Super admin default, even though staff/superuser flags remain false. This creation therefore uses the **existing** privilege-mutation hardening: a current active internal type1/role1 staff superuser, plus verified/reconciled source administration authority. Source Django `_add_view` requires **both** `users.add_posuser` and `users.change_posuser`; the two checks are not collapsed into an OR. The existing superuser boundary intentionally excludes lesser staff with both grants because this source default creates global POS authority. Native tests prove missing/changed active/staff/superuser/type/role/reconciliation refusals. No arbitrary role, staff, group, superuser, contact, store or MFA value is accepted in the add payload.

A new username that aliases another account's existing email is also refused. This closes the source UserAdmin's username-only uniqueness hole against the actual username-OR-email authentication backend. Existing unique indexes and the shared operators registry serialize participating creates; no new legacy uniqueness constraint or source modification is introduced.

## Atomic audit and recovery

Creation and an immutable allowlisted administration receipt share one writer transaction. The existing `pos_rewrite_administration_access_mutations` contains actor/target/original UUID/action/resource/request correlation, a keyed HMAC of the input and the safe result. Plaintext password, confirmation, username/contact and credential hash are absent from that audit/result; only the authentication table stores the required one-way password hash. The new service logs no body, query, contact, password, token, SQL row or raw exception. It never writes `django_admin_log` using a guessed actor namespace: the previously documented tss.auth_user/PosUser lineage gate remains intact.

Same-owner/original-UUID replay returns the first result; input/actor reuse conflicts. Concurrent same-UUID requests create exactly one account/audit. Concurrent distinct usernames for the blank-email slot commit only one account and return the explicit setup conflict for the other. Failed mandatory receipt insertion rolls the account back. Replaying after the target is archived does not restore it, reset its password or create another identity. Recovery checks current authority and owner; it is a point idempotency proof on WRITER, not an unrestricted historical MySQL report.

The frontend journal stores only current-owner ID, original operation UUID and time. Username/password/confirmation/contact/hash never enter browser persistence. Password fields clear after dispatch. Lost replies/reload recover through GET, with exact owner/original-UUID response checks. A404 **retains** the original UUID: explicit re-entry retries that same operation instead of starting a second creation while an earlier request may still be in flight. Journal failure prevents dispatch. Actor switch/unmount aborts current continuations, and all requests retain captured actor headers/signals. It does not automatically sign into, activate MFA for, assign stores to or fabricate a commerce mirror for the new account.

## Store url_key is overwritten, not a missing editor

Source `stores/admin.py` registers plain ModelAdmin. The form exposes required `url_key`, but `Store.save()` (`stores/models.py:143+`) calls `super().save()`, unconditionally replaces it with `https://thesouledstore.com/?store_id={id}`, then saves again. The real ModelForm/native oracle accepts arbitrary/javascript-like supplied strings with physically valid store fields and proves that only the generated URL persists. Existing `storePublicUrl()` already matches these persisted bytes. Adding arbitrary URL persistence would create behavior absent from the source; no such editor is introduced.

The source constructor dynamically fills location choices from `STORE_LOCATION_CODE`; the oracle initializes those actual choices and uses codes within verified physical width10. Source optional/nullable store fields are not evidence that every blank inherited form is executable: the source model permits NULL for several fields whose verified physical columns are NOT NULL (`store_name`, coordinates, addresses, phone, short_name, gstin). An actual form accepting those blanks is shown to fail strict physical insertion. The existing strict custom store flow avoids this broken combination. The source model's location-code maximum255 also exceeds verified physical width10; long configured codes are not newly advertised as supported. These are source/physical incompatibilities, not missing arbitrary URL-edit or blank-store product features.

This add slice does not re-certify the existing merged managed-profile edit form. In particular, its empty-email→NULL contract remains a separate boundary from the actual UserAdmin add/`AbstractUser.clean()` result proved here. Source grant/actor import, deployed business timezone and whole configured workflow acceptance remain explicit; no release-coverage verified status changes.

## Integration and executed scope

- `registerOperatorModelAccounts(app,config,db)` from `administration/model-accounts/index.ts`: `GET /api/v1/admin/operator-model-accounts/capabilities`, `POST` base, `GET /:operationId`. Strict POST `{operationId,username,password,confirmation}`. Safe reply `{id:<created operator>,operationId,actorId,status:'success',message:'Administrative account created.'}`. All routes explicitly trace `administration.operator-model-account`, rate limit and send private/no-store.
- No new migration, environment flag, worker, grant or provider. Existing administration base/access migrations and verified source-access reconciliation are required. Do not turn reconciliation on with fabricated grants. IDs are retained and never reused/deleted.
- Frontend default `pages/administration/model-accounts/index.tsx` exports `OperatorModelAccountsPage({user})`; root app/nav may mount `/administration/model-accounts` for internal role1. Server capability remains current authoritative staff/superuser permission. Standard staff creation is unchanged.
-12 native checks cover actual pinned forms/defaults/Store URL save and physical blank failure; real uniqueness and email-alias guard; source AND permissions/current hardening;20 concurrent UUIDs; distinct-UUID slot race; secret-free receipt; actor/replay/archival behavior; rollback; IDs above2^53; source long passwords and strict traced resources. Three frontend journal/receipt units and seven actual Chromium component workflows cover exact form/input fields, clearing secrets, lost reply→reload→GET,404→same-UUID re-entry, persistence failure, actor/receipt fencing and capability denial. These controlled checks do not certify deployed source grants, timezone, identity providers or complete source administration workflows.

```sh
# backend, Node24: creates/drops only randomized localhost fixture schemas
MODEL_ACCOUNTS_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_model_accounts_test \
 node node_modules/vitest/vitest.mjs run tests/administration/model-accounts --maxWorkers=1
node node_modules/typescript/bin/tsc -p tools/administration/model-accounts/tsconfig.tests.json
# uv/Django4.2.5/PyMySQL1.1.1 source oracle; database URL goes through stdin only

# frontend: random Vite port/OS-temp dependency cache, no shared dist/default server
node node_modules/vitest/vitest.mjs run tests/administration/model-accounts/pending.test.ts --maxWorkers=1
ADMINISTRATION_BROWSER_TESTS=true node node_modules/vitest/vitest.mjs run tests/administration/model-accounts/browser.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc -p tests/administration/model-accounts/tsconfig.tests.json
```
