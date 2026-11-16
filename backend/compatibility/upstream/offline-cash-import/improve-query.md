# Strict cash-import schema compatibility candidate

Verified physical MySQL metadata is recorded in `backend/evidence/mysql-extra-schema.json`. The literal API-v2 constructor at source commit `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5` supplies `''` for unset shipment/return dates and courier, and for a nullable payment-discount enum when unused. Modern strict MySQL rejects the empty DATETIME/enum/numeric values. This is a correctness compatibility change, not a measured query-speed improvement.

The concrete candidate `001_unset_event_dates.sql` changes only `orders.ship_date` and `orders.ret_ex_request_date` to nullable DATETIME DEFAULT NULL. Existing rows and every financial/date-of-sale field are retained. It is not part of the automatically registered rewrite migrations and has not run on a live database. Keep `OFFLINE_CASH_ORDER_SCHEMA_CONTRACT` unset until the approved writer definition is verified. The importer independently verifies actual nullable DATETIME columns and never changes session SQL mode.

| Source value | Reviewed import representation | Response condition |
| --- | --- | --- |
| Empty unset shipment/return date | SQL NULL after the explicit schema candidate | Represents absence of the event; never use sale/import time as a fabricated event date |
| Empty unused `pg_disc_platform` | SQL NULL, supported by the existing nullable `enum('ONLINE','STORE')` | No discount is applied; preserve all amount fields and active enum values |
| Empty courier ID | Integer0 | Source absent-courier sentinel; do not assign a real courier |
| Physical nonnullable HP fields not declared by source ORM | Empty return quantity/reason/Vinculum status, zero anonymous cart-additional discount | Only a newly placed anonymous cash row; no return or extra discount is manufactured |
| Source floating decimal remainder | Bind original decimal string and let the verified native column store it | Recheck stored source totals and refund audit correspondence before committing; never multiply rounded one-unit tax |

Native importer tests use complete verified physical tables and default strict/NO_ZERO_DATE mode. They prove successful coherent source-money import, SQL NULL for unset dates, preserved cash/source tax totals, source audit rows and complete rollback on mismatch/failure. The rewrite's current order-detail and receipt payloads do not expose the two unset event dates, so these fields do not change their frontend response.

Before applying this candidate, audit source consumer null handling and exports/templates that format those event dates, exercise old zero-date and new NULL rows, and capture actual writer DDL. Existing Django/source jobs may have stronger null assumptions than the new frontend; native fixture success does not certify them. Any necessary consumer patch must be concrete, pinned and tested before rollout. Do not convert old rows, invent a sentinel date, weaken strict mode or hide this dependency behind an environment flag.

Performance candidates for immutable receipt acceptance/list/status are primary/unique receipt, authorization+sequence, operator+draft, and store/status/time indexes in migrations0011–0013. Imported list proof verification is batched (up to20 full receipts/20k structural HP rows per proof-reader call); it does not issue a proof query for each listed receipt. Production latency claims require representative plans and measurements on an approved isolated copy.
