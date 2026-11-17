# POS rewrite specification

Source: `../backend-pos-web`, commit `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.
Destination: `~/code/pos-rewrite`, with independent `backend/` and `frontend/` projects.

## Scope and completion contract

Replace the Django/AdminLTE POS with a TypeScript service and one React application
distributed as a web PWA and a sandboxed Electron desktop app (no mobile app or
React Native target, confirmed by the user). Preserve current
features and frontend-visible business results. Redesign navigation and interaction
without silently changing tax, payment, refund, return, inventory, authorization,
or report semantics. A compiling application is not evidence of feature parity.

The user explicitly requires the desktop app to run on both Windows and macOS.
Ship Windows x64 and macOS Apple Silicon/Intel artifacts from the shared frontend.
Packaging, signing, installation/upgrade, offline cash/receipt printing, local
storage, downloads and authentication must be validated on each target OS.

The initial source scan found 263 route declarations (including mount points and
duplicates), 106 HTML templates, 125 Python files / 34,315 lines, and 87 raw SQL
call sites. `backend/parity/legacy-inventory.json` is the machine-readable source
baseline; the parity ledger must retain every route, background job, model,
template, external dependency and WebSocket handler. Route aliases must be resolved.
Unimplemented or unverified entries block the production release check.

## Feature families

| Family                 | Existing behavior to preserve                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity               | Five numeric roles (1 Super admin, 2 Admin, 3 OPM, 4 SM, 5 Staff); password login; OTP/MFA; profiles; password change; activation/archive; assignments; QR/mobile POS login; customer registration, verification and insights  |
| Stores                 | Store CRUD and archive; franchise/location details; storage; counters; check-in/out; cashier restrictions; delivery timing; Ecom/general thresholds; Slack integration                                                         |
| Catalog and inventory  | Products, barcodes and ERP identifiers; store catalog; stock, holds and storage; allocation; imports and failure logs; inventory audit; Vinculum sync; troubleshooting                                                         |
| Checkout               | Counter/tab isolation; customer/cart sync; barcode entry; coupons; PG discounts and approvals; membership/exclusive benefits; wallet/points; gift vouchers; salesperson per order and per item; feedback; online/fast checkout |
| Orders and payments    | Store/online order lists and details; invoices/labels; tax and GST; partial/split payments; Paytm and Pine Labs terminal initiate/poll/cancel; reconciliation and audit; cancellation and transaction recovery                 |
| Returns and exchanges  | Reasons/subreasons; eligibility windows and per-line extensions; credit-note sequencing; refund mode; duplicate SKU isolation; Vinculum acceptance and failed exchange retry                                                   |
| Hyperlocal and express | Acceptance/rejection; pack/ship/RTO; bulk line operations; deadlines and alerts; online conversion; cross-store operational dashboards; webhooks                                                                               |
| Reports and finance    | Orders, returns, sales, daily store and hyperlocal; salesperson/cashier performance; NPS/CRM; Slack availability/status/delivery/cancellation; export jobs/logs; finance feed; day-close states, nag, logs and cash balances   |
| Supporting features    | WebSocket notifications/read states; documentation/tutorial management; EDC management; QR downloads; keyboard shortcuts; background exports and file storage                                                                  |

## Architecture

- Backend: Node 24 LTS, TypeScript strict mode, Fastify, Drizzle ORM / mysql2.
  Existing business and identity tables stay in MySQL. Executable settings map
  `default` and `mysql_db` to the same `MYSQL_DB_NAME`; the README's PostgreSQL
  description is stale. The live MySQL schema confirms `pos_user` and inherited
  Django AbstractUser columns. Preserve Django password-hash compatibility.
- Frontend: React stable + TypeScript, TanStack Query for server state, Zustand
  for counter/tab/session UI state, IndexedDB for durable offline drafts/outbox.
  Server state is scoped by operator and store and never shared across logouts.
- Desktop: Electron supported stable, context isolation, sandbox, no Node in the
  renderer, restrictive IPC and navigation. Web and desktop share all UI features.
  Windows and macOS are mandatory release targets. An unsigned build on one
  platform does not certify the other platform or its printer/runtime behavior.
- SSO: Google OIDC authorization-code + PKCE, state and nonce, verified work
  domains, stable subject binding and server session cookies. Desktop uses an
  explicit code-paired system-browser handoff without renderer token delivery.
  Client credentials, approved production redirect and live acceptance remain
  deployment inputs. The reference is `fullstack-tss-admin` OAuthService.
- Keep credentials out of source, logs, examples, URLs and checked-in evidence.
  Use environment/secret injection. Supplied live MySQL access is read-only
  investigation access; never use it as a writer or execute schema changes there.

## Database routing contract

Writes and read-after-write validation use the writer. Interactive/catalog/order
reads use the primary reader. Reports wholly within the current business day use
the data reader. Historical/report ranges reaching before the current business
day, including mixed current/historical ranges, route as one request to BigQuery.
This avoids duplicate rows and mismatched totals across a split query.

The default business timezone is Asia/Kolkata, with half-open time ranges and
explicit boundary tests. Detail reads for operational order actions remain
interactive regardless of the original order date: financial eligibility and
stock/payment decisions cannot use delayed warehouse state. Reader choice is a
server-owned intent, never a client-controlled database identifier. Missing
warehouse configuration produces an actionable availability error; it does not
silently run historical scans on a MySQL reader.

The supplied read-only warehouse identity accesses `tssgcp2025.tss_mysql_raw_layer`
in `asia-south1`. Report parity still requires accepted table/view mapping,
timezone agreement, CDC watermark and deletion/return reconciliation. Historical
reports remain release-blocked until verified on that dataset. Independent
publication writers require separately provisioned credentials; the supplied
reports reader is never a warehouse writer.

## Offline semantics

Cache the app shell and store-scoped catalog. Persist cart drafts immediately.
The user explicitly requires completed cash sales and printed receipts while
offline. Use cached stock and send conflicts to a manager after reconnecting;
the user chose this policy instead of reserving stock per device. A completed
local sale and its cash receipt remain durable while reconciliation is pending.
Do not silently reprice it, turn it back into a cart, duplicate its order, or
issue another receipt during retries.

Use a separate append-only cash-sale ledger with device/operator/store/counter
binding, immutable source-authorized price/tax evidence, cash received/change,
a unique stable receipt reference and a durable idempotent server importer.
Print and reprint the same stored receipt. Clearly distinguish a cash receipt
from the authoritative tax invoice linked after synchronization. Inventory,
pricing and authorization conflicts require an explicit reconciliation workflow.
Offline card charges, wallet/points/gift redemptions, refunds and warehouse
actions remain online-only. Offline identity and sales authorization must have
explicit bounded lifetimes; a disconnected client cannot observe a new server
revocation. No replacement tax formula may be invented from cached display prices.

Queue other permitted operations with stable idempotency keys and serial replay
per counter. Keep pending, conflict, retry and rejected states explicit.
Persisting a cart alone does not fulfill the offline-selling requirement.

## Quality, query and parity gates

Additional user requirements: runtime validation at all input boundaries;
no TypeScript `any`; security findings must be resolved before release;
versioned resource-based API names; request IDs, structured operational/audit
logs, source-to-feature references, and reproducible verification evidence.
Logs must not contain PII. Emit allowlisted `module`, `resource`, `requestId`,
and pseudonymous `userId` (explicitly requested) fields, a resource-specific
`eventId` and a globally unique `eventInstanceId`. Never log request payloads,
query values, passwords, cookies, access tokens, customer details, or raw SQL
errors/parameters. Verify the log schema and negative redaction cases in tests.

1. Record original request/response envelopes, authorization/store scope, totals,
   ordering, pagination and errors in sanitized fixtures.
2. Run differential tests against the original Python functions or captured
   legacy responses. Label source-derived tests separately from runtime parity.
3. Verify query plans and exact response equivalence on bounded read-only MySQL
   samples. Document proposed indexes/rewrites in `improve-query.md`; apply none
   to production during investigation.
4. Use money in integer minor units or decimal strings, never binary floats.
   Preserve legacy rounding explicitly; timestamps and large IDs keep their
   precision across JSON and ORM boundaries.
5. Test auth, store isolation, concurrent checkout/idempotency, payment retries,
   offline reconnect and conflict recovery, reporting boundaries and CSV safety.
6. Measure baseline/new latency and query count before claiming performance
   improvement. Targets: no N+1 catalog queries; bounded pagination and pools;
   no full-table report scans on interactive readers; p95 targets set from real
   baseline measurements rather than invented benchmark numbers.
7. Build web and desktop artifacts; test browser flows and accessibility;
   run a production release gate that fails for missing parity evidence.

## Versions

Node 24 is an LTS branch: https://nodejs.org/en/about/previous-releases
React has stable releases: https://react.dev/versions
Electron supports the latest three stable majors:
https://www.electronjs.org/docs/latest/tutorial/electron-timelines
Pin exact resolved package versions and commit lockfiles. Revalidate support and
security patches when releasing.

## Deployment prerequisites

Separate writer, primary reader and data reader credentials; TLS CA/hostname
validation; BigQuery project/dataset and least-privilege identity; OIDC provider;
payment/ERP/upstream API credentials and sandbox fixtures; object storage; queue
and notification infrastructure; audit retention; signed desktop artifacts;
legacy response fixtures; completed release gate. Local implementation is
authorized. No production infrastructure changes or external messages are part
of this migration work.
