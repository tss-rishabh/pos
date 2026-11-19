# W5 report — orders, fulfilment, invoices and customers

Branch `w5/orders` from `1a651f9`. Legacy source: `backend-pos-web@78d5b63` (pinned export). All `file:line`
references below are legacy unless they start with `backend/` or `frontend/`.

Status: **implementation phase**. Nothing here is parity certification. No live service was contacted;
every external call is behind an adapter that the tests fake. MySQL tests ran on an isolated loopback
MySQL 8.4 with an empty `sql_mode`.

The work was split across three sub-agents with exclusive paths (fulfillment, legacy-fulfillment,
order-history). Their full sections are reproduced in the appendices; the consolidated lists below
cover all of W5.

## Checks at the final commit

| Check | Result |
|---|---|
| backend `npx tsc --noEmit -p .` | pass |
| backend `npx eslint .` | pass |
| backend `npx vitest run tests/orm-metadata.test.ts` | pass, 0 mismatches |
| backend W5 suites with loopback MySQL (fulfillment, legacy-fulfillment, legacy-order-status, order-history, order-search, invoice-documents, customer-*, product-feedback, api, logging, release, parity) | 238 pass, 8 skipped; 1 failure = the pre-existing `customer-history` Latin1 case also failing at `324d62d` (w7-report §4) |
| backend full `vitest` without MySQL | 2 failures, both in `tests/migrations.test.ts`: `migrationPaths` still lists the module SQL files this workstream deleted (primary agent removes the registry, as the brief says) |
| frontend `npx tsc --noEmit -p .`, `npx eslint .` | pass |
| frontend `vitest --maxWorkers=2` | 55 files / 259 tests pass, 22 files skipped (browser env) |

## What changed in the parent's own modules

### Shared groundwork
- `backend/src/modules/fulfillment/order-redis.ts`: the `OrderRedis` port (`get`, `set` with `NX/EX/PX`,
  `del`, `compareAndDelete`, `lRange`) with a node-redis client and an in-process twin for tests. Method
  names and option shapes match W3's `RedisPort`, so the primary agent can pass that port instead.
- `buildApp(config, { logger, jobs })` takes an optional `JobProducer`; `orderRedis` is created once and
  closed on shutdown.

### Whole-order status (C22, C12) — `legacy-order-status`
- `transport.ts` is now only `syncRepoStatusApi` = `Helpers.call_status_api` (`helpers/helpers.py:1133-1158`):
  one POST of `{orderId, has_product_ids, platform}` with `Content-Type` and `x-api-key`, timeout 10 s, to
  `BACKEND_SYNC_API_BASE_URL + /store-order/status` (or `/order/status` for express lines). Unset base URL
  is skipped; any failure is only logged; never retried. The fulfillment and legacy-fulfillment modules use
  the same function.
- `POST /api/v1/stores/:storeId/orders/:orderId/status-requests {platform}` = `AjaxUpdateStatusVincView`
  (`order/views.py:4417-4445`): every `has_products.id` of the order, one synchronous call, reply
  `"Request has been queued for processing"` whatever the outcome.
- `GET …/fulfillment-status` = the "Vinculum Status" tab (`order/views.py:451-464`, `show.html:303-340`):
  last row per platform from `vinculum_auto_delivered_logs`, CREATE = SUCCESS once PACK succeeded, and
  `processed` false for "Order Placed"/"Cancelled".
- C12 `core.tasks.push_vinc_order_for_all` (`core/tasks.py:225-229`): `registerJobHandlers(registry, {config, db})`
  sends PACK for every line; `enqueuePushVincOrderForAll(jobs, orderId)` enqueues on queue `core`.
- Removed: the in-process dispatch loop, the capability/HMAC/receipt protocol, command recovery, and the
  rewrite-only return repair obligations and recoveries (routes, UI, tables).
- Frontend `pages/order-status`: the legacy table with a retry button per stage that has not succeeded.
- Test: the rewrite's requests are compared with the captured pinned-source golden
  (`tests/golden/legacy-order-status/source.json`).

### Customer website handoff (C23)
- `POST /api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-website-handoffs` returns
  `{webUrl, sessionMinutes}` with `webUrl = {WEB_URL}/pos/login/?token=…&api_key=…&pos_store_id=…&pos_user_id=…`
  (`order/views.py:4495-4516`). The token is `Helpers.create_token(user_id, expiry_in_min=JWT_CUSTOM_EXPIRY_MIN)`
  (`helpers/helpers.py:533-564`): `{sub, iat, exp}` in epoch seconds, HS512 with a `2f.` prefix when
  `users.is_two_fa = 1`, else HS256. `pos_user_id` is the first `users` row with `pos_admin_id` = operator,
  else 0. Keys: `TSS_JWT_HS256_KEY`/`TSS_JWT_HS512_KEY` (legacy `SECRET_KEY`/`SECRET_KEY_512`).
- The one-time grant, receiver redemption and revoke routes and their table are deleted.
- Frontend: the legacy "Looking to place an online order? Place order now!" action and session-minutes note.
- Test: compared with the captured pinned-source golden vectors (algorithm, prefix, claims, query keys).

### Customer contacts (C9, C10)
- `POST …/customer-contacts/telephone {phoneNumber}` and `POST …/customer-contacts/email {email}` =
  `AjaxUpdateUserMobile`/`AjaxUpdateUserEmail` (`order/views.py:3369-3399`): "already registered" check across
  all `users` rows, then `UPDATE users SET telephone|email, updated_at` (business wall clock, as Django
  `save()` with `USE_TZ=False`). `GET …/customer-contacts` tells the UI which legacy prompt applies.
- Deleted: the two-stage OTP challenge, deliveries, limits, mutations, mutexes, reservations, revisions,
  prune, projection and `worker:customer-contacts` code. `authority.ts`, `crypto.ts`, `legacy-schema.ts`,
  `references.ts`, `revisions.ts` and `reservations.ts` keep only the helpers checkout, customer OTP and
  global vouchers import (see caller notes).

### Product feedback (C11)
- Writes to `product_rating_user` unchanged (one row per option, `platform='WEB'`, comment and
  `is_default` on option 0, `order/views.py:3401-3430`). The replay receipt moves from
  `pos_rewrite_product_feedback_receipts` to Redis, written after commit.

### Customer workspace (`customer-insights`)
- Profile edits keep writing `users` as `AjaxUserUpdateView`/`AjaxUpdateEndUserDataView`
  (`users/views.py:667-690, 1050-1075`). The receipt table moves to Redis; `updated_at` is now the business
  wall clock (it was UTC); the gate on the deleted upstream customer-context contract is removed.
- The insight gateway calls `CUSTOMER_INSIGHT_URL` as `AjaxCustomerInsightView` (`users/views.py:697-801`):
  `X-API-Key` only when set, contact-first identity, `store_id`, store allow-list. The rewrite-only
  `X-POS-Insights-Contract` header, `CUSTOMER_INSIGHTS_ENABLED` and query-contract gates are removed.

