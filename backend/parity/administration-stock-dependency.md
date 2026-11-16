# Inventory procedure verification dependency

The supplied reader and checked Aurora cluster writer both returned `ER_SP_DOES_NOT_EXIST` with the supplied credentials for `SHOW CREATE PROCEDURE tss.pos_stock_syncer`. This does not prove global absence, the operational POS writer or its procedure body. `procedureVerified` remains false; administrative stock changes fail before mutation.

Read-only workspace discovery found sibling `backend-sync-api` at commit `70b80159016db39a73572f80bfa87c47201c0a9f` and `pos_stock_syncer_bk.sql`. This backup takes six INT/string arguments, starts and commits its own transaction, changes connection timezone and uses connection-scoped `@` variables. Its internal COMMIT would break caller-owned checkout/return/administration atomicity. No-row paths leaving session variables unchanged also need inspection with pooled connections.

The backup aggregates into `products.stock` from online-store thresholds and warehouse columns. Newer sibling `new-src/api/models/inventoryModel.ts` accounts for held stock/buffers, writes `product_stocks.stock` and uses a different warehouse list. Neither proves the deployed writer procedure's behavior.

The refreshed reader metadata confirms that `products` has no stock/warehouse
stock columns, and verifies `product_stocks` plus all three additional audit
tables. A source-pinned, transaction-scoped ORM candidate now has native source
query/rollback/concurrency evidence and explicit opt-in configuration. See
[stock projection contract](stock-projection.md); the old CALL remains disabled.

Before enabling mutations, retrieve the current writer body and dependent triggers/tables, confirm parameter ranges and execute source-derived fixtures for child/parent creation, held stock, e-commerce thresholds/availability, warehouse inclusion, audit rows, duplicate/missing rows and failure rollback. Prove caller-owned transaction safety without session leakage, or build a verified transaction-scoped replacement. Product-sync replay safety remains a separate gate. A backup's existence or a successful CALL is insufficient evidence.

Source `core/tasks.py:182` e-commerce changes additionally call `pos_stock_syncer_bk` for products above threshold before requesting full product sync. This task is another required dependency; it does not prove that the sibling backup body is deployed. Its semantics must be established before the corresponding new settings workflow becomes operational.
