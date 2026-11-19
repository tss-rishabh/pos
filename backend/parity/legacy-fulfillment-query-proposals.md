> **Superseded (W5, 19 November 2026).** The schema freeze forbids this ALTER and the
> rewrite no longer proposes it. Legacy `update_or_create` inserts that omit
> `delivery_exception_date` store the zero date under the production (non-strict)
> `sql_mode`; the rewrite writes `0000-00-00 00:00:00` explicitly
> (`src/modules/legacy-fulfillment/runtime.ts`, `upsertCourierLog`) and never creates the
> earlier rewrite-only arrival/transfer log. Kept only as historical evidence.

# Local delivery database compatibility proposal

Source baseline `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`;
upstream API-v2 baseline `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`.
No live DDL or row write was executed. This is an explicit review/deployment
input, not part of automatic rewrite-state migrations.

## Missing initial courier log

`AutoHlOrderView` schedules/holds an arriving order without requiring or creating
a courier log. API-v2's initial `build_hyperlocal_order_log_model` call is
commented out (`controllers/OrderController.py:700`). Create/manual cancel/online
conversion use Django `update_or_create`, so a missing log is a normal input.
Arrival and transfer must not fabricate an earlier log/creation timestamp.

The verified physical table has `delivery_exception_date DATETIME NOT NULL`
without a default (`evidence/mysql-legacy-fulfillment-schema.json`). Both pinned
models omit that field on insert. A strict writer consequently rejects the
original insert. Inventing a date would incorrectly claim that an exception
occurred. The reviewed candidate is:

```sql
ALTER TABLE hyperlocal_order_log
  MODIFY COLUMN delivery_exception_date DATETIME NULL DEFAULT NULL;
```

Exact file: `src/modules/legacy-fulfillment/lifecycle/compatibility/001_unset_exception_date.sql`.
It changes only nullability/default. Existing row values, IDs, money, keys and
timestamps are retained. Review operational lock/online-DDL capabilities on the
actual writer before scheduling it; no online algorithm is assumed here.

The rewrite verifies the actual current information_schema type, nullable flag
and NULL default before staging a missing-log command and again before external
financial dispatch. The source contract is not enabled by an environment
assertion alone. Existing-log workflows continue on the verified original
schema. A missing-log ordinary POS order is rejected unless its selected source
lines carry the platform-4 local-delivery identity; SW store/current authority
and Express exclusion remain mandatory.

## Frontend response preservation evidence

The only source display consumer found for this column is
`report/datatables/hyperlocal_report_datatable.py:161`:

```python
obj.delivery_exception_date.strftime("%Y-%m-%d %H:%M:%S") if obj.delivery_exception_date else obj.delivery_exception_date
```

The pinned AST formatter is executed for actual unset (`None`) and ordinary
datetime values. Unset remains JSON null; a real date retains the original
formatted value. Native isolated MySQL cases prove the original strict insert
failure, successful NULL/default insertion after this exact candidate and
unchanged existing date/row values. The existing report DTO already accepts
null and the delivery action UI never invents an exception display.

This evidence covers **new SQL NULL**, not a legacy zero-date sentinel or a
mysqlclient converter certification. Existing zero dates are not rewritten,
and zero-date driver equivalence remains explicitly unverified. No runtime SQL
mode is weakened, no fabricated timestamp is inserted and no live provider is
called. Historical report activation still requires its separate warehouse
inputs/publication contract.