### Invoices (A6, A7, A8, `ENABLE_WHATSAPP_INVOICE`)
- `GET /api/v1/stores/:storeId/orders/:orderId/invoices/{store|online|same-day|express}` (JSON) and
  `GET /api/v1/operators/:operatorId/stores/:storeId/orders/:orderId/invoices/:kind/preview` (HTML):
  - store = `ShowOrderInvoiceView` (`order/views.py:769-833`): `GET {ORDER_SHOP_RECEIPT_URL}?order_id&pos_token`,
    where `ORDER_SHOP_RECEIPT_URL` = `MAIN_API_V2_URL + "pos-shop"` when `INVOICE_MIGRATION` (settings `:670`).
    Store scope = `user_stores` (role 1: active stores) unless `access=global-online` (legacy `?cr=1`).
    Any payment status (the old payment-status-4 refusal is gone).
  - express = the same view with `is_hl=1&store_id=` (`_order_cards.html:159`): adds that store's
    `express_line_item.has_product_id`s as `has_product_ids`.
  - online = `ShowOnlineOrderInvoiceView` (`:836-858`): `GET {MAIN_API_V2_URL}show-invoicer?order_id`,
    header `X-POS-Secret`.
  - same-day = `ShowOnlineSDDOrderInvoiceView` (`:861-882`): `GET {SDD_ORDER_RECEIPT_URL}?order_id&is_sdd_shipment=0&pos_token`.
- `ENABLE_WHATSAPP_INVOICE` (settings `:638`, `'false'` default, true for `true`/`1` any case): every
  store/express invoice GET, after the access checks, POSTs `{"order_id": <int>}` to
  `MJML_HOST + 'api/v2/mailr/send-invoice-whatsapp/'` (`helpers/helpers.py:2062-2072`) through the invoice
  adapter. Non-200 and transport errors are only logged (event `invoice-documents.whatsapp-invoice.not-sent`);
  the invoice still renders.
- `GET …/invoices/capabilities` returns the online-detail links legacy renders (`online/show.html:233-243`):
  online when the payment status is "Paid"; SDD when also a split order with both SDD (`order_platform_id`
  3/4) and normal lines (`Helpers.has_multiple_shipment`).
- Deleted: the patched invoice security, scoped, history and global-online proof contracts, the BigQuery
  invoice-history publication, `tools/invoice-documents/bigquery-fixtures.ts` and their tests.
- Frontend: the store kind now reads `invoices/store` from this module.

### Legacy vs new API messages (parent's modules)
| Route | Legacy (HTTP 200 unless noted) | Rewrite |
|---|---|---|
| status push, bad input | `{"status":400,"message":"Invalid Data"}` | 400 `INVALID_REQUEST` "Check the request fields." |
| status push, ok | `{"status":200,"message":"Request has been queued for processing"}` | 200 `{message}` same text |
| website handoff, no `user_id` | `{"status":400,"data":{"web_url":""}}` | 403 `CUSTOMER_VERIFICATION_REQUIRED` "Verify this customer before placing a website order." / 404 `CUSTOMER_PROFILE_NOT_FOUND` |
| mobile/email, unknown user | 400 "Invalid user id" | 404 `CUSTOMER_NOT_FOUND` "Invalid user id" |
| mobile, taken | 400 "Number already registered" | 409 `CONTACT_ALREADY_REGISTERED` same text |
| email, taken | 400 "Email already registered" | 409 `CONTACT_ALREADY_REGISTERED` same text |
| mobile/email, ok | "Saved Successfully" / "Email successfully changed" | same texts |
| mobile, already has one | (button hidden) | 409 `CUSTOMER_TELEPHONE_PRESENT` |
| email, not a placeholder | (prompt not shown) | 409 `CUSTOMER_EMAIL_PRESENT` |
| invoice, other store | redirect + "Unauthorized access to the store order." | 404 `ORDER_NOT_FOUND` same text |
| invoice, renderer non-200 | redirect + "Something went wrong !" | 502 `INVOICE_UNAVAILABLE` "Something went wrong! The invoice could not be loaded." |
| invoice, renderer unset | exception text | 503 `INVOICE_UNAVAILABLE` "Invoice delivery is not configured." |
| feedback, invalid | `{"message":"Invalid input","status":"400"}` | 400 `INVALID_REQUEST` |
| feedback, ok | `{"message":"Added successfully","status":"200"}` | 200 receipt |

The fulfillment, legacy-fulfillment and order-history message tables are in `backend/parity/fulfillment.md`,
the legacy-fulfillment parity notes and the order-search/detail parity notes committed by those sub-agents.

## `pos_rewrite_*` tables freed (27)
- legacy-order-status: `pos_rewrite_whole_order_status_commands`, `_attempts`, `_notifications`, `_rates`,
  `_receivers`, `_vendor_calls`, `pos_rewrite_return_repair_obligations`, `pos_rewrite_return_repair_recoveries`.
- customer-contacts: `pos_rewrite_customer_contact_challenges`, `_deliveries`, `_limits`, `_mutations`,
  `_mutexes`, `_reservations`, `_revisions`.
- customer-website-handoff: `pos_rewrite_customer_website_handoffs`.
- product-feedback: `pos_rewrite_product_feedback_receipts`.
- customer-insights: `pos_rewrite_customer_profile_adjustments`.
- fulfillment: `pos_rewrite_fulfillment_commands`, `pos_rewrite_fulfillment_effects` (no W5 writer; W8's
  `finance/alerts.ts` still inserts into it, see below), `pos_rewrite_notification_events`.
- legacy-fulfillment: `pos_rewrite_local_delivery_calls`, `_commands`, `_jobs`, `_orders`,
  `pos_rewrite_legacy_fulfillment_commands`, `pos_rewrite_legacy_rto_receipts`.

Deleted module SQL: `legacy-order-status/{migration,repair-migration}.sql`, `customer-contacts/{migration,contact-revisions-migration}.sql`,
`customer-website-handoff/migration.sql`, `customer-insights/migration.sql`, `fulfillment/{migration,trace-migration}.sql`,
`legacy-fulfillment/migration.sql`, `legacy-fulfillment/lifecycle/{migration.sql,compatibility/001_unset_exception_date.sql}`.
`src/db/migrations.ts` and `tools/operational-reports/build-bigquery-deployment-plan.ts:189` still list them
(primary agent).

## Redis key families
| Key | TTL | Shape | Module |
|---|---|---|---|
| `pos:product_feedback:{operationId}` | `SET NX EX 86400`, after commit | JSON `{operatorId, storeId, counterId, checkoutId, customerId, orderId, productId, requestHash, checkoutVersion, receipt}` | product-feedback |
| `pos:customer_profile_adjustment:{operationId}` | `SET NX EX 86400`, after commit | JSON `{operatorId, storeId, checkoutId, customerId, requestHash, checkoutVersion, receipt}` | customer-insights |
| `express_reject_lock:{store}` (legacy) | `HL_REJECT_LOCK_TTL_SECONDS` (300) | random token, compare-and-delete release | fulfillment O1 |
| `pos:local_delivery_order_lock:{orderId}` | `PX 120000`, compare-and-delete release | random token | legacy-fulfillment |
| `check_in_{uid}`, `check_in_list_{store}` (legacy, read only) | written by auth (W3) | `[store_id, "name"]` / list of user ids | fulfillment, legacy-fulfillment |
| `ORDER_CREATION_BUFFER_TIME_IN_SEC` on `COMMON_REDIS_URL` (legacy common Redis) | none, as legacy | integer seconds | legacy-fulfillment |

