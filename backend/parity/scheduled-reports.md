# Scheduled hyperlocal and CRM report evidence

Source baseline: `backend-pos-web` commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, active service routes in `report/urls.py` and their classes in `report/views.py`.

All seven active scheduled report groups have real builders, data adapters and durable delivery:

| Source route / class | New `input.kind` |
|---|---|
| `store-hyperlocal-record/` / StoreHyperlocalRecord | `hyperlocal-performance` |
| `hyperlocal-slack-report/` / HyperlocalSlackReport | `hyperlocal-summary` |
| `hyperlocal-availability-report/` / HyperlocalAvailabilityReport | `hyperlocal-availability` |
| `hyperlocal-store-status-report/` / HyperlocalStoreStatusReport | `hyperlocal-store-status` |
| `hyperlocal-delivery-report` / HyperlocalDeliveryReport | `hyperlocal-delivery-delays` |
| `hyperlocal-cancellation-report/` / HyperlocalCancellationReport | `hyperlocal-cancellations` |
| `crm-ticket-status/` / CrmTicketStatus | `crm-tickets` |

The resource API is `POST /api/v1/report-deliveries` with `{commandId,input}`, `GET /api/v1/report-deliveries/:jobId`, and `POST /api/v1/report-deliveries/:jobId/targets/:targetId/reconciliation` with `{commandId,outcome}`. Every route requires constant-time validation of `REPORTS_API_KEY` in `X-API-Key` before database work. Cookies, query parameters and bodies cannot supply service authorization. All routes declare module/resource/action traces. The async creation receipt replaces source GET side effects and premature `Data Sent` responses.

Input fields are `kind`, optional `date`, `previousDays` (CRM, default 1, maximum 62), `sendToSlack` (CRM, default true), and `includeCompleted` (CRM, default false). Non-CRM ticket options are rejected. Dates select completed business days up to 62 days ago; store-availability status uses today because it reflects current configuration. Defaults preserve source yesterday selection, except performance uses validated `DAYS_BEFORE_FOR_MIN_MAX` (default 1). Business time comes from explicit `BUSINESS_TIMEZONE`; matching the source runtime timezone remains an environment acceptance check. Old keys `no_of_previous_days`, `send_report_to_slack` and `include_completed_ticket` map to the corresponding new input fields. Schedulers must reuse a UUID command on transport retries; changed input under that command returns 409.

## Preserved calculations and source limits

Performance groups by current store name, adjusts acceptance duration against the accepted weekday's current opening time on the order-created calendar day, preserves missing-slot zero and negative-duration formatting, and sends empty results only to the demo channel. Summary uses orders created over the source two-day window, the first updated-in-day log by ID, exact accepted/converted/failed totals and repeated transfer-decline contributions. Slot rows, test-store exclusion and duplicate slot behavior are retained. Current store-status counts retain source inclusion of inactive eligible stores and source orphan/type slot quirks rather than silently changing totals.

Availability preserves log counts versus distinct order platform counts, flag-18 app classification and source cart/buffer/store eligibility branches. The source GROUP_CONCAT has a 100000-byte limit. Before replacing it with distinct IDs, the builder measures the corresponding source groups (including raw NULL/zero visibility groups). An oversized group fails with static `LEGACY_REPORT_RECONCILIATION_REQUIRED`; it sends no partial report or changed totals. Native fixture parity is bounded below that limit. The unresolved oversized-source anomaly requires approved data/query reconciliation.

Delivery delays retain original order-created bounds, finished-comment selection, source TIMEDIFF strings and source group ambiguity when several qualifying comments disagree. Cancellation preserves all conversion logs and source null/date formatting. Data interpolated into Slack markup escapes `&`, `<` and `>` to prevent injected links/mentions; automatic linking and unfurls are disabled. This is a deliberate security correction for malicious input, not byte parity for such source messages. Source-known symbols are preserved through escaped Unicode constants.

CRM selects source candidates, verifies ticket/order registration on the writer before bounded Freshdesk GET requests, then rechecks current records under writer locks before an atomic status/age update. A warehouse candidate never authorizes a mutation alone. The source update of all rows sharing a verified ticket ID is retained. Duplicate tickets share one lookup/update; report rows retain source multiplicity. Closed tickets revoked during lookup cannot be reopened from stale candidates. External status, UTC age milliseconds and day/hour/minute labels match source fixtures; no customer contact/response JSON is retained or logged. The verified source ENUM cannot store the legacy `NEW` mapping for status 0, so that unsupported state fails closed before writes instead of corrupting the ENUM. Freshdesk status/schema reconciliation remains a deployment requirement.

## Readers and compatible views

Queued history uses BigQuery without a MySQL history fallback. Timing always uses BigQuery because the original order creation timestamp is undated; summary routing uses its actual previous-day-to-end order window, so today's summary also uses BigQuery. Other current-day bounded fact cohorts use DATA. Native static SQL remains available for isolated source-projection fixtures. Current store/slot configuration uses primary metadata. CRM's live record checks and updates always use the writer. The query window and all parameters are bound; each warehouse request is labeled with its static report-kind resource.

