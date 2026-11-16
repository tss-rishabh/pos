# Self-service operator profile

Source: `users/views.py:295` (ProfileView), `:508` (CustomPasswordChangeView),
`users/forms.py:42` and the configured Django 4.2.5 validators. Source remains
unchanged. This document is component evidence, not a full parity certificate.

- GET/PATCH `/api/v1/operators/current/profile`: names, gender, age, email/phone,
  OTP contact and delivery method; server-expiring session information. Only
  writer-current role1 may change its own login email/phone, matching the source.
  Other operators can edit their own remaining profile fields. An HMAC revision
  rejects stale changes. Contact/OTP changes additionally require the current
  password; empty OTP destinations are rejected rather than creating a lockout.
- PUT `/api/v1/operators/current/password`: current password, matching new
  password/confirmation and source password validation. Hashing uses the shared
  Django-compatible PBKDF2 helper. The current session rotates after a credential
  change; prior sessions/challenges invalidate. Username/email are included in
  credential fingerprints along with the MFA/contact/role fields.
- The original 20,000 common-password list, license and validation source are
  pinned under `resources/auth` and `tools/identity`. The AST oracle executes
  only pure dependency validators, without Django startup. 350 fixtures cover
  Unicode digits, code-point length, whitespace, similarity and common passwords.
- Profile/cover images use owner-bound UUID reservations and the existing
  `uploads/users/profile_image` / `uploads/users/cover_image` locations. Signed
  private uploads bind bytes, SHA256, type and size. Current SDK metadata and
  full decoded pixel data are checked before attachment. Only JPEG/PNG/WebP/GIF
  are accepted: 10MiB, 16Mi pixels including animation frames, at most120 frames,
  bounded native processing and one concurrent decode per process. Raw decoder
  errors and warnings never reach logs. These explicit upload bounds tighten
  the legacy unbounded ImageField behavior and need acceptance during rollout.
- Reads stream through authenticated, writer-authorized same-origin endpoints
  with `private, no-store`, `nosniff` and restrictive CSP. New signed uploads
  require all four S3 Block Public Access protections. A public/unverified bucket
  fails closed; no live bucket settings were changed for these tests.

Apply `migrations/0005_profile_media.sql` through the normal runner. Supervise
`npm run worker:profile-media` with `PROFILE_MEDIA_WORKER_ENABLED=true` to reclaim
abandoned/replaced rewrite-owned images. Cleanup starts after upload URLs expire
plus a grace period, retains every currently referenced image, and never queues
legacy/default objects without rewrite ownership evidence. Bounded lease/retry
jobs carry the original request/user IDs; logs omit filenames, object keys,
contacts, checksums, URLs and file bytes. Requeue an exhausted job explicitly
with `npm run worker:profile-media -- --retry-job JOB_UUID` after fixing storage.

`tests/auth.mysql.integration.test.ts` verifies actual local SQL races, revisions,
authorization, password/session changes and media attachment/cleanup. The native
image decoder suite rejects truncated/mislabeled files and excessive pixels.
`frontend/e2e/profile.spec.ts` verifies the production-built edit/password/offline
interface; the media browser workflow is being completed. Real private-bucket
and production account acceptance remain outstanding. No live uploads or emails
were sent.
