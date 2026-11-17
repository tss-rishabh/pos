# Standalone private STORE receiver

`src/modules/legacy-order-status/receiver-main.ts` is a separate Fastify entry for
the existing `pos-whole-order-status-v1` receiver. It does not start the public POS
API, browser authentication, a public status-command producer or the public
sender worker. Existing source pins, request/receipt signatures and STORE
PACK → SHIP → DELIVER/Netcore stage semantics remain in the qualified receiver.
This entry adds process composition, not another source compatibility profile.

## Selection and root wiring

The root package exposes:

```json
"receiver:whole-order-status": "node --env-file-if-exists=.env dist/modules/legacy-order-status/receiver-main.js"
```

Keep `WHOLE_ORDER_STATUS_RECEIVER_ENABLED=false` and
`WHOLE_ORDER_STATUS_RECEIVER_WORKER_ENABLED=false` by default. Unselected or
`DEMO_MODE=true` execution exits successfully before shared Config validation,
database-pool construction, listening or background work. Invalid selected
configuration exits nonzero with a static resource event. This command accepts no
arguments.

New settings are:

| Setting | Default | Validation |
| --- | --- | --- |
| `WHOLE_ORDER_STATUS_RECEIVER_HOST` | `127.0.0.1` | An IP address or `localhost`; bind `0.0.0.0` explicitly for a private container service. |
| `WHOLE_ORDER_STATUS_RECEIVER_PORT` | `4422` | 1–65535; zero is available only in `NODE_ENV=test` for an isolated ephemeral fixture. |

Selected execution requires the existing common Config, source status and
private vendor/event configuration. `BACKEND_SYNC_API_BASE_URL` determines the
private route prefix: `https://sync.example.invalid/api/` exposes:

- `GET /api/store-order/status/capabilities`
- `POST /api/store-order/status`
- `GET /api/store-order/status/commands/:operationId`

The prefix accepts bounded plain ASCII path segments. Router parameters,
wildcards, percent encoding, duplicate separators and normalized dot paths are
rejected before constructing pools. Existing endpoint qualification rejects
credentials, queries, fragments and non-HTTPS production service URLs. All
configured MySQL URLs must have a schema and no query/fragment before any pool
factory is called. No endpoint or configuration value is logged.

Both **retained and distinct** keys are mandatory:

- `POS_PAYMENT_CORRECTION_PROOF_KEY_V1`: the exact retained proof key used by the
  public cash-return, finance and report writers/readers.
- `LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1`: the exact retained import key used by
  the financial import order bindings/proofs.

There is no fallback to `SESSION_SECRET`, the service API key or the status
receipt key. A replacement/generated key cannot verify existing financial
evidence. The common selected Config still requires `SESSION_SECRET`; this
process does not use it to authenticate private requests.

At least one selected private instance must run with
`WHOLE_ORDER_STATUS_RECEIVER_WORKER_ENABLED=true` to progress queued stages.
Listener-only instances are supported. Setting the separate public
`WHOLE_ORDER_STATUS_WORKER_ENABLED` flag never starts a sender in this process.

No migration is introduced. Apply the existing root writer migration plan,
including administration/check-ins, authentication epochs, whole-order status
and repair tables, payment-correction/cash-return intent/claim tables and import
financial-proof tables, before selection. Missing or invalid financial tables or
proofs fail the request/dispatch; they do not mean there is no hold. Preserve the
existing Docker copy of the pinned source JS and source manifest.

Build the separate backend image target with
`docker build --target whole-order-status-receiver -t pos-private-status:review backend`
from the workspace root. That target selects this entry, container bind
`0.0.0.0:4422` and the private `GET /health/live` healthcheck. The final/default
`runtime` target serves the public API. When overriding the private port, override
the healthcheck port as well. The liveness route reads no DB and sends
no provider request. Do not use it as proof of migrations, provider readiness or
source-deployment acceptance. Place the listener behind the private TLS service
boundary matching the configured HTTPS base URL. No infra/deployment changes
were executed by this slice.

