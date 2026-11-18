# Souled POS rewrite

TypeScript backend and one React interface for web and Electron desktop. No
mobile target. Source baseline, feature scope and architecture are in [spec.md](spec.md).

**Migration in progress. This is not yet a production-parity release.** The
release gate intentionally fails while any legacy feature lacks evidence. The
source contains 263 route declarations, 106 templates, 32 background jobs and
one WebSocket route. New REST endpoint counts do not establish legacy parity.

Offline cash completion, receipt printing/reprinting and durable manager handoff
are implemented with isolated verification. The
confirmed policy permits sales using cached stock, with conflicts routed to a
manager after reconnecting. Real source/provider/schema acceptance and physical
printer checks on Windows and macOS remain release requirements.

## Local development

Use the pinned Node version in `.nvmrc` (24.22.3 LTS). Both folders have their
own package manifest and lockfile. Use `npm ci` in each folder.

```sh
cd backend
cp .env.example .env
# Replace SESSION_SECRET with a random development secret. Do not add live
# credentials to source control. DEMO_MODE=true uses isolated sample data.
npm run dev
```

```sh
cd frontend
npm run dev
```

Web: `http://localhost:5173`. Backend: `http://127.0.0.1:4410`.
The Vite proxy keeps browser requests on the web origin. The local demo cannot
run with `NODE_ENV=production`. A demo draft does not charge a customer or create
a real order.

## Verification

```sh
cd backend
npm run verify:project -- --mysql --browser
```

This command builds both folders and runs lint, unit, local MySQL and browser
checks with service credentials removed from the child environment. It records
file checksums, requires the clean pinned source checkout, and fails if inputs
or that source baseline change during verification. Add `--release`
to also require complete parity certification. See [deployment.md](deployment.md)
for fixture configuration. Individual checks remain available:

```sh
cd backend
npm run typecheck
npm run lint
npm test
npm run parity:gate
```

`parity:gate` must fail until the ledger is complete. Pure legacy report and
checkout payload tests execute selected original Python methods through an AST
oracle without importing Django, executing application startup, or using a live
database. They require `../backend-pos-web` beside this project and Python 3.
The source pricing/refund and stock suites additionally require the pinned
`../backend-tss-api_v2` and `../backend-sync-api` reference checkouts. Install
`uv` for the private source compatibility checks; its frozen lock selects an
isolated Python 3.12 runtime and dependencies without importing source startup.
These tests establish component parity, not complete request/runtime parity.

The optional MySQL integration suite only permits a local schema named
`pos_rewrite_integration`; it verifies real transaction races and idempotency.
Provide `MYSQL_INTEGRATION_URL` through the environment. Never point it at the
supplied reader or a production writer.

The authentication and migration suites also support guarded local templates:
`AUTH_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_auth_test` and
`MIGRATION_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_migrations_test`.
They create uniquely named fixture databases and drop only those fixtures.
The auth suite also requires `redis-server` on PATH for QR handoff checks; it
starts a separate loopback process and never reuses the developer's Redis.
Administration, checkout, fulfillment and reporting module runbooks describe
their own opt-in SQL/Redis/browser fixtures. Ordinary `npm test` skips optional
dependencies unless their explicit local test variables are supplied.

```sh
cd frontend
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

The browser suite uses system Chrome when present on macOS, otherwise bundled
Playwright Chromium (`npx playwright install chromium`); an explicit
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` overrides that choice. It tests a production web
build, offline reload/reconnect and the actual Electron shell. Test data is
synthetic. Screenshots and traces stay under ignored `frontend/test-results/`.

## Desktop

The Electron shell uses the same deployed web origin and persistent Chromium
profile, including the cached offline app shell. Connect once before taking a
device offline. Set `POS_DESKTOP_URL` to the production HTTPS URL. Optional
application authorization uses the separate exact HTTPS
`POS_OAUTH_ORIGINS` list (for Slack, `https://slack.com`). New windows, webviews and renderer Node access are
disabled. Production never accepts an HTTP workspace URL.

For local testing, use `NODE_ENV=development` and
`POS_DESKTOP_URL=http://localhost:5173` with `npm run desktop`. Packaging commands
are `desktop:pack` and `desktop:dist`, with explicit `:mac` and `:win` scripts.
Windows and macOS are required targets. See [desktop platform checks](desktop-platforms.md)
for packaging, native verification and signing. A local unsigned package does not
certify both platforms or constitute a signed release.

## Database and integrations

- MySQL uses Drizzle ORM and bounded, separate writer/primary/data pools with
  remote TLS verification. Reader connections are explicitly read-only.
- Interactive reads use the primary reader. Current-business-day reports use
  the data reader. Historical and mixed-day reports use BigQuery. No historical
  fallback to a MySQL reader is allowed.
- Financial actions and session revocation use writer consistency. Long-lived
  warehouse state cannot authorize payment, stock or return decisions.
- Existing MySQL tables are mapped from source and verified read-only metadata.
  Do not run schema-push tools against the legacy schema. Apply only reviewed
  rewrite migrations to the writer.
- BigQuery requires project/location, ADC, and verified table/view mappings.
  The daily rollup contract is documented under `backend/parity/`. Supplying a
  table name is not evidence of report parity or CDC freshness.
- Operator login uses the legacy password plus OTP/TOTP flow and a store
  check-in. There is no Google or desktop single sign-on.
- Payment, ERP, inventory synchronization, fulfillment and notification adapters
  require their real sandbox/production contracts. Missing or uncertain external
  confirmation must never become a successful sale or refund.

Read-only schema, plans and bounded catalog comparison evidence is under
`backend/evidence/`. Proposed query/index improvements are in
[improve-query.md](improve-query.md). No live schema or data mutations have been
performed during that investigation.

## Logging and security contract

Application events contain `module`, `resource`, `requestId`, `userId`, a stable
resource-specific `eventId`, and a unique `eventInstanceId`. User IDs are the
pseudonymous identifiers explicitly requested for tracing. Never log names,
emails, addresses, phones, credentials, cookies, request bodies/query values,
payment payloads or raw SQL errors. Hostname/PID defaults are disabled. Tests
check emitted logs with PII and secret canaries.

Input validation, store/role/franchise access, browser-origin checks, cookie
security, server-session revocation and scoped offline
storage are required gates. TypeScript `any` is forbidden by lint. Dependency
audits and functional tests are necessary evidence; neither is a guarantee that
an unfinished migration is secure or production ready.
