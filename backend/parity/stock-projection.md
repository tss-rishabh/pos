# Transaction-scoped stock projection

The user confirmed that only the supplied read-only connection is known and
asked to use the existing codebase if the routine cannot be found. Both inspected
Aurora endpoints did not expose `tss.pos_stock_syncer` to that account. This is
limited visibility, not proof of global absence. No live routine was executed.

Read-only physical metadata additionally proves that `products` has 127 columns
and no `stock` or warehouse stock columns. The checked-in
`backend-sync-api/pos_stock_syncer_bk.sql` therefore cannot execute on that schema;
its internal transaction/COMMIT, session timezone and `@` variables also cannot
be used inside a caller-owned financial transaction.

The newer service at commit `70b80159016db39a73572f80bfa87c47201c0a9f` stores aggregate
stock in `product_stocks`. Its inventory model SHA-256 is
`07246982120d152e54f897e10d6407e2fa4d49726638376e489c4ff9319d1d3e`.
The candidate implementation in `src/db/stock-projection/` uses that verified
physical schema and its source store/warehouse/buffer arithmetic. It accepts
available POS stock; it does not subtract already-held units again. The ten
warehouse keys in the source arithmetic are explicit. TWH is excluded and MW3
is included, unlike the old backup. Source threshold, unchanged-stock auditing,
parent/size JSON, buffer exhaustion and aggregate audit values are retained.

One product lock serializes changes across stores. Stock, physical/POS/global
audit rows and the caller's own records remain in one transaction. There is no
CALL, session mutation, internal commit, external notification or automatic
external retry. Existing caller-owned product synchronization remains separate.
Missing aggregate/association records, conflicting warehouse/size mappings,
unsupported product kinds, audit-column overflow and unrepresentable Latin-1
audit text require explicit reconciliation. The caller creates missing product
associations using its existing source rules; existing parent stock is preserved.

The candidate is selected only with
`POS_STOCK_PROJECTION_CONTRACT=pos-stock-projection-70b801-v1`. It is off by default.
This selects an ORM implementation and never enables the self-committing legacy
routine. Confirm the writer physical schema, warehouse configuration and all
other stock writers' locking/aggregation behavior before activation. The original
live procedure's complete behavior is not certified by this selection. This is
the POS available-stock transition, not the full ERP/Vinculum import pipeline;
hold reconciliation, transport attempts, overall sync logs and notification
delivery remain owned by their respective workflows.

Validation: 11 isolated local MySQL checks include 15 native source-query vectors
using AST-extracted original `getProductInventory` and the actual source arithmetic,
parent/size escaping, held-stock preservation, unchanged-stock logs, 20 concurrent
changes, late audit rollback, pooled-session preservation, ambiguity/overflow
denials and exact IDs above JavaScript's safe limit. Source startup/imports and
external transports are not executed. The oracle accepts only bounded Number
IDs; the replacement's large-ID tests use exact bigint/string storage directly.
These are component/source checks, not deployed-routine certification.

Trusted durable service jobs have a distinct source actor0 capability:
`availableSystemStockProjection` accepts only operator ID `'0'` and requires
`POS_SYSTEM_STOCK_PROJECTION_CONTRACT=pos-system-stock-projection-70b801-v1`
as well as the ordinary stock contract. Ordinary user mutations continue to
reject actor0 and a caller-supplied `system` property. Both factories share the
same stock arithmetic and transaction/audit implementation. No synthetic staff
record is created. The caller owns authenticated service identity, the durable
job, store authority, idempotency and the surrounding transaction. An additional
native check verifies the separate capability boundaries and exact actor0 audit.

Read-only association evidence on 2026-11-16 found active CORE_WAREHOUSE stores
108/WWH, 110/BW2, 111/DW1 and 113/MW1 with 358101, 358368, 359140 and 360160 respective
`product_store` rows. None joined `hyperlocal_locations.store_id`. This proves
available physical per-store stock, but does not establish the old fulfillment
warehouse mapping. `evidence/mysql-core-warehouse-associations.json` contains
only operational IDs/location codes and counts. A core-warehouse hold cannot
infer an order warehouse ID, reactivate an archived store or revive the removed
`products` warehouse columns from these observations.

Reproduce on the pinned Node version from `backend`:

```sh
MYSQL_INTEGRATION_URL=mysql://root@127.0.0.1/pos_rewrite_integration npm test -- tests/stock-projection.mysql.integration.test.ts
```

The fixture accepts only that local template, creates a uniquely named schema
from saved physical metadata and drops only its own schema. No live DDL or data
changes were made.
