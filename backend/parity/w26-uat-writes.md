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

## Round 2 (20 November 2026, 02:57–03:36 IST)

Before the first write, a fresh `AUTO_INCREMENT` baseline was taken (`orders` 19055005, `order_stores` 786812, `has_products` 79083090, `comments` 159990769, `pos_exchange_log` 81).

All rows are store 7, counter 7, product 262148 (TSS Originals: Book Lover, L).
API-v2 UAT `pos/order` wrote the `orders`, `order_stores` and `has_products` rows and its own side tables (`order_addons`, `order_address_mapping`, `order_cancel_message_mapping`, `amount_to_be_refunded_log`). The rewrite wrote the payment and finalisation fields, `comments` and `pos_transaction_logs`.

### Orders

| Order | `order_stores` | Invoice | Customer | Flow | State now | Note |
|---|---|---|---|---|---|---|
| 19055005 | 786812 | S062627INV00263 | 12132565 | Cash | Paid (4/3) | Line 79083090 `status=''`: written before fix `18f62c77`. **Cleanup:** `UPDATE has_products SET status='DELIVERED' WHERE id IN (79083090,79083091,79083093);` |
| 19055006 | 786813 | S062627INV00264 | 12132565 | Others (1001), message `W26-UAT-REF-0001` | Paid | Line 79083091 `status=''` (same cleanup as above) |
| 19055007 | 786814 | S062627INV00265 | 12132565 | Paytm staging card | **Cancelled** (2/4), line CANCELLED | Paytm answered `0029 Invalid Merchant or Terminal`. Cancelled through the app at 03:25:17 IST; stock restored +1 |
| 19055008 | 786815 | S062627INV00266 | 12132565 | Fast cash | Paid | Line 79083093 `status=''` (same cleanup as above) |
| 19055009 | 786816 | S062627INV00267 | 12132565 | Cash, after the enum fix | Paid, line DELIVERED | Return attempted 3 times: refused, Vinculum UAT did not confirm (`RETURN_WAREHOUSE_PENDING`). No `return_orders` row |
| 19055010 | 786817 | S062627INV00268 | 12132565 | Others (1001), after the fix | Paid, line DELIVERED | Exchange attempted: `pos_exchange_log` **id 81**, `FAILED_NEEDS_MANUAL_FIX` (Vinculum UAT did not confirm) |
| 19055011 | 786818 | S062627INV00269 | 7630106 (walk-in) | Offline cash, provisional `OFF-7-7-5DB39517-1` | Paid, `is_offline_order=1` | Comment 159990774 |
| 19055012 | 786819 | S062627INV00270 | 7630106 (walk-in) | Offline card, reference `W26-UAT-CARD-0001` in `order_stores.message` | Paid, `is_offline_order=1`, `is_manually_paid=1` | Comments 159990776 (billed) and 159990778 (finance reconciliation flag) |

- `comments` 159990769–159990778: 10 rows, all on the orders above.
- `pos_transaction_logs`: 8 rows on the orders above.
- `product_store` (7, 262148) stock: 380 before, 374 after.

### Redis

- I deleted one `pos:customer_cart_lease:12132565` key at 21:33 UTC. It had been left held for 12 h by a bug that is now fixed (`a88f22d0`) and blocked every new checkout for the test customer.
- The worker processed 6 job records queued since round 1, once the claim fix `0abc6fe8` was in place:
  - order SMS: 4 records;
  - hyperlocal auto-reject: 2 records.

### Messages (allowlist active in both processes)

| # | Time (IST) | Flow | Trace / request ID | Recipient | Outcome |
|---|---|---|---|---|---|
| R1 | 03:09:30 | Customer OTP, 12132565 (`omnichannel-sendotp`) | `e687bc9e-9acb-4161-83eb-8e454d3361cd` | Customer phone and email (allowlisted) | **Sent.** Guard permitted it and API-v2 UAT answered 200. The user can confirm receipt. The code was not entered: it is delivered only to the user |
| R2 | 03:13–03:24 | Order SMS for 19055005, 19055006, 19055008 and 19055009/10 (`core.tasks.send_sms`) | `f7646089-cf62-40a1-b81e-e8dd441b265e`, `fb6d5792-04af-45e4-ac8f-4f96421178b1`, `cad548b7-d570-40e2-aab2-79b051b206b4`, `2633606a-ad5c-4c3a-8317-7383c98ec72c`, `7c44f848-7c87-4146-9f9e-5b5284ecc894`, `e286a2d4-8530-457f-9e70-8d4a7ec08f49` | Order contacts (allowlisted) | **Permitted, not delivered.** API-v2 UAT `omnichannel-sms` answered 500 |
| R3 | 03:35:38 / 03:35:43 | Order SMS for the walk-in offline orders 19055011/12 | `9c4f04bb-3788-4cdd-a023-485ea9b75bd2` | Walk-in account 7630106 (not allowlisted) | **Suppressed** (`outbound.suppressed`, `order-sms`, `not-allowlisted`) |