Jobs use only the shared `JobProducer`. No new job names: O1, O2, O3, O5, C9 and C12 are all in `JOB_NAMES`.
(C4, Shopify CSV punch-in, is dormant in legacy and was deleted by W2; the O3 follow-up job is C9.)

## Jobs and threads (O1–O5, C9, C12, T1–T4)
| Job | Producer | Handler (`registerJobHandlers` in) | Notes |
|---|---|---|---|
| O1 `order.tasks.auto_reject_timed_out_for_store` | the hyperlocal progress page and content views, viewer's Redis check-in store, queue `order` | `fulfillment/index.ts` | 1-second timer deleted (user decision). Lock as legacy, token release |
| O2 `order.views.auto_hl_order_transfer` | hyperlocal arrival, `order_create`, legacy countdown; inline from pass-order | `legacy-fulfillment/index.ts` | guards re-read `hyperlocal_order_log` |
| O3 `order.views.auto_hl_order_to_online` | O2; inline from courier failure and convert-online | `legacy-fulfillment/index.ts` | enqueues C9 on `core` |
| O4 | dormant | — | — |
| O5 `order.views.advance_order_notification` | arrival (advance orders, `order_create`, countdown); express notify webhook (queue `order`, per store, `send_to_common=false`) | `fulfillment/index.ts` (`createOrderNotification`) | non-advance arrivals notify inline (T5) |
| C9 `core.tasks.new_order_create_communication` | O3 | `legacy-fulfillment/index.ts` | mailr `hyper_local/order_new/` |
| C12 `core.tasks.push_vinc_order_for_all` | **W4** return workflow, after commit (`enqueuePushVincOrderForAll`) | `legacy-order-status/index.ts` | see caller notes |
| T4 express concurrency sync | express actions and O1 | in-process fire-and-forget (`fulfillment`) | not queued, as legacy |
| T1, T2 | auth (W3) | — | — |
| T3 WhatsApp registration fallback | checkout registration (W4) | — | not in W5 paths |

W8 wiring: call `registerJobHandlers` from `fulfillment/index.ts`, `legacy-fulfillment/index.ts`
(`legacyFulfillmentDependencies(config, db, { jobs, redis, logger })`) and `legacy-order-status/index.ts`,
and pass the real producer as `buildApp(config, { jobs })`. Until then O1 page triggers are logged and
skipped, the express notify webhook and hyperlocal arrival return 503 `JOB_QUEUE_UNAVAILABLE`.

## Shared-file edits
- `backend/src/app.ts`: `buildApp` `jobs` option; `orderRedis` creation and close; W5 registration calls
  (`registerFulfillment`, `registerLegacyFulfillment`, `registerProductFeedback`, `registerCustomerWorkspace`
  take `redis`/`jobs`; `registerCustomerContacts`, `registerCustomerWebsiteHandoff` lost their options;
  order search/detail lost the warehouse options); removed the checkout option
  `rejectedInboundRepairDispatcherEnabled` (it read the deleted `WHOLE_ORDER_STATUS_WORKER_ENABLED`).
- `backend/src/db/legacy-schema.ts`: added `HyperlocalOrderLog.delivery_exception_date`, exactly as the
  production snapshot (orm-metadata stays at 0).
- `backend/.env.example`: fulfillment settings (`HL_POLL_INTERVAL_MS`, `HL_PAGE_SIZE`,
  `HL_REJECT_LOCK_TTL_SECONDS`, `HL_TIMED_OUT_REASON_ID`, `OFD_ORDER_STATUS_ID`, `VINC_ALLOCATED_STATUSES`,
  `EXPRESS_ORDER_API_KEY`, `PREORDER_URL`, `PREORDER_INTERNAL_KEY`, `API_V2_APP_ID`, `API_V2_APP_KEY`).
- Not edited: `config.ts`, `package.json`, `contracts.ts`, `security-decisions.md`. New module-local env
  (read by each module's options file): `BACKEND_SYNC_API_BASE_URL`, `BACKEND_SYNC_REPO_API_KEY`,
  `WEB_URL`, `WEB_LOGIN_API_KEY`, `JWT_CUSTOM_EXPIRY_MIN`, `ORDER_SHOP_RECEIPT_URL`, `INVOICE_MIGRATION`,
  `ORDER_RECEIPT_TOKEN`, `SDD_ORDER_RECEIPT_URL`, `MAIN_API_V2_URL`, `MJML_HOST`, `ENABLE_WHATSAPP_INVOICE`,
  `COMMON_REDIS_URL`. `ENABLE_WHATSAPP_INVOICE` is parsed in `invoice-documents/options.ts`, not
  `config.ts`, to avoid a shared-file conflict; move it if the primary agent prefers.

## Caller fixes and notes outside W5 ownership
- **W4 return workflow (C12):** `legacy-order-status/repair-obligations.ts` keeps `lockRejectedReturnScope`
  and a no-op `recordRejectedReturnRepair` so `checkout/return-workflow/repository.ts` compiles. **Until W4
  calls `enqueuePushVincOrderForAll(jobs, orderId)` after the return commits, C12 is never enqueued.**
- **W4 customer contacts helpers:** `readCurrentContactRevision` now always returns 0 (revision table
  deleted, ledger row). `bumpCurrentContactRevision` is a no-op, so the revision assertions in
  `tests/customer-otp/service.mysql.test.ts` and `tests/checkout-order-copy/customer-authority.mysql.test.ts`
  need W4 updates. `lockCustomerContactKeys`/`assertNoActiveContactChangeReservation` only validate input.
- **W4 test edited:** `tests/checkout/customer-mysql.integration.test.ts` — removed the one case that seeded
  the deleted contact-change challenge/reservation tables.
- **W4 store invoice:** `checkout/invoices.ts` still registers `/api/v1/stores/:storeId/orders/:orderId/invoice`
  on the deleted invoice-security/feedback contracts; the W5 frontend no longer calls it. W4 should delete
  it or delegate to `invoice-documents`. W5 imports `sanitizeInvoiceHtml` from that file.
- **W4 checkout session:** contacts, website handoff, feedback and profile all authorize through
  `customer-insights/checkout-scope.ts`, which reads W4's `checkoutSessions` table. It must follow W4's
  checkout-session re-homing.
- **W4 order copy:** `historicalOrderCopyFacts` still reads the never-published BigQuery order views;
  legacy C21 reads MySQL.
- **W8:** remove `worker:customer-contacts` from `package.json` (its entry file is deleted);
  `finance/alerts.ts` still inserts into `pos_rewrite_fulfillment_effects`, which nothing drains — post
  inline with `fulfillmentEffects(...).slack`.
- **Primary:** `tools/verify-project.ts` stages reference deleted tests (`tests/customer-contacts/*`,
  `frontend/tests/legacy-order-status/{browser,repair-browser}-check.mjs`, `tests/invoice-documents/tsconfig.json`);
  `tests/golden/legacy-order-status/commands.json` is orphaned; `deployment.md:225` mentions
  `FULFILLMENT_WORKER_ENABLED`. MySQL tests that call `migrationPlan()` fail while `migrationPaths` lists
  deleted files; three W5-touched tests now apply only existing files.
- **W3:** `w3/auth-rehome` edits `order-history/contracts.ts`, `online-detail/authority.ts`,
  `search/{contracts,format}.ts`; expect merge conflicts. Order-history still reads check-in through
  `administration/checkins.ts`; fulfillment reads Redis `check_in_{uid}` directly.

## Security decisions (for S11+)
Parent's modules:
1. Whole-order status push: legacy `AjaxUpdateStatusVincView` has no login check and takes any order and
   platform. Rewrite: session plus the legacy order-detail store scope; platform limited to the three
   rendered values. Sync-repo base URL must be HTTPS in production, with no credentials.
2. Website handoff: legacy signs a website login for any posted `user_id`. Rewrite signs only for the
   customer attached to the operator's own checkout while verified (exactly when the legacy page shows
   the link); `WEB_URL` must be HTTPS; the URL is never logged; responses `no-store`.
