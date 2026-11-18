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
the packaged migration plan, native Linux image decoding, proxying, static CSP,
assets, offline-shell cache headers, synthetic login/cart
round trips, browser-origin checks, demo isolation and log privacy canaries.
It never receives live database, provider, S3 or AWS credentials. Evidence is
written to `backend/evidence/container-smoke.json`. A failed run stores synthetic
diagnostics under ignored `backend/evidence/private/`.

Production uses `NODE_ENV=production`, `DEMO_MODE=false`, and separate writer,
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
and `/health/ready` for writer/primary/data connectivity and current migration
checksums with no unfinished DDL journal entries. Readiness performs no schema
repairs and remains unavailable until the reviewed plan is applied. It does not
certify external payment, warehouse or feature parity.

Gateway access logs contain resource/event IDs, a request ID, method, status and
duration. They omit URLs, query strings, IP addresses, cookies and headers.
Application logs carry the authenticated pseudonymous user ID. Raw NGINX error
logging is disabled to keep request URLs and free-text report searches out of
infrastructure logs; monitor health failures, structured status events and metrics.

## Schema rollout

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

Source oracles also require the reviewed API baseline
`2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. When the developer's API checkout
has moved on, use a separate, clean Git checkout of that commit and set
`POS_LEGACY_IMPORT_SOURCE_ROOT` to its directory
before starting verification. Do not reset or modify the developer's checkout.
The alternate location preserves each consumer's original commit/byte checks;
it does not select another source revision. Fixture launchers forward only
that source location rather than inherited service credentials. Generated
exchange metadata records repository/commit identity instead of a local path.

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

The inventory workbook source oracle additionally needs its isolated Python
environment. Install `backend/tools/inventory-workbooks/requirements-oracle.txt`
into `backend/tools/inventory-workbooks/.venv` with Python 3.10 before running
the source comparisons. This is a verification dependency, not a production
runtime dependency. Source-oracle preflight now checks the pinned local Python
versions and packages before the full verifier starts compilation: pricing
requires Python 3.12.15, SQLAlchemy 2.1.8 and PyMySQL 1.2.4; workbooks require
Python 3.10.22, openpyxl 3.1.2 and et-xmlfile 1.1.0. Run
`node tools/verify-fixture-environments.mjs` from `backend/`. Fresh worktrees
need their own oracle environments; the original untracked environments are
not part of a Git checkout. Provision private copies or use the documented
locked environment setup, preserving any shared environment.

Frontend verification uses two Vitest workers, matching desktop CI, without
changing test deadlines. A caller may reuse an existing private native-runner
compilation cache with `POS_IMPORT_GO_BUILD_CACHE`; the full verifier accepts
only caller-owned, nonsymlink `/tmp/pos-import-go.<id>/build-cache` directories
under a private runner directory. The native command retains `-race -count=1`.
This avoids repeating a cold compiler build; it does not reuse test results or
convert an earlier timeout into a passing run.

The workbook writer uses the existing durable report queue
and private bounded spool; review `backend/parity/inventory-workbooks.md`.

Build the backend, then inspect its deterministic plan:

```sh
npm run build
npm run migrate:plan
```

Review the named SQL files and test the plan against an isolated restore before
applying it to the writer with `npm run migrate:apply`. The runner accepts only
rewrite-owned table DDL/seed statements, serializes runners with a dedicated
connection lock, records file checksums, and journals each statement. Legacy
tables are mapped but never schema-pushed. The live reader supplied for this
task must never be used as a migration target.

MySQL DDL implicitly commits. An interrupted `started` statement blocks replay
with `MIGRATION_STEP_NEEDS_REVIEW`; inspect the journal and actual schema before
an operator reconciles the step. An edited applied file also blocks rollout.
After the first deployment, add forward migrations instead of editing applied
SQL. Current migration files are not frozen while this rewrite is being built.

Take a verified backup and retain the prior application/image version. Roll back
application traffic first; retain rewrite session/idempotency/outbox tables so
confirmed financial actions cannot be repeated. Reconcile uncertain external
actions before enabling retries. A blanket table drop is not a rollback strategy.

## Identity, reporting and background work

Configure the OIDC issuer/client/redirect and test account provisioning, verified
email, state, nonce, PKCE, logout and role/store revocation in the actual test
tenant. Password login requires OTP or TOTP plus a valid store check-in. Configure
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

Run `npm run worker:security` with `AUTH_SECURITY_WORKER_ENABLED=true` and the
approved `LOGIN_SECURITY_SLACK_WEBHOOK` to deliver durable lockout alerts and
prune expired login proofs/sessions. It is disabled by default. Delivery is
at least once for these nonfinancial alerts; an interrupted acknowledgment can
repeat the same alert ID. Retries have backoff and stop after ten attempts.
Recover one exhausted alert explicitly with `-- --retry-alert ALERT_UUID` after
fixing its dependency. Logs retain original request/user IDs and static event
names, never the webhook URL, phone, email or OTP. Alert delivery does not hold
the login request open.

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

Daily sales additionally require the generation/hash/CDC publication documented
in `backend/parity/daily-report-offline.md`. Configure the rollup and publication
tables together, select `BIGQUERY_DAILY_REPORT_OFFLINE_CONTRACT=pos-daily-store-sales-offline-v1`,
and retain the documented freshness limits. An empty, stale or mismatched
publication cannot silently omit completed offline cash receipts.

The user-approved per-line refund correction is an explicit change to the
duplicate-SKU cases in the source. Review and deploy the two-line upstream patch
in `backend/compatibility/upstream/offline-cash-pricing/patches/refund-by-hp-id.patch`,
then select `UPSTREAM_POS_REFUND_ALLOCATION_CONTRACT=pos-refund-per-hp-v1` and
`UPSTREAM_POS_REFUND_ALLOCATION_PATCH_HASH=e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11`.
Ordinary checkout also verifies stored per-line refunds against native audit
records before confirmation or charging. Configuration alone is not evidence
that the deployed upstream code is corrected.

Offline cash pricing and order templates use the private, pinned-source
compatibility resources documented in
`backend/compatibility/upstream/offline-cash-pricing/README.md`. Configure both
`TSS_OFFLINE_CASH_PRICING_URL` and `TSS_OFFLINE_CASH_TEMPLATE_URL`, their shared
service key, reviewed pricing/template/import contracts, signing keys and limits.
The immutable receipt remains unchanged during manager attribution or order
import. The legacy unset-event date correction in
`backend/compatibility/upstream/offline-cash-import/improve-query.md` is a separate
writer schema review; `OFFLINE_CASH_ORDER_SCHEMA_CONTRACT=pos-offline-cash-order-schema-v1`
must not be selected before that contract exists on the actual writer.

Run the financial outbox in a supervised process:

```sh
npm run worker:financial-outbox
```

Set its producer/engagement/return/exchange delivery endpoints and credentials
as documented in `backend/parity/checkout.md` and the module's environment schemas.
Uncertain external financial outcomes require reconciliation; process restarts
must not repeat them blindly.

Run inventory synchronization with `npm run worker:administration` only after
its endpoint and replay safety are verified. The worker defaults to disabled.
Its exact flags, bounded retries and explicit recovery command are documented
in `backend/parity/administration-worker.md`. Stock-changing paths additionally require either a verified transaction-safe
writer routine or the explicitly selected source-pinned ORM contract in
`backend/parity/stock-projection.md`. The self-committing SQL backup is not a
valid caller-owned transaction implementation.

Trusted durable actor0 stock jobs additionally require the separate
`POS_SYSTEM_STOCK_PROJECTION_CONTRACT` documented in that stock contract.
Operational requests cannot opt into this capability through request JSON.

Gift-card batch file generation/delivery runs separately with
`npm run worker:gift-card-batches`. Enable the API and worker only after the
private S3 bucket, keyring, original card-code salt and Netcore delivery contract
are configured and verified. Files/passwords/codes/PINs are never logged; the
worker has no voucher-funding authority. Historical batch views and accepted
search UDFs require explicit BigQuery bindings. Review
`backend/parity/administration-gift-card-batches.md` for private retrieval,
uncertain delivery, original CSV parity and supported AES archive acceptance.

The fulfillment plugin starts its bounded outbox/expiry loop only with
`FULFILLMENT_WORKER_ENABLED=true`; tests/demo keep it off. Configure the distinct
pre-order concurrency service and POS notification Redis, webhooks and mail/Slack
adapters as described in `backend/parity/fulfillment.md`. Finance history and
pending-close alert contracts are in `backend/parity/finance.md`.

Run timing/settings effect delivery separately with `npm run worker:settings`
and `SETTINGS_WORKER_ENABLED=true`. Configure its distinct `COMMON_REDIS_URL`
and approved settings Slack webhook (`SLACK_URL`). Stock-related e-commerce
changes stay disabled until their writer-side synchronization contract is
verified. The settings migration follows the administration/media migrations;
the general migration runner includes all three.

Monitor outbox lag/exhaustion, uncertain financial operations, expired commands,
database pool saturation, report bytes billed and readiness failures. Configure
provider sandboxes, alert recipients and log retention before production traffic.

## Desktop distribution and media

Build/package Electron separately on each supported target. Use the deployed
HTTPS origin in `POS_DESKTOP_URL` and exact trusted SSO origins in
`POS_SSO_ORIGINS`. Connect once to prepare the offline shell. Verify upgrades,
offline reload/replay, print/download, logout and device storage policies on
signed Windows and macOS distributions; both are mandatory. Linux remains an
optional target. Follow [desktop platform checks](desktop-platforms.md), including
native installer, upgrade/profile retention, offline cash and actual printer
checks on both OSes. An unsigned local package is not a signed production release.

For the optional confidential Slack incoming-webhook flow, configure its approved
app credentials, exact same-origin HTTPS callback and workspace IDs in the
backend. Set desktop `POS_OAUTH_ORIGINS=https://slack.com` to permit same-window
authorization. This allowlist is separate from SSO and never permits new windows.
Apply the Slack migration and run the bounded security cleanup worker. The
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
