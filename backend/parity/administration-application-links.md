# Legacy application QR and download components (W8d, schema freeze)

Source `78d5b63`: `core/views.py:2795 MposDownloadQr`, `:2846 AjaxGenMposDownloadQR`, `:2900 MposDownloadThankYou`,
`:2949 MposDownloadLink`, `:3161 MposUserDownloadApp`, `:3182 UserToApp`; templates `core/templates/mpos_download/*`
and `core/templates/user_to_app/index.html`. Routes, options and Redis keys: `administration-application-links-contract.json`.

All state is Redis with TTLs, as legacy; the four `pos_rewrite_*` tables are no longer used. The only durable write is
`pos_to_app_logs(store_id, scanned_at)` per customer scan, as legacy.

## Staff installer (C24–C27)

| Legacy | Rewrite |
| --- | --- |
| TOTP secret `mpos_download_qr_{uid}` (EX `POS_AUTH_USER_SECRET_EXP`), 6-digit OTP per `MPOS_DOWNLOAD_QR_EXP_SEC` period, QR `/mpos-download-thank-you/?token=<JWT{email, otp}>` | Grant per operator and period in `pos:staff_download:*` (ids and expiry only); QR `/application-links/staff#<HMAC token>`. Same QR returned within a period; countdown and automatic renewal as the legacy page. |
| `AjaxGenMposDownloadQR` accepts any posted `user_id` | QR only for the signed-in operator (security). |
| Franchise excluded (`user_type_exempt("[2]")`) | Same; activation and download re-check that the operator is active and not franchise. |
| Thank-you page: OTP check, sets `mpos_is_download_activate_{email prefix}` EX `MPOS_DOWNLOAD_LINK_EXP`, rotates the secret | Activation once per QR (`SET NX`), activation EX `MPOS_DOWNLOAD_LINK_EXP`, operator grant rotated. Retrying the same activation operation returns the same activation. |
| Download link consumes the activation key and proxies `APP_APK_URL` (`requests.get`, content-type passthrough) | One download operation per activation (`SET NX`), then `APP_APK_URL` streamed with its content type as `attachment; filename="mpos.apk"`. Retrying the same download operation is allowed. |

Removed rewrite-only pieces: the revoke route (`DELETE …/staff-qr/:grantId`), the staged local APK with hash/size
pinning (`POS_STAFF_APK_*`), authentication-epoch binding. The legacy staff paths are not served: a staff QR lives for
one period (60 s) and nothing printed depends on it.

## Customer application QR (C33, C34)

| Legacy | Rewrite |
| --- | --- |
| `MposUserDownloadApp`: QR `/user_to_app?store_id=<check-in store>` | QR `/application-links/customer#<storeId>.<HMAC(SESSION_SECRET, store)>` for the operator's check-in store (deterministic per store, no table). |
| `UserToApp`: raw-SQL INSERT `pos_to_app_logs`, then `dynamic_short_link_s_id_{store}` or POST `{MAIN_SITE_API_V2}firebase-dynamic-link {link}` → `object.shortLink` or `POS_APP_REDIRECT`, cached EX 3600, 302 | Same order and key. Token scans (`POST …/customer-scans`) keep a replay receipt `pos:idem:app_scan:{operationId}` EX 3600 so a retried request does not log twice. A provider call per store is serialised by `pos:app_link_lease:{store}`. |
| `GET /user_to_app?store_id=` | **Served** for already printed QR codes (302). |

Security decisions: the INSERT binds the store id (legacy formats it into SQL); unknown or inactive stores get 410 and
are not logged (legacy logs any value); a provider short link outside `POS_CUSTOMER_APP_ORIGINS` is replaced by
`POS_APP_REDIRECT`; a cached value written by legacy that is outside the allowlist is served as the fallback.
Deployment: the reverse proxy on the legacy POS host must route `/user_to_app` to the backend.

## Messages (S4)

| Case | Legacy | Rewrite |
| --- | --- | --- |
| Missing `user_id` on QR refresh | 200 `{status:400,"User ID not in payload"}` | not applicable (session user) |
| Expired/used QR or activation | thank-you page "Oops! Looks ike your download link is expired" / redirect to thank-you | 410 `APPLICATION_LINK_EXPIRED` "This application link expired or was already used. Request a new QR code." |
| Franchise or inactive operator | redirect "Permisssion denied" | 403 `APPLICATION_LINK_DENIED` |
| Not configured (`APP_APK_URL`, `MAIN_SITE_API_V2`) | request error | 503 `APPLICATION_LINK_UNAVAILABLE` |
| Provider failure | 500 | 503 `CUSTOMER_APPLICATION_UNAVAILABLE` |
| No check-in | page shows "Nothing" with no QR | 409 `CHECK_IN_REQUIRED` |

## Checks

`tests/administration/application-links.test.ts` (QR expiry oracle, token separation, options, provider body/fallback,
`APP_APK_URL` streaming) and `application-links.mysql.integration.test.ts` (isolated MySQL + in-memory Redis store:
same-period QR, Redis value shape/TTL, single activation, rotation, single download, expiry, deterministic customer
token, receipt replay, legacy cache key/TTL, `/user_to_app` 302 and store validation, same-origin public proof). Run
with `APPLICATION_LINK_MYSQL_TEST_URL=mysql://root@127.0.0.1:<port>/pos_rewrite_application_links_test`.

Open: the current `firebase-dynamic-link` endpoint behaviour (Firebase Dynamic Links shut down on 2025-08-25) and real
device/browser handoffs are not verified here.