3. Customer contacts: legacy updates any posted `id`. Rewrite updates only the checkout's customer and only
   in the state the legacy page offers (no telephone yet; `temp.id` placeholder email). The legacy email
   regex is rewritten to an equivalent without exponential backtracking.
4. Customer profile: legacy `AjaxUserUpdateView` builds SQL by string interpolation (`users/views.py:684-689`)
   and `AjaxUpdateEndUserDataView`'s base-class order disables its login check. Rewrite: ORM bound values,
   session required, checkout customer only.
5. Invoices: renderer HTML is sanitized (legacy renders it with `|safe`); renderer URLs must be HTTPS so the
   `pos_token` query value never travels in clear text; renderer calls have timeouts. Express (`is_hl`)
   invoices require store access and at least one express line of that store (legacy skipped every check
   and rendered the whole order when the store had none).
6. Product feedback: a second rating for the same order and product is refused (legacy hides the form;
   its backend inserted duplicates).
7. Insight images: only allow-listed HTTPS image origins reach the browser (legacy passed any URL).

Sub-agents (details in the appendices): store-assignment checks on express actions and hyperlocal operator
routes; backend enforcement of the legacy card guards; constant-time webhook secrets with 401 on missing
headers; Slack only to `hooks.slack.com` with escaped text; API-v2 customer JWT expiring after 1 h; courier
tracking URLs returned only if HTTPS; order-search selected-store scope; NW warehouse and transfer-token
exact matching; online detail store-scoped; target-user list not exposed.

## Remaining gaps
- No sandbox or live evidence for any adapter (API-v2, sync-repo, mailr, pre-order, Borzo, Slack, invoice
  renderers, insight service). Only request shapes are tested (golden captures where they exist).
- Job handlers are not wired to a worker (W8), so O1–O5, C9 and C12 do not run yet.
- C12 producer missing in W4's return workflow (see above).
- Invoice sanitizer drops remote images and external styles; the rendered invoice may differ from legacy.
  Needs browser validation. WhatsApp transport errors are logged and the page renders (legacy would fail
  the page on a connection error).
- Online and SDD invoices keep legacy access (any signed-in user, any order id).
- `order_point_cashback` (A4 total points) is outside the production snapshot: detail returns `cashback: null`.
- A4 per-line return/exchange eligibility and the exchange salesperson list stay in W4's `/returns` flow.
- `CORE_WAREHOUSE` hold/unhold is not ported (logged failure); stock holds need the stock-projection
  contracts; arrivals are not deduplicated (legacy parity).
- Courier webhook parses urlencoded bodies only (legacy also took multipart).
- `customer-history` was not re-reviewed for parity this round (it uses no rewrite tables).
- W2 follow-ups not done: ecommerce full sync lives in `administration/ecommerce-sync` (W8 ownership);
  the inventory-workbook xlsx test is moot (export deleted by the user); the 42 missing order-search
  datatable vectors and the default-form capture belong to the validation phase.
- No browser or native acceptance for any W5 page.

## NEEDS USER DECISION
1. **Historical order reads.** spec.md routes historical order ranges to BigQuery with no MySQL fallback,
   but legacy reads every order date from MySQL and the BigQuery order publications never existed. W5
   followed legacy (primary reader, any date). Confirm, or name the raw-layer tables to read instead.
2. **Cross-store read exposure.** Legacy lets any signed-in user open another store's order and invoice by
   explicit order id (`?cr=1`), view any online/SDD invoice, and see every store's express orders on the
   all-stores monitor (customer names included). W5 kept these as legacy. Keep, or limit to role 1 /
   assigned stores?
3. **Two legacy bugs kept for 1:1 parity** in the hyperlocal lifecycle: a split hyperlocal order never moves
   to location/status 21 on courier acceptance (`order/views.py:3504`), and the transfer path writes the
   pass-reason dropdown into `staff_user`. Keep, or fix?

---

# Appendix A — sub-agent section: fulfillment

## A. Fulfillment (express / hyperlocal, routes D1–D16, jobs O1/O5, thread T4)

Commits: 2743606, 6daf379, cc61133, 26f2400, 2adf040, a02f7fa, 3bf845f. Detailed route map and the
legacy → rewrite message table: `backend/parity/fulfillment.md`.

### What changed (legacy `order/views.py` unless noted)
- **Inline side effects, no outbox/worker** (`fulfillment/effects.ts`, `service.ts`). Each action
  writes `express_line_item`, `express_order_status_log` (and for ship `has_products`, `orders`) in
  one writer transaction, then calls the legacy effects in legacy order, at-most-once, failures
  only logged:
  - Accept `:5002-5014`: PENDING→ACCEPTED, log row always written, T4 deltas
    `pending=-n, accepted=+n`, Slack "✅ … Accepted at {store}" (store channel only).
  - Reject `:5015-5040`: active reason required, PENDING/ACCEPTED→REJECTED + reason id, log
    (old status of first line), then `MAIN_API_V2_URL + express-to-warehouse-order`
    (`Ar_app_id/Ar_app_key`, 64-bit ids as JSON numbers) and on success Slack with the new
    order id (`:4849-4905`). D6 P2 fixed: MAIN_API_V2_URL, not TSS_API_BASE_URL.
  - Pack all `:5043-5076`: sync-repo PACK posted **before** the update (`callStatusApi`
    from legacy-order-status), log, T4 `accepted=-n`, Slack store channel only.
  - Ship `:5079-5137` (session) and courier `ship-express-order/` `:5141-5166`: row lock,
    `has_products`→OUT_FOR_DELIVERY, ELI, `orders.order_status` = "Out For Delivery" or
    `OFD_ORDER_STATUS_ID` (26), log; after commit sync-repo SHIP, mailr
    `api/v2/mailr/express-order/out-for-delivery/`, Slack.
  - RTO `:5208-5248`: all lines RTO_DELIVERED, update + log, `BACKEND_SYNC_API_BASE_URL/order/rto`,
    Slack (common copy allowed). Line pack `:4667-4687`: T4 `accepted=-1`.
  - Slack = `Helpers.slack_text_notification` (`helpers/helpers.py:1093-1130`) incl.
    `send_to_common=False` skip and `COMMON_GROUP_ALERT_ON` copy.
  - T4 concurrency sync (`helpers/helpers.py:1616-1670`): in-process fire-and-forget, 10 s
    timeout, ≤16 in flight, Bearer `PREORDER_INTERNAL_KEY`, never queued.
