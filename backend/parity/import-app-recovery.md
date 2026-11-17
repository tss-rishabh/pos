# Retained CSV financial completion recovery

The application retains its local financial read adapter whenever
`LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1` is retained. Source/Go/publication flags,
source proof keys and current membership configuration do not enable new work
merely because this adapter exists. `configuredLegacyOrderImports` installs
`configuredFinancialImportProfiles` and reports `canStart: false` when the
transport's pure readiness check fails. No constructor performs I/O.

`legacyOrderImportService.ready` remains the public creation/approval/resume
capability. It requires the selected queue contract, creation readiness, a
retained key, an adapter, a non-demo application and an explicit writer.
`recoveryReady` requires the latter four conditions, independently of creation.
The configured adapter's immutable completed-seal path runs before current
profile/contact/entitlement checks; unfinished work retains all current gates.
The retained financial key and authenticated native completion/ownership proof
are still mandatory. A journal status alone is never completion evidence.

## Coordinator and HTTP behavior

`repository.runOne(adapter, 'recovery')` can claim only `STARTING` or
`RECONCILING` rows. Its candidate query requires an eligible row, so an earlier
pending-only job cannot starve recovery. It never claims `PENDING`, constructs
a new financial input, requests approval or invokes `adapter.start`.
`adapter.read` cannot start an unstarted financial stage or call a transport.
Existing job leases and claim-token checks serialize result retention; missing
or unverifiable evidence remains `RECONCILING` rather than being redispatched or
reported as imported.

Job detail/results GETs perform bounded recovery for that exact currently owned
job. Current native operator, store and counter authority is checked before
recovery and again while reading the response; the registrar retains its
post-await session check. SQL locks are released before invoking the adapter.
These reads can retain verified local outcome metadata. They cannot create an
order, settle a new financial stage, publish effects, renew approval or start
pending work. Terminal historical job DTOs still use the existing qualified
BigQuery history contract, with no native historical fallback.

## Worker entry point

The existing `worker-main.ts` now admits either creation-ready or
recovery-ready services. `LEGACY_ORDER_IMPORT_WORKER_ENABLED=true` and an
explicit non-demo writer remain required. With creation unavailable, its
service selects the same recovery-only coordinator mode. Disabled workers and
registrar construction perform no SQL/network work. No new flag, schema,
migration, route or frontend contract is introduced.

Root integration continues to call `configuredLegacyOrderImports` for both
the app and standalone worker; no separate recovery process/factory is needed.
Retain the existing financial encryption/HMAC key through the required receipt
retention period. This change selects no upstream source contract or provider.

## Focused evidence

The isolated MySQL membership fixture drives the actual financial adapter to a
sealed native completion, loses its reply before queue acknowledgment, leaves
the row reconciling and exercises the old unknown-journal recovery edge.
It then changes customer contact/block state, EAV data, source descriptor and
current source/membership settings. Actual HTTP detail/results, concurrent
worker instances and the production worker entry point retain the same
completion. The subprocess forbids every HTTP fetch. Assertions conserve order,
HP, financial stage/receipt/proof/effect counts, collected cash, refund amounts
and stock, and leave earlier pending jobs untouched. Separate cases preserve
active leases, reject current native caller access changes, withhold the DTO
after session revocation, and refuse to invent an operation for `STARTING`
without native evidence.

```sh
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
LEGACY_ORDER_IMPORT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_legacy_order_imports_test \
npx -y node@24.22.3 node_modules/vitest/vitest.mjs run \
  tests/legacy-import-membership/adapter.mysql.test.ts \
  tests/legacy-import-membership/core.test.ts \
  tests/legacy-order-imports/runtime-options.test.ts \
  tests/legacy-order-imports/runtime.mysql.test.ts \
  tests/legacy-order-imports/repository.mysql.test.ts \
  tests/legacy-order-imports/resumptions.mysql.test.ts --maxWorkers=1
```

Fixtures create/drop only random guarded localhost schemas. Source/provider
acceptance, external delivery and historical publication readiness are separate
deployment requirements; these tests are not full-route parity certification.
