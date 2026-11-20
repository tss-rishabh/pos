# Deployment runbook

This migration is still in progress. A successful build or smoke test does not
certify full legacy behavior. `backend/parity/release-coverage.json` and
`npm run parity:gate` are the release authority; the gate currently blocks release.

## Build and isolate

Both Dockerfiles pin Node 24.22.3 and the verified image digest. The frontend
runtime pins the unprivileged NGINX 1.30.6 image digest. The stable release was
checked against the [official NGINX downloads](https://nginx.org/en/download.html)
and both tags were resolved through the registry before building.

```sh
docker build -t pos-rewrite-backend:verification backend
docker build -t pos-rewrite-frontend:verification frontend
cd backend
node tools/smoke-containers.cjs
```

The smoke tool creates a uniquely named Docker network without Internet access,
publishes no ports, runs both containers as non-root with read-only filesystems,
drops capabilities, and removes its own containers/network afterward. It verifies
native Linux image decoding, proxying, static CSP,
assets, offline-shell cache headers, synthetic login/cart
round trips, browser-origin checks and log privacy canaries.
It never receives live database, provider, S3 or AWS credentials. Evidence is
written to `backend/evidence/container-smoke.json`. A failed run stores synthetic
diagnostics under ignored `backend/evidence/private/`.

Production uses `NODE_ENV=production` and separate writer,
primary-reader and daily-report reader MySQL URLs. Inject secrets through the
deployment platform; do not bake `.env` files or credentials into images.
Mount the verified MySQL CA read-only and set `MYSQL_TLS_CA_FILE` to its path.
The application refuses plaintext production MySQL and the example session key.

Serve the frontend and `/api` on one HTTPS origin. The image listens on 8080;
set `API_UPSTREAM` to the backend's private host and port. The backend listens
on 4410. Restrict backend ingress to the gateway. Configure
`TRUSTED_PROXY_CIDRS` with only the actual gateway IPs/CIDRs so rate limits use
trusted client addresses. When another load balancer precedes NGINX, configure
its exact trusted addresses and real-IP handling in the ingress; do not accept
arbitrary client-supplied forwarded headers. NGINX forwards WebSocket upgrades.

Keep containers read-only with a writable `/tmp` tmpfs (mode 1777). The frontend
entrypoint prepares its generated configuration under `/tmp`. Health checks are
`/health/static` for static serving, `/health/live` for backend process health,
and `/health/ready` for writer/primary/data connectivity. Readiness performs no
schema checks or repairs. It does not certify external payment, warehouse or
feature parity.

Gateway access logs contain resource/event IDs, a request ID, method, status and
duration. They omit URLs, query strings, IP addresses, cookies and headers.
Application logs carry the authenticated pseudonymous user ID. Raw NGINX error
logging is disabled to keep request URLs and free-text report searches out of
infrastructure logs; monitor health failures, structured status events and metrics.

## Schema freeze and verification

The rewrite ships no migrations and executes no DDL. It uses only existing production
tables, exactly as captured in `backend/tests/golden/schema/production-schema.json`,
plus Redis for ephemeral state (sessions, OTP, idempotency, locks, claims and job
queues). There is no migration step in a deployment. MySQL-backed tests build disposable
local schemas from that snapshot only (`backend/tests/helpers/production-schema.ts`).

Run the reproducible project checks on Node 24 before packaging:

```sh
cd backend
npm run verify:project -- --mysql --browser
```

The runner clears inherited service credentials and worker flags. MySQL checks
accept only a local fixture connection, defaulting to
`mysql://root@127.0.0.1/pos_rewrite_integration`; set `POS_VERIFY_MYSQL_URL` if
local credentials or the port differ. The fixture schemas are disposable.
The runner records file checksums and requires the clean pinned source checkout;
it rejects results if inputs or that source baseline change during the run.
Its summary includes the rewrite commit before/after, expected/completed check
counts and explicit unexecuted checks. It rejects a changed rewrite commit as
well as changed inputs or source. The report is
`backend/evidence/verification.json`, with synthetic
diagnostics under the ignored `backend/evidence/private/` folder. A passing
verification run does not imply production readiness: the release gate remains
separate. Add `--release` to require that gate to pass too.

The build toolchain selects an exact local picomatch mitigation in both
lockfiles. Keep each project's `tools/dependency-security` artifact and verifier
in its independent build context. Run `npm ci` before using a changed lockfile;
the developer scripts and full verifier refuse stale installed parser bytes.
See the [review and compatibility limits](backend/tools/dependency-security/README.md).
The upstream advisory stays visible by version; the local mitigation is not an
official patched-release or full-audit-zero claim. Production installs omit this
development dependency and the Docker runtime stage verifies that absence.

The frozen `b201724` verification executed 130 project checks: 123 passed and
seven failed, with unchanged inputs. Its backend suite passed 2,688 tests with
one stale route-count failure; the generic app browser group was not executed
after earlier failures. The report remains failed. Subsequent focused fixes
are recorded in `CHECKPOINT.md`; they do not relabel that snapshot or replace a
fresh consolidated run. Platform run `44235902175` passed both Windows and macOS
on `cd179c5`, including unsigned review packaging and native smoke checks.
This does not certify signed production distribution or the later metadata port.

Legacy oracles are no longer executed: the repository has no Python, Go or PHP,
and source comparisons read committed golden fixtures instead. Frontend
verification uses two Vitest workers, matching desktop CI, without changing test
deadlines.

The workbook writer uses the existing durable report queue
and private bounded spool; review `backend/parity/inventory-workbooks.md`.

Take a verified backup and retain the prior application/image version. Roll back
application traffic first; keep the Redis `pos:` idempotency and claim keys until
they expire so confirmed financial actions cannot be repeated. Reconcile uncertain external
actions before enabling retries. A blanket table drop is not a rollback strategy.

## Identity, reporting and background work

Test logout and role/store revocation in the actual test tenant. Password login requires OTP or TOTP plus a valid store check-in. Configure
the source-compatible Netcore/Gupshup delivery channels; OTPs are hashed at rest,
and delivery credentials/phone/code are sent in POST bodies rather than URLs.
Pending-proof and full-session credential fingerprints invalidate after changes.

Cart/order calls require the separately reviewed API-v2 private cache-bypass
contract in `backend/compatibility/upstream/customer-context/README.md`.
Configure its distinct purpose key through the secret manager and record actual
source/deployment and sandbox acceptance before selecting
`UPSTREAM_POS_CUSTOMER_CONTEXT_CONTRACT=pos-customer-context-v1`.
Post-write cache deletion alone is insufficient. The scoped profile editor also
requires this contract and invalidates the old quote atomically; phone/email
changes use separate identity workflows. The candidate does not weaken the
independent financial projection/refund/wallet-lock requirements.

Sessions and login OTP state live in `REDIS_URL` (legacy redis database 0), which
must run with `maxmemory-policy noeviction`. Lockout alerts post to
`LOGIN_SECURITY_SLACK_WEBHOOK` once, fire-and-forget, as legacy does; there is no
security worker. Alerts and logs never carry the OTP, password, email or an unmasked
phone.

Offline billing sync keeps three kinds of state in the same `REDIS_URL`:

- idempotency records (`pos:offline_sale:<ref>`, 30 days)
- upload locks (`pos:offline_sale_lock:<ref>`)
- per-device episode counts (`pos:offline_device_sales:<deviceId>`, 3 days)

If one of these records is lost, an uncertain sale can be created twice. The server's
comment-row and candidate-order checks narrow that window but do not close it.
This Redis must therefore also run with AOF persistence (`appendonly yes`,
`appendfsync everysec` or stricter) on top of `noeviction`. A cache-only, non-persistent
Redis is not supported.

Provide BigQuery ADC/workload identity, project/location and verified view/table
contracts. Current business-day reports use the data reader; historical and
mixed-day reports require BigQuery. Verify CDC freshness, decimal/NULL behavior,
business timezone and source response parity before enabling historical reports.
No historical MySQL fallback is allowed. Financial/authentication decisions use
writer consistency.

Model history requires an accepted source log and actor binding as well as
warehouse publication. The investigation reader exposes `django_admin_log`
with an `auth_user` foreign key, while the pinned POS source selects `PosUser`.
Select `POS_ADMINISTRATION_HISTORY_MYSQL_CONTRACT=django-admin-log-en-us-v1` and
the verified `POS_ADMINISTRATION_HISTORY_MYSQL_ACTOR` only after checking the
actual operational log source. Equal numeric user IDs do not establish actor
identity. Historical/all-date history also requires the explicit matching
BigQuery view, match function and contract; it has no MySQL fallback.

Daily sales additionally require the generation/hash/CDC publication described
in `backend/tools/reports/daily-warehouse-contract.json`. Configure the rollup and
publication tables together, select
`BIGQUERY_DAILY_REPORT_OFFLINE_CONTRACT=pos-daily-store-sales-v2` (source-only
rollups; the v1 offline-cash projection was removed with offline cash), and retain
the documented freshness limits.

The user-approved per-line refund correction is an explicit change to the
duplicate-SKU cases in the source. Review and deploy the two-line upstream patch
in `backend/compatibility/upstream/offline-cash-pricing/patches/refund-by-hp-id.patch`,
then select `UPSTREAM_POS_REFUND_ALLOCATION_CONTRACT=pos-refund-per-hp-v1` and
`UPSTREAM_POS_REFUND_ALLOCATION_PATCH_HASH=e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11`.
Ordinary checkout also verifies stored per-line refunds against native audit
records before confirmation or charging. Configuration alone is not evidence
that the deployed upstream code is corrected.

Run the background job worker with `npm run worker:jobs` (`backend/src/jobs`,
`backend/parity/w8-report.md`). It replaces the legacy Celery worker and consumes the
legacy queues `core`, `store`, `order`, `order_create`, `export_queue`, `report_queue` and
`sales_queue` from `REDIS_URL` (`maxmemory-policy noeviction`), with `JOBS_CONCURRENCY`
(default 2). Jobs are at-most-once and never retried automatically. `--list-orphans`,
`--list-failed` and `--requeue <jobId>` let an operator inspect and re-run one job on purpose.
It runs CSV inventory imports, the e-commerce inventory sync, report exports and gift-card
batch generation. Product sync and settings effects run inline in the API after commit, as
legacy does. Stock-changing paths additionally require either a verified transaction-safe
writer routine or the explicitly selected source-pinned ORM contract in
`backend/parity/stock-projection.md`. The self-committing SQL backup is not a
valid caller-owned transaction implementation.

Trusted durable actor0 stock jobs additionally require the separate
`POS_SYSTEM_STOCK_PROJECTION_CONTRACT` documented in that stock contract.
Operational requests cannot opt into this capability through request JSON.

The fulfillment plugin starts its bounded outbox/expiry loop only with
`FULFILLMENT_WORKER_ENABLED=true`; tests keep it off. Configure the distinct
pre-order concurrency service and POS notification Redis, webhooks and mail/Slack
adapters as described in `backend/parity/fulfillment.md`. Finance history and
pending-close alert contracts are in `backend/parity/finance.md`.

Monitor outbox lag/exhaustion, uncertain financial operations, expired commands,
database pool saturation, report bytes billed and readiness failures. Configure
provider sandboxes, alert recipients and log retention before production traffic.

## Desktop distribution and media

Build/package Electron separately on each supported target. Use the deployed
HTTPS origin in `POS_DESKTOP_URL`. Connect once to prepare the offline shell. Verify upgrades,
offline reload/replay, print/download, logout and device storage policies on
signed Windows and macOS distributions; both are mandatory. Linux remains an
optional target. Follow [desktop platform checks](desktop-platforms.md), including
native installer, upgrade/profile retention, offline cash and actual printer
checks on both OSes. An unsigned local package is not a signed production release.

For the optional confidential Slack incoming-webhook flow, configure its approved
app credentials, exact same-origin HTTPS callback and workspace IDs in the
backend. Set desktop `POS_OAUTH_ORIGINS=https://slack.com` to permit same-window
authorization. This allowlist never permits new windows.
Run the bounded security cleanup worker. The
provider callback carries a short-lived code/state in its query: ensure any
external ingress/CDN also omits or redacts callback query strings. Application
and bundled gateway logs already omit them. Only an opaque completion UUID
returns to the administration screen.

Source customer-app links can open the system browser from the dedicated public
landing page. Set desktop `POS_APP_LINK_ORIGINS` to the exact approved HTTPS
website origins. This separate allowlist accepts only the bounded source link
parameters; it does not give the renderer general external-navigation access.

Customer website sign-in has a separate receiver. Set desktop
`POS_CUSTOMER_WEBSITE_ORIGIN` to its one exact HTTPS origin, matching the
backend receiver configuration. Only `/pos/secure-login` with a single opaque
fragment can open the system browser from the counter. Query credentials,
redirects, other paths and other origins remain blocked. Deploy and qualify the
purpose-bound website receiver before enabling the handoff in production.

If direct S3 uploads are enabled, pass exact HTTPS bucket origins as the
frontend build argument `POS_MEDIA_ORIGINS` and configure matching S3 CORS.
No wildcard CSP origin is required. Authenticated document reads stream through
the backend; uploads need the module's reservation/checksum/size/type verification
and cleanup worker. Verify these module prerequisites before enabling editing.