## Shared financial fences and recovery

The runtime always constructs
`orderMutationGuards({cashReturnProofKey, importProofKey})` and passes its real
`assertHandoverAvailable` to `registerQualifiedWholeOrderStatusReceiver`. There
is no injected replacement/no-op guard seam. The existing receiver checks it
under the native Store → Order locks at acceptance and again before a vendor
stage. An unresolved returned-cash claim/armed or attested intent and an
incomplete/unproved financial import binding therefore block this private path.

The inverse public cash-return preparation/arming guard uses the same Store →
Order locking and refuses active/uncertain whole-order commands, stages or vendor
attempts. A recovery/read of an already retained receipt is not a new provider
effect. Unknown outcomes retain the original UUID/receipt and are read through
the signed GET endpoint; this entry does not manufacture a replacement command
or retry an unknown vendor attempt.

Both independent service credentials and the original signed operation/scope
are checked before DB access. Browser cookies confer no authority. Capability
proofs and receipts use the existing HMAC contract. All responses are no-store.
Request identifiers are generated locally, never copied from arbitrary inbound
headers. Authenticated operator IDs are added to allowlisted request events;
no request URL, query, body, headers, cookie, provider payload or raw
driver/validation exception is logged. Startup/shutdown events also include
static module/resource/event IDs, an instance ID, request ID and null user ID.

SIGINT/SIGTERM stop the listener and join an existing bounded private worker
tick before closing its pools. Repeated `stop()` calls share one completion
promise. Existing unknown-vendor fences survive shutdown/restart.

## Executed verification scope

From `backend`:

```sh
npx -y node@24.22.3 node_modules/typescript/bin/tsc -p tools/legacy-order-status/backend.tsconfig.json --noEmit
WHOLE_ORDER_STATUS_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_whole_status_test npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/legacy-order-status/private-runtime.test.ts tests/legacy-order-status/private-runtime.mysql.test.ts tests/legacy-order-status/receiver-routes.test.ts tests/legacy-order-status/startup.test.ts --maxWorkers=1
npx -y node@24.22.3 node_modules/eslint/bin/eslint.js src/modules/legacy-order-status/runtime.ts src/modules/legacy-order-status/receiver-main.ts tests/legacy-order-status/private-runtime.test.ts tests/legacy-order-status/private-runtime.mysql.test.ts tests/legacy-order-status/private-runtime-fixtures.ts
```

All 50 selected tests passed: 36 new process/configuration/auth/logging/shutdown
checks, six new native runtime/fence cases, and eight existing route/startup
checks. Strict TypeScript and focused lint passed. Tests use private random
localhost schemas and actual migrations; vendor fetches are stubbed. The actual
selected entry listens on an ephemeral loopback port, serves health without
opening a SQL connection (a local TCP trap verifies this), and exits cleanly on
SIGTERM. Default/DEMO and invalid-config subprocesses are also executed.
The backend and private image target build successfully. The built image's
default command exits with its disabled resource event using `--network none`.

The native cases prove signed original-UUID accept/GET/replay, cash/import holds
at HTTP acceptance and later dispatch, and inverse refusal by the actual
cash-return repository before preparation. The cash hold fixture is a valid
sealed retained-return claim; its separate original-funding producer and the
full physical handback protocol are covered by their existing payment-reversal
tests, not recertified here. Likewise the inverse case proves guard-first refusal
before funding eligibility, not a new financial-funding path. Later holds leave
the selected attempt unknown and unresent under existing conservative recovery
semantics; provider sends remain zero.

This is executable local runtime/guard evidence. Actual private ingress, deployed
writer/table/key alignment, vendor/Netcore contracts and source receiver rollout
acceptance remain required before production selection. No live DB writes,
schema changes, provider sends or uploads occurred.