- **Legacy card guards enforced server-side** (D2/D6/D7/D8, `_order_cards.html:98-190`,
  `progress.html:267-285,500-520`): accept/reject need full Vinculum allocation, not timed out,
  pending window not passed; reject refused once ACCEPTED (button commented out on not_packed);
  pack needs a shipment id and an open accepted window; ship needs an AWB.
- **O1** `order.tasks.auto_reject_timed_out_for_store` (`order/tasks.py:149-221`, `expiry.ts`):
  enqueued on queue `order` from `GET /api/v1/fulfillment/progress` and
  `GET /api/v1/fulfillment/progress/orders` with offset 0 (legacy progress view, data view, content
  view `:4919,4952,5296`), never from Load More, for the viewer's Redis `check_in_{uid}` store.
  Handler: lock `express_reject_lock:{store}` SET NX EX `HL_REJECT_LOCK_TTL_SECONDS` (300),
  token-compare release; pending split (allocated → conversion API **before** REJECTED write,
  else TIMED_OUT), accepted auto-pack (PACK status call per order, then PACKED, T4
  `accepted=-items`), TIMED_OUT retry (REJECTED, 🔺 Slack, then conversion as legacy
  `on_commit`), all Slack texts as legacy. The 1 s timer, `worker.ts`, `maintenance.ts`,
  `outbox.ts`, `integrations.ts` and `FULFILLMENT_WORKER_*` are deleted (user decision).
- **O5** `order.views.advance_order_notification` handler = `createOrderNotification`
  (`helpers/notification_helpers.py:40-57`): title "+ to {store}", optional Slack
  "🛵 Order Id: …", `pos_notifications`, `pos_user_notifications` for every id in Redis
  `check_in_list_{store}` (order and duplicates kept), pub/sub push (best effort). Exported for
  the legacy-fulfillment intake (sync calls) and `enqueueAdvanceOrderNotification`.
- **D9 new-order notify** `AjaxExpressOrderNotifyView` `:5252-5281`: served at
  `/orders/ajax-express-order-notify/` and `/api/v1/orders/ajax-express-order-notify/`,
  `APPID`/`APPKEY` headers, raw JSON `{order_id, store_ids}`, legacy replies; enqueues O5 per
  store, queue `order`, `send_to_common=false`. Old `/api/v1/webhooks/express-orders` removed.
- **D16 courier ship**: `/orders/ship-express-order/` and `/api/v1/orders/ship-express-order/`,
  `apikey` header, urlencoded `order_id`/`awb`, no `commandId`, legacy replies (HTTP 200 with
  `"status":"400"` bodies, 401 `wrong api key`). Old `/api/v1/webhooks/express-shipments` removed.
- **D2/D3/D4/D10 progress**: server resolves the Redis check-in store; legacy tab counts
  (`_hl_get_tab_counts` `:4696`) and page ordering (`_hl_get_orders_for_tab` `:4749`, page size
  `HL_PAGE_SIZE` 20, `has_more` from the tab id set) on the `data` reader; DTO adds user id,
  payment/order status (Partially Shipped→Shipped), created at, min expiry, is_timed_out, line
  price/image/parent product link. UI: legacy table columns and badges, live countdown/EXPIRED,
  Waiting for Allocation/Shipment ID/AWB, packed-tab Invoice (`InvoiceDocumentAction`
  kind `express`) and Shipping Label, Mark as RTO/RTO Done, append Load More, poll at
  `HL_POLL_INTERVAL_MS` (100 000) with the "new orders" banner. Commands post once, no command id.
- **D13/D14 all-stores monitor** (`order/hl_all_stores.py`): MySQL `data` reader (BigQuery
  reader and `BQ_FULFILLMENT_*` removed), every store for any signed-in user, empty store list
  = all stores, optional dates (swapped when reversed), invalid tab/page size/sub-status/order
  ids sanitised as legacy; `/store-monitoring/defaults` gives today + check-in store, used on
  each page open (legacy first GET).
- **D15 admin edit** `:5505-5580`: role 1 only (current, active `pos_user` row); no store
  assignment or user_type requirement any more.
- Notification list/read/stream now read check-in from Redis `check_in_{uid}`; read receipt
  also requires the check-in store.

### `pos_rewrite_*` tables freed
`pos_rewrite_fulfillment_commands`, `pos_rewrite_fulfillment_effects` (no longer used by
fulfillment), `pos_rewrite_notification_events`. `fulfillment/migration.sql` and
`trace-migration.sql` deleted. `fulfillment/schema.ts` still exports the
`pos_rewrite_fulfillment_effects` Drizzle definition **only** because `finance/alerts.ts` (W8)
inserts its day-close Slack alert there; nothing drains it any more (see caller fixes).

### Redis key families
| Key | TTL | Shape | Owner |
|---|---|---|---|
| `express_reject_lock:{store}` (legacy name) | `HL_REJECT_LOCK_TTL_SECONDS` (300 s) | random token; released by compare-and-delete | O1 |
| `check_in_{uid}` (legacy, read only) | set by auth | JSON `[store_id, "name"]` | W3 writes |
| `check_in_list_{store}` (legacy, read only) | set by auth | list of user ids | W3 writes |
No new `pos:` keys (legacy has no idempotency for these actions; state-filtered updates are the guard).

### Shared-file edits
- `backend/src/app.ts`: only `registerFulfillment(app, config, db, { redis: orderRedis, jobs: options.jobs })`.
- `backend/.env.example`: added `HL_POLL_INTERVAL_MS`, `HL_PAGE_SIZE`, `HL_REJECT_LOCK_TTL_SECONDS`,
  `HL_TIMED_OUT_REASON_ID`, `OFD_ORDER_STATUS_ID`, `VINC_ALLOCATED_STATUSES`,
  `EXPRESS_ORDER_API_KEY`, `PREORDER_URL`, `PREORDER_INTERNAL_KEY`, `API_V2_APP_ID`, `API_V2_APP_KEY`.

### Wiring W8 must do
- Call `registerJobHandlers(registry, { config, db, redis, log, bus? })` from
  `backend/src/modules/fulfillment/index.ts` (O1 + O5). Until `buildApp` receives `jobs`, O1 page
  triggers are logged and skipped and the notify webhook returns 503 `JOB_QUEUE_UNAVAILABLE`.

