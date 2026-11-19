# W26 UAT write ledger (20 November 2026, IST)

Every write the W26 run caused in UAT. You can use it to audit or clean up. W26 deleted nothing.

**Scope.**
- UAT MySQL `tss` on the UAT RDS cluster.
- The shared UAT Redis.
- Outbound messages sent through the W25 allowlist guard.

**How it was checked.**
- I snapshotted `information_schema.TABLES.AUTO_INCREMENT` for all 576 tables before the first write (19 Nov 19:52 UTC) and again after the last write.
- Only four tables grew:
  - `store_day_close`, `store_day_banking` and `pos_special_permission_activity_log`: W26 wrote these rows (listed below).
  - `reshipping_order_log`, `has_product_clickpost` and `vs_scheduled_inventory_sync_log` also grew, from other UAT activity. Their rows are not linked to user 268 or store 7.
- **No orders, invoices, returns, exchanges, gift cards, vouchers, terminal transactions or report-export rows were created.** Checkout was blocked before API-v2 was called (see the report). API-v2 UAT received **zero** calls from this run.

## MySQL

| # | Time (IST) | Table | Row | Change | How | Cleanup |
|---|---|---|---|---|---|---|
| 1 | 02:10:43 | `stores` | id 7 | `per_hour_threshold` 5 → 6 | Admin › Store management › Edit (desktop app) | Reverted in row 2 |
| 2 | 02:10:52 | `stores` | id 7 | `per_hour_threshold` 6 → 5 (revert) | The same dialog | None. Final value confirmed as 5 by SQL. `updated_at` now reads 2026-11-20 02:10:47 |
| 3 | 01:33:37 | `pos_special_permission_activity_log` | id 92 | Insert: `pos_user_id=268`, platform `Gift Card`, "Viewed the gift card batch list" | Opening the gift-card batch page. This is the legacy audit of a page view | Optional delete |
| 4 | 02:10:52 | `pos_special_permission_activity_log` | id 93 | The same insert, from a second visit | The same page | Optional delete |
| 5 | 02:16:48 | `store_day_close` | id 36 | Insert: store 7, `close_date` 2026-11-19, `CLOSED`, version 1, `closed_by_id=268`, every amount 0.00 | Day close › Close this day › File close (request `4091097b-247a-4cf4-aaa0-42955c3a7f4e`) | Delete if this UAT day should stay open |
| 6 | 02:16:48 | `store_day_banking` | id 8 | Insert: store 7, `banking_date` 2026-11-19, amount 0.00, `updated_by_id=268` | The same day close | Delete together with row 5 |
| 7 | 01:21 to 02:19 | `pos_user` | id 268 | `last_login` updated on each of the 20 sign-ins (last value 2026-11-20 02:19:13) | Login | None needed |

## Redis (shared UAT Redis, `pos:` keys only)

- Sessions, login challenges (fixed OTP), store check-ins for user 268, offline-device eligibility and rate-limit counters.
- Every key carries the module's TTL. None outlives 24 h, except the check-in, which expires on 20/11/2026 at 23:59:57.
- The only `pos:jobs:*` keys are the worker heartbeats (`pos:jobs:worker:*`, 30-second expiry). No job was queued: the one export request was refused first.
- Legacy Celery keys (`_kombu.*`, `celery`) were never touched.

## Outbound messages (through the W25 allowlist guard)

| # | Time (IST) | Flow | Trace / request ID | Recipient | Outcome |
|---|---|---|---|---|---|
| M1 | 02:08:48 | Scheduled Slack report `hyperlocal-store-status` (`POST /api/v1/report-deliveries`) | `e01a2df2-9296-48f0-8b0d-a33e94fe9add` | Common `SLACK_URL`, which is allowlisted | **Delivered** (1 Slack post, 18 records) |
| M2 | 02:12:52 | Day-close pending alert, scoped to store 7 (`POST /api/v1/webhooks/day-close-alerts`, close date 2026-11-18) | `2cc995f8-4f7c-44d2-a4b1-e704b8e7aba0` | Store 7 `slack_group_url` (not allowlisted) | **Suppressed** (`outbound.suppressed`, flow `report-slack-post`, reason `not-allowlisted`) |
| M2b | 02:12:52 | The same alert's common-channel copy (`COMMON_GROUP_ALERT_ON=1`) | `2cc995f8-4f7c-44d2-a4b1-e704b8e7aba0` | Common `SLACK_URL`, allowlisted | **Delivered** (1 Slack post) |
| M3 | 02:13 | Staff login OTP resend, user 268 | `5d352496-dcf0-44d1-a3bb-bbbd157ed711` | Operator email (allowlisted) | **Not sent, by design.** User 268 is the fixed-OTP user, so the backend issues the fixed code (`identity.login-otp.fixed-issued`) and sends no mail |

The egress proxy logged exactly two connections to `hooks.slack.com`, matching M1 and M2b.
No connection was made to Netcore, Gupshup, Freshdesk, S3 or any other host.

## Primary-agent write, 20 November 2026 (user-approved)

- `users` 7630106 (operator 268's storefront account, `user_type` 8): `is_block` 1→0 and `is_disabled` 1→0, so checkout can run in UAT.
- Revert with `UPDATE users SET is_block=1, is_disabled=1 WHERE id=7630106;`
