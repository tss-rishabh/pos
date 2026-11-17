# Private source transaction lock boundary

The private CSV receiver now owns a new SQLAlchemy transaction rather than joining a caller's existing read view. Its shared operator/epoch prefix precedes the receiving Store lock; the original financial operation follows Store, and actual current customer authority takes the global customer row before source Order/HP/reservation work. Capability authentication still occurs before any database hint. These locks do not grant price, date, customer or operator authority.

`screening_transaction.owned(session, cap)` accepts only a new REPEATABLE READ or READ COMMITTED transaction, without changing session isolation. Before `mark_customer(session, cap, customerId)`, a per-connection observer refuses native consistent SELECTs, Order/HP/marker/reservation locking reads, and mutations of those tables. A swallowed refusal is sticky and rolls back the transaction. The exact Session, transaction and signed capability scope are bound to the opaque `current(session, cap)` witness; the private source-session wrapper resolves to that same Session.

For RR, this proves that a read view cannot predate waiting for the customer's previous writer. Ticket count and structural projection reads can therefore use nonlocking indexed reads while the global customer is held. They must not acquire foreign Order or marker/reservation range locks. All count-affecting writers must participate in that customer fence before this capability can be selected; this helper alone does not certify unpatched writers.

Original immutable order/publication receipt reconciliation takes the same Store-before-operation prefix after archival, without treating that prefix as authorization for new work. Current `fresh_authority` remains mandatory before a new source order. Queue publication occurs after SQL commit, with the existing retained outcome journal and no automatic resend on uncertainty.

The scoped native check runs against a disposable local schema:

```sh
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
  npx -y node@24.22.3 node_modules/vitest/vitest.mjs run \
  tests/legacy-import-screening-go/source-locks.mysql.test.ts \
  tests/legacy-import-financial/source.mysql.test.ts --maxWorkers=1
```

Nine tests pass, including seven witness scenarios: primed transaction refusal, plain-read/order-lock/order-write sticky rollback, native/private-wrapper identity, archived original receipt scope, and a cross-store stale-hint race whose first post-customer RR read sees the committed new state. The other eight tests execute the pinned real source offline/Shopify receiver, including rollback, retained receipts, isolated cart state and publication outcomes. Scoped strict checking uses `tools/legacy-import-screening-go/tsconfig.json`.

Source repositories remain unchanged. This transaction prelude does not activate the screening profile. Early Go admission, exact native marker counting and cooperating-writer qualification remain separate required boundaries.