### Caller fixes outside ownership
None edited. Pending for W8: `finance/alerts.ts` still writes `pos_rewrite_fulfillment_effects`
(DAY_CLOSE_PENDING Slack) which no worker delivers any more; it should post inline
(`fulfillmentEffects(db, options).slack`) as legacy `report/views.py:2573` does, then
`fulfillment/schema.ts` can be deleted. `deployment.md:225` still mentions
`FULFILLMENT_WORKER_ENABLED` (doc only).

### Security decisions
1. Session express actions require the operator's store assignment and current active account
   (legacy accepted any `store_id` from any signed-in user).
2. The legacy UI-only action guards (allocation, expiry windows, shipment id, AWB, no reject after
   acceptance) are enforced by the backend too, so wrong-state moves and empty-AWB OFD mails
   cannot be forced by direct POSTs.
3. Shared secrets for both webhooks compared in constant time; an unset secret never matches
   (legacy compared `None` too, so unset still rejects).
4. Slack: interpolated text escapes `&<>`, mentions/unfurls disabled, only `https://hooks.slack.com`
   webhooks are called (legacy posted to any stored URL).
5. Shared-secret env values accepted at any non-empty length (legacy contract; the senders own them).
6. The all-stores monitor follows legacy: every signed-in user sees every store's express orders
   (names, user ids, amounts). Kept for parity; flag for user review.

### Remaining gaps
- No sandbox/live evidence for API-v2 conversion, sync-repo, mailr, pre-order or Slack calls; all
  covered only by request-shape tests (golden capture for status/RTO/mailr/delta).
- Job handlers are not wired into a worker yet (W8); O1/O5 do not run until then.
- Courier webhook: multipart bodies not parsed (legacy `request.POST` would); urlencoded only.
- Notify webhook validates ids as positive integers (legacy accepted anything truthy).
- Progress UI renders HTML-free cards; legacy image hover preview not reproduced.
- Browser/native acceptance of the progress and monitor pages not run (validation phase).

### NEEDS USER DECISION
- Whether the all-stores monitor should stay open to every signed-in user (legacy) or be limited
  to role 1 / assigned stores (it exposes customer names across stores).

### New job names
None (O1 and O5 are in `JOB_NAMES`).

# Appendix B — sub-agent section: legacy-fulfillment

## B. Local delivery / hyperlocal lifecycle (`legacy-fulfillment`)

Commits: `8c54bd6` (backend port), `ee347bd` (app.ts line), `7a2635a` (tests), `fe5dfb9` (frontend),
`e637d23` (parity notes), `2a582ca` (queue precheck).

### What changed (legacy `backend-pos-web@78d5b63`)
- Deleted the rewrite-only local-delivery saga: `lifecycle/**` (commands, provider calls, delayed
  job table, reservation ledger, reconciliation endpoint, in-process 1 s worker loop with
  `LEGACY_DELIVERY_WORKER_*`), `schema.ts`, `service.ts`, `domain.ts`, `migration.sql`,
  `lifecycle/migration.sql`, `lifecycle/compatibility/001_unset_exception_date.sql`.
- New direct port (`hyperlocal.ts`, `stock.ts`, `runtime.ts`, `gateway.ts`, `actions.ts`, `jobs.ts`):
  - `AutoHlOrderView.post` `order/views.py:3675-3720`: advance-slot check (`pos_hyperlocal_slots`,
    `order_addons.order_success_timestamp`), O5 `order.views.advance_order_notification` on
    `order_create` with countdown = advance buffer, otherwise T5 notification fire-and-forget
    (`:3701-3703`); `HoldStockHelperClass.hold_stock` per line (`helpers/inventory_helper.py:33`);
    O2 on `order_create`, countdown = cut-off seconds (`HYPERLOCAL_CUT_OFF_SWITCH`) or
    `get_order_creation_buffer_time()` (common Redis → `tss_settings`, `helpers.py:1212`) + advance
    buffer; "first lands on" transaction log.
  - O2 `auto_hl_order_transfer` `:3844-3935`: job handler, and inline from `AjaxPassOrderView`
    (`:4254-4273`, `is_auto=False`, staff = `first last`). Durable guards, `is_transfer=1`,
    `create_order_notification_sync` with ❌ per backup store (`helpers/notification_helpers.py:40`),
    unhold/hold, `order_transferred_timestamp`, O3 enqueue with legacy positional args (dropdown text
    lands in `staff_user`), ⏱️ Slack when automatic.
  - O3 `auto_hl_order_to_online` `:3937-4029`: job handler, and inline from `AjaxHlOrderView.create`
    failure (`:3561-3567`) and `AJaxConvertOnlineView` (`:3831-3836`, `RTO_CONVERT_ONLINE`).
    Online eligibility, cancel + OD ticket (`helpers.py:891`), child-order guard,
    `create_online_order` (`helpers.py:1005`: `hyperlocal_to_online_order_logs`, courier log
    `CONVERT_ONLINE`, split/non-split status, `refund_hl_charges` → `tss_money_history` + `users`, or
    `refund-hl-charges` for split), C9 enqueue on `core`, ticket, log, `unhold_for_convert`.
  - C9 `core.tasks.new_order_create_communication` (`core/tasks.py:170-179`): handler posting
    `{"order_id": N}` to `MJML_HOST api/v2/mailr/hyper_local/order_new/`; non-200 only logged.
  - `AjaxHlOrderView.create/cancel` `:3455-3663` (Borzo create, `update_or_create` of the courier log,
    kinesis producer, Slack; cancel refund via API-v2 `cancel-hl-order`/`-items` with customer JWT,
    status updates, `cancel_transaction_logger`, webhook restock).
  - `WebhookCancelledOrderView` `:4277-4312` and `AutoHlOrderView` served at the legacy paths
    `/orders/auto-hl-order/`, `/orders/webhook-cancelled-order/` and the `/api/v1/orders/` mount, form
    body, `APPID`/`APPKEY` (observer credentials for the webhook), legacy JSON replies. The rewrite-only
    `/api/v1/integrations/local-deliveries/*` routes are removed (no frontend use).
  - `AjaxCheckOrderStatusView`, `AjaxOrderPackView`, `AjaxRtoRecievedView` as the status/packing/RTO
    routes; RTO restock gated once on `rto_recieved` (ledger-approved correction).
- Courier log: the rewrite's arrival/transfer "first courier-log insert" (`ensureDeliveryLog` +
  information_schema nullable check) is gone. Legacy `update_or_create` inserts (create/cancel/convert
  when no row exists) write `delivery_exception_date = '0000-00-00 00:00:00'` explicitly — the value
  legacy's omitted column stores under the production non-strict sql_mode (AGENTS.md 19 Nov revision).