| Required option | Compatible view projection / grain |
|---|---|
| `BQ_HYPERLOCAL_ORDER_FACTS_VIEW` | One row per order: `order_id,created_at,order_status,store_id,store_name,location_type,is_transfer,next_location_ids,is_app` |
| `BQ_HYPERLOCAL_ORDER_LOGS_VIEW` | Every legacy hyperlocal_order_log row: `log_id,order_id,action,main_location_id,updated_at` |
| `BQ_HYPERLOCAL_AVAILABILITY_VIEW` | Every availability-log/order join row: `log_id,order_id,log_created_at,cart_type,stock_threshold,store_availability,is_slot_visible,order_status,is_app` |
| `BQ_HYPERLOCAL_DELIVERY_ISSUES_VIEW` | Every order/comment join row before source grouping: `order_id,order_created_at,start_timeslot,end_timeslot,delivered_at,total_delay,hl_status` |
| `BQ_HYPERLOCAL_CANCELLATIONS_VIEW` | Every conversion-log/store join row: `log_id,store_name,order_id,new_order_id,reason,remark,created_at,platform` |
| `BQ_HYPERLOCAL_CRM_TICKETS_VIEW` | Legacy CRM candidate rows: `log_id,order_id,fd_ticket_id,fd_ticket_status,created_at` |

IDs must be lossless INT64 where compared/joined numerically; projected IDs become strings. Timestamp columns are business-local DATETIME, except Freshdesk response timestamps are UTC. Preserve source nulls, duplicates, current-location attribution and first-log ID ordering. `is_app` means EXISTS flag_history(order_id,flag_id=18), not a multiplying flag join. Delivery `total_delay` must retain MySQL TIMEDIFF/clamping semantics. Missing/incompatible mappings fail closed. These are explicit contracts for deployment mapping; no real dataset name or snapshot equivalence is fabricated.

## Queue, destination ledger and runtime

Apply `src/modules/operational-reports/scheduled-migration.sql`: it creates only `pos_rewrite_scheduled_reports`, `pos_rewrite_scheduled_report_targets` and `pos_rewrite_scheduled_report_channels`. No legacy table is created/altered. `registerOperationalReports` registers the service and starts/stops its worker. `SCHEDULED_REPORT_WORKER_ENABLED` defaults false, interval defaults 3000ms (1000–60000), and `SCHEDULED_REPORT_MAX_PENDING` defaults 20 (1–100). Enable only after private configuration and compatible views are verified. `SLACK_URL` and `SLACK_DEMO_URL` must be credential/query/fragment-free HTTPS URLs on hooks.slack.com; both are required when enabling the worker. URLs and their secret paths are never logged. Tests use injected adapters and make no live sends.

Freshdesk uses `FRESHDESK_TICKET_URL` (credential/query/fragment-free HTTPS), `FRESHDESK_BASIC_AUTH_USERNAME` and `FRESHDESK_BASIC_AUTH_PASSWORD`. The adapter uses Basic authorization in a header, rejects redirects, bounds/validates JSON, limits concurrent GETs to four and uses a 55-second refresh deadline with ten-second request timeouts. `SCHEDULED_REPORT_MAX_CRM_TICKETS` defaults 200 (1–2000); larger sets fail explicitly. Demo mode cannot send Slack or call Freshdesk.

Commands are immutable and concurrent retries create one job. SKIP LOCKED claims release SQL transactions before warehouse/HTTP work. BUILDING leases are 120 seconds; an interrupted build produces a traceable failure. Prepared messages are immutable. Complete Unicode text is split into ordered parts below 35000 characters, with an eight-MiB artifact budget; each destination/part has its own receipt. A destination hash ledger serializes reservations at one per second across worker processes, including equal main/demo webhook URLs, following [Slack's incoming-webhook rate guidance](https://docs.slack.dev/apis/web-api/rate-limits/). Message chunks remain below the [documented text truncation boundary](https://docs.slack.dev/reference/methods/chat.postMessage/).

The target is recorded SENDING before POST. Timeout, rejected response or an interrupted send becomes UNKNOWN and is never blindly retried. Independent untouched destinations can proceed; later parts on an uncertain channel wait for reconciliation. Explicit `delivered` completes the target without another POST; `not-delivered` authorizes that same immutable part to be sent again. Reconciliation commands are idempotent. Job and target state are serialized under writer locks. Worker events carry module/resource/event ID, unique event instance ID, original request ID, service user ID and opaque job ID; messages, query values, credentials, URLs and raw exceptions are excluded.

Configure application-appropriate private retention for message bodies and CRM status data, and schedule header-authenticated POST creation from the deployment scheduler. Worker activation, real webhook/Freshdesk sandbox verification, actual BigQuery mappings, data freshness and production sizing remain release gates.

## Deterministic evidence

Twenty-four cases execute the actual Python source get()/helper AST with local ORM/HTTP protocol fixtures to compare message bytes, channel choices, transfer accounting, store configuration, timing and CRM ages. Availability classification uses its actual source reducer AST. Native query fixtures create nine tables from verified physical metadata in a fresh local MySQL schema, run original timing/delivery/cancellation/CRM SQL and compare the bound strict implementation. They also verify duplicate eligibility/flags, first-log selection, lossless BIGINT IDs, writer-current CRM checks and all-ticket updates. Warehouse tests prove named bindings, resource labels, missing mappings, static failures and zero historical report reads from MySQL. Queue tests exercise concurrency, quota, immutable retries, destination pacing, uncertain outcomes, explicit reconciliation and interrupted claims. HTTP tests deny absent/invalid/query credentials even with a browser principal before any DB work. No real Slack/Freshdesk delivery, live data write or full production parity certification is claimed.