- Frontend `pages/legacy-fulfillment`: command-receipt/reconciliation UI removed; panels rebuilt on the
  legacy actions and template guards (accept, transfer/convert with the four legacy reasons, cancel with
  the legacy `hl_cancel_reason` list (UI-only, as legacy), RTO convert, Mark packed, RTO received).
  `LegacyFulfillmentPanel`/`DeliveryLifecyclePanel` keep their exports and props for `OnlineOrderDetail`.

### `pos_rewrite_*` tables freed
`pos_rewrite_local_delivery_calls`, `pos_rewrite_local_delivery_commands`,
`pos_rewrite_local_delivery_jobs`, `pos_rewrite_local_delivery_orders`,
`pos_rewrite_legacy_fulfillment_commands`, `pos_rewrite_legacy_rto_receipts`. The module also no
longer touches `pos_rewrite_notification_events`, `pos_rewrite_operator_checkins` or
`pos_rewrite_administration_outbox`.

### Redis key families
| Key | TTL | Shape |
|---|---|---|
| `pos:local_delivery_order_lock:{orderId}` | PX 120000, token-compare release | random UUID token; rewrite-only fence around operator lifecycle actions (ledger row legacy-fulfillment) |
| `check_in_list_{store}` (legacy, read only) | legacy | list of operator ids; notification targets (`helpers.py:815`) |
| `ORDER_CREATION_BUFFER_TIME_IN_SEC` on `COMMON_REDIS_URL` (legacy common Redis) | none, as legacy | integer seconds; set from `tss_settings` when absent (`helpers.py:1218-1227`) |
Jobs use only the shared `JobProducer`; no module-owned queue keys.

### Shared-file edits
- `backend/src/app.ts`: `registerLegacyFulfillment(app, config, db, { jobs: options.jobs, redis: orderRedis })`.
- `backend/src/db/legacy-schema.ts`: ADDED `HyperlocalOrderLog.delivery_exception_date`
  (`datetime NOT NULL`, exactly as `production-schema.json`); `orm-metadata` stays at 0 mismatches.
- `backend/parity/local-delivery-lifecycle.md`, `legacy-fulfillment.md` rewritten;
  `legacy-fulfillment-query-proposals.md` marked superseded.

### Caller fixes / follow-ups outside ownership
- `backend/tools/operational-reports/build-bigquery-deployment-plan.ts:189` still lists the deleted
  `lifecycle/compatibility/001_unset_exception_date.sql` (primary: drop with the migration cleanup).
- `src/db/migrations.ts` still lists the deleted `legacy-fulfillment/migration.sql` and
  `lifecycle/migration.sql` (primary removes).
- `.env.example`/deployment docs: `LEGACY_DELIVERY_WORKER_*`, `LEGACY_DELIVERY_RECONCILIATION_*`,
  `LEGACY_DELIVERY_MOVEMENT_CONTRACT`, `BAMBOO_TOOTHBRUSH_EM`, `WELCOME_NOTE_PRODUCT_ID` are no longer
  read; new reads: `COMMON_REDIS_URL`, `TSS_JWT_HS256_KEY`/`TSS_JWT_HS512_KEY` (module-local).
- W8: wire `registerJobHandlers(registry, legacyFulfillmentDependencies(config, db, { jobs, redis, logger }))`
  from `src/modules/legacy-fulfillment/index.ts`; handlers for O2, O3, C9 need `jobs` in deps (O2/O3
  enqueue further jobs). O5 handler is the fulfillment module's.

### Security decisions (for S11+)
1. Operator routes require session store access to the order's SW location (or a backup store once
   transferred); legacy views only require login and accept any `order_id`/`store_id`.
2. Service webhooks compare `APPID`/`APPKEY` in constant time and return 401 for missing headers
   (legacy `==`, missing header → 500); duplicate form keys → 400.
3. Customer JWT minted for API-v2 (`hl-online-order`, `cancel-hl-order-items`) expires after 1 h
   (legacy `create_token`: `JWT_EXPIRY_DAY` days).
4. Slack posts only to `hooks.slack.com` (store-configured `slack_group_url` cannot become an SSRF
   target); external endpoints must be https (loopback http only outside production); every call has a
   timeout (30 s default, Slack 5 s as legacy) where legacy has none.
5. Courier tracking URLs are stored raw (parity) but returned to the UI only if https.

### Remaining gaps
- `CORE_WAREHOUSE` hold/unhold (`vinc_stock_sync`, `products.{db_column_name}`) not ported: returns the
  legacy "fail" result and is logged, so warehouse locations get no hold.
- `sync_pos_inventory` = configured stock projection; without the projection contracts holds fail
  (logged) and RTO receipt returns 503.
- Arrival is not deduplicated (legacy parity): a repeated upstream call holds stock twice.
- No sandbox evidence for Borzo, API-v2 (`cancel-hl-order*`, `hl-online-order*`, `refund-hl-charges`,
  `create-od-ticket`), order producer, mailr or Slack; tests use a fake gateway.
- Python `json.dumps` of Borzo floats like `1.0` is written as `1` (JS number parse).
- Tests: `tests/legacy-fulfillment/{python-text,http}.test.ts`, `lifecycle.mysql.integration.test.ts`
  (6 MySQL scenarios on production DDL); frontend `tests/legacy-fulfillment/client.test.ts`. No
  browser/native evidence.

### NEEDS USER DECISION
- Two legacy bugs are reproduced for 1:1 parity: (a) a split hyperlocal order never moves to
  location/status 21 on courier acceptance (`views.py:3504` compares the FK object with `1`); (b) the
  transfer path's O3 call puts the pass-reason dropdown into `staff_user` and leaves `reason_dropdown`
  empty in `hyperlocal_to_online_order_logs` and the CRM/Slack text. Keep, or fix?

### New job names
None.

# Appendix C — sub-agent section: order history

## C. Order history, search and order details (A1–A5)

Commits: `daf4e54` (backend), `eaa7ed5` (app.ts lines), `a3d42c5` (tests/tools), `1827c91` (frontend),
`3b72920` (parity notes).

### What changed (legacy `backend-pos-web@78d5b63`)

- **Reads are MySQL only, as legacy.** Legacy never reads orders from BigQuery (only footfall/targets,
  `helpers/bigquery.py:66,70`). `OrdersView`/`OnlineOrdersView` (`order/views.py:66-260`),
  `AjaxOrderListView` (`order/datatables/orders_datatable.py`), `ShowOrderDetailsView` (`:351-501`) and
  `ShowOnlineOrderDetailsView` (`:504-680`) all use the default database. The rewrite-only publication
  readers were removed: `search/warehouse.ts`, `search/reducer.ts`, `search/contacts.ts`,
  `search/options.ts`, `online-detail/{reader,qualification,options}.ts`,
  `online-detail/warehouse-schema.sql`, `online-detail/receipt.json`, and the order-list/detail warehouse
  branches in `orders.ts`. Every order read now uses the primary reader for any order date; there is no
  fallback because there is only one source. `BQ_ORDER_SEARCH_*`, `BQ_ORDER_DETAIL_*`,
  `ORDER_SEARCH_CONTACT_KEY*`, `ORDER_SEARCH_MAX_*` env settings are no longer read.
- **Order search (A1–A3)**, `search/{service,native,scope,queue,format,contracts}.ts`:
  - Windows: placement timestamps (`__gte`/`__lte`, `orders_datatable.py:125-127`), calendar dates, or no
    window (legacy Online page, `order/views.py:248`). The 62-day span / future-date refusals are gone.
  - Explicit order IDs bypass store filters for ST/HL/HE (`orders_datatable.py:93-121`); N type follows
    `user_type != 2 or order_id_list` (`:116`), else empty.
  - Queue tabs (`in_queue`/`not_packed`, `:73-87`) ignore dates and IDs, with no row bound.
  - Store name/counter/flags use `order.order_store.first()` for every viewer (`:179-186`).
  - Page size 1–100 = DataTables `lengthMenu` (`order/templates/order/index.html:456`).
  - `order-search-options` adds `hyperlocalTabs` = `_hl_get_tab_counts` (`order/views.py:4696-4746`,
    READ_DB_ALIAS → data reader) and lists all four order types to everyone (`index.html:157-176`).
- **Store order detail (A4)**, new `order-history/store-detail.ts`, served by
  `GET /api/v1/stores/:storeId/orders/:orderId[?cr=1]`: legacy authorization (order_stores in the
  operator's stores, role 1 = all active stores; `cr` skips it, `:355-369`), customer + exclusive
  membership (`helpers.py:254-281`), payment/order status and method, store name with counter
  (`:1407-1415`), offline/Shopify flags, order message, transaction id (`:714-736`), terminal upload state
  plutus/paytm (`:396-409`), mark-payment flag (`:420`), gift-card serials, total items, ERP names
  (`:1394-1404`), Vinculum status (`:438-452`), franchise flag, super-admin, check-in, reverse-pickup
  reasons, `EXCHANGE_ENABLED_STORE_IDS` (`settings.py:588-592`) and the transaction log (`helpers.py:290-354`).
- **Online detail (A5)**: native read by id for any date plus `context` (`online-detail/context.ts`):
  `show_mark_payment_pop_up` rules, `hl_cancel_reason` list, target-user membership (boolean only),
  `eligible_stores`, `sdd_invoice` (`helpers.py:2005-2017`), transfer flags, express pending/express-order
  flags. N-type detail no longer needs `user_type == 1`.
- **Frontend**: Orders page HL tab-count banner linking to `/fulfillment?tab=…`, "Online orders" view
  (`?view=online`, HL type, no default range), order-ID results open with `cr=1`, store order modal shows
  the legacy context and per-line return/exchange applicability (actions stay in W4's `/returns`); online
  detail shows the new context. Historical-snapshot texts removed.

### `pos_rewrite_*` tables freed
None used by these modules (they used BigQuery publications, not MySQL rewrite tables). Freed BigQuery
proposals: `pos_order_search_{publications,index,facts}_v1` (ledger §C #32),
`pos_online_order_detail_{publications,facts}_v1` (#49). `pos_public_order_*_v1` (#34) is still read by
`order-history/reader.ts`, kept only for W4's order copy.

### Redis key families
None.

### Shared-file edits
`backend/src/app.ts`: `registerOrderSearch(app, config, db, demo?)` (options argument dropped),
`ordersService(db, config)` (warehouse port dropped). `publicOrderHistory(config)` stays for
`historicalOrderCopyFacts`.

### Caller fixes outside ownership
- `backend/tools/order-search/{bigquery-fixtures.ts,publication.review.sql}` deleted and the
  `source-order-search` group removed from `backend/tools/order-history/bigquery.ts` (they only exercised
  the deleted search publication). `tools/verify-project.ts` still names
  `tools/order-search/backend.tsconfig.json`, which is kept.
- `backend/tests/order-history/mysql-fixture.ts` now also creates the tables the store detail reads and the
  administration check-in table.

### Security decisions (for S11+)
1. **Selected-store scope kept.** Legacy `AjaxOrderListView` accepts any `selected_stores[]`; the rewrite
   still requires every selected store to be one of the operator's stores (403 `ORDER_SEARCH_SCOPE_DENIED`).
2. **Explicit-ID cross-store reads kept as legacy.** Any authenticated operator can list and open (`cr=1`)
   an order from another store by its id. This is the legacy cross-store return lookup, so it was kept,
   read-only. Order ids are sequential, so this allows enumeration of customer names/contacts by any POS
   user, as in legacy; flagged for review.
3. **NW warehouse ownership** (HL lists): a numerically equal warehouse id is not treated as the
   checked-in store (legacy matched `location_id` only). **Transfer token match**: `next_location_ids`
   matches the store id as a JSON token, not a substring (legacy `__contains` matched `1` inside `11`).
4. **Online detail stays store-scoped** for HL/HE (owner/transfer store and current check-in) and requires
   an operator check-in; legacy only required login.
5. **Target users**: the online detail returns only whether the viewer is a target user, not the list of
   user ids legacy put in the template context.

### Remaining gaps
- `total_points`/`total_point_is_credited` (A4) need `order_point_cashback` on legacy's separate `mysql_db`
  connection; not in `production-schema.json` → returned as `cashback: null`. **Table outside snapshot.**
- A4 per-line return/exchange eligibility (`ORDER_RETURN_STATUS_CHECK_URL`), super-admin return override,
  failed-exchange retry rows and exchange salesperson list are not in the detail response; the modal links to
  W4's `/returns` flow, which owns that adapter (`checkout/return-workflow/gateway.ts`).
- A5 `hl_order_accept_time` (order_addons + buffer/cut-off settings) is not in the online detail; the
  legacy-fulfillment lifecycle panel owns that deadline.
- Payment-mode list (`TerminalHelper.get_payment_mode`) is served by W4's payment-context endpoint, not
  repeated in search options.
- Check-in comes from `administration/checkins.ts` (`pos_rewrite_operator_checkins`) until W3's Redis
  `check_in_{uid}` lands; the call sites only use `checkedInStore(userId)`.
- Legacy datatable sorting has no tiebreaker; the rewrite adds `id ASC` (deterministic superset).
- Only source vector 0 of the 43 datatable vectors has a golden capture (unchanged gap from W2).
- W4 order copy still requires the nonexistent `pos_public_order_*_v1` publications through
  `historicalOrderCopyFacts`; legacy C21 reads MySQL. W4 should switch it to MySQL.
- Note for the primary agent: `w3/auth-rehome` edits `order-history/contracts.ts`,
  `online-detail/authority.ts`, `search/{contracts,format}.ts` (reverting W7's nullable
  `order_ref_no`/`next_location_ids`); that will conflict with these commits.

### NEEDS USER DECISION
- spec.md "Database routing contract" routes historical order ranges to BigQuery with no MySQL fallback,
  but legacy reads all order dates from MySQL and the BigQuery publications never existed (ledger §C).
  W5 followed legacy (primary reader, any date). Confirm, or name the raw-layer tables
  (`tss_mysql_raw_layer.orders` …) that historical order search/detail should read instead.

### New job names
None.
