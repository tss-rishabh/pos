# POS upstream compatibility patches

The ordinary checkout transaction, wallet/stock proof and durable delivery worker are documented in [ordinary/README.md](ordinary/README.md). Its payments patch composes with the exchange patch below. Neither patch has been deployed.

The separate physical gift-card patch and source evidence are documented in [gift-card.md](gift-card.md). Both API-v2 patches apply together to the pinned source; neither has been deployed.

These concrete patches are prepared for review. They have not been applied to either upstream repository or deployed. No live financial calls, messages or database writes were made while preparing them.

| Source                                                      | Pinned commit                              |
| ----------------------------------------------------------- | ------------------------------------------ |
| `backend-tss-api_v2`                                        | `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5` |
| `security-scans-20261113/backend-tss-domestic_payments_api` | `434f3e438d1cb48c64e5723222c6efda506db571` |

`manifest.json` records source locations and patch SHA-256 hashes. `prepare_patches.py` requires those commits and verifies saved artifacts without writing. Explicit `--write` regenerates only this directory's patches. It never edits the upstream checkouts. The new Go transaction source and its tests are kept in `go/internal/posstock`; the HTTP adapter is in `payload/juspay`.

## Problem and resulting behavior

The original payment handler launches exchange confirmation in a goroutine and returns 201 immediately. The goroutine marks an order paid before changing store stock, and the stock helper ignores SQL errors. API-v2 creates and commits the child before calling payments. A timeout or rejected response can therefore leave a live or incomplete child; retrying can create a second child. The original live-child reuse query also omits receiving store/counter validation.

The patch keeps the success responses unchanged: payments returns HTTP 201 with `{"status":201,"message":"/thank-you"}`; API-v2 returns `{"status":"SUCCESS","new_order_id":...}`. It changes when success is permitted:

- POS prepaid exchange confirmation completes synchronously before the HTTP response. Ordinary online/reship/checkout branches retain their existing behavior.
- A Go transaction locks the child, exact exchange relation, parent line and store stock. It validates customer, receiving store/counter, one replacement line, quantity and the receiving store's accepted credit note. It refuses legacy paid children lacking stock proof.
- Stock decrement, placed line, paid/placed order status and `pos-exchange-stock-v1` proof commit together. Conditional stock updates prevent overselling. Every SQL/commit error propagates as a safe rejection; no success is returned from partial work.
- A proof replay does not decrement stock or send the source post-commit effects again. The parent line lock plus active-child proof check prevents two different children funding the same accepted return. Cancelled/dead children do not permanently consume that active-child check.
- API-v2 reuses a child only with the correct receiving store, counter, SKU and committed proof. Incomplete linked children and orphan children block another creation. An unavailable Redis mutex fails closed.
- The rewrite independently checks the same proof, writer-paid prepaid zero total, child/parent/customer/store/counter/SKU/quantity and unrefunded line allocation. An acknowledgment or `paid=4` alone does not complete an exchange. Unknown-result reconciliation never calls order creation or payment confirmation.

Producer, inventory-sync and order-email effects retain their source payloads and run after a newly committed confirmation. Their outcomes are logged using static resource/event IDs, unique event-instance IDs, request ID and authenticated customer ID; URLs, credentials, bodies and raw errors are excluded. Those source effects remain best effort and are not part of the atomic stock proof. Replays do not resend them. The rewrite's own exchange notification uses its durable outbox.

## Validation

From `backend`:

```sh
python3 compatibility/upstream/prepare_patches.py
python3 -m unittest discover -s compatibility/upstream/tests -v
sh compatibility/upstream/run-isolated-tests.sh
python3 compatibility/upstream/compile_payments.py
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test npm test -- tests/checkout
```

The Python suite applies every patch hunk to a disposable copy of the pinned files and executes the patched source guard functions without importing the applications. It covers preserved success responses, other-store/counter/SKU/online rejection, missing proof, incomplete/orphan children and unavailable locking.

The Go suite runs the exact compatibility transaction against a fresh MySQL 8.4 container with race detection. It covers concurrent same-child replay, two different children for one parent line, insufficient stock, conflicting/legacy proof, wrong customer, duplicate relations/extra lines, missing receiving-store credit and an injected SQL failure after stock update that must roll back stock, line, order and proof together. The script publishes no MySQL port and refuses DSNs outside its isolated container/schema; it removes the container/network afterward. Images are pinned by digest. No existing MySQL database or credentials are used.

The compile script archives the pinned payments commit into a disposable directory, applies the patch and compiles the actual `juspay` package with the source Go 1.25.4 toolchain. It runs no application startup or network integrations. Existing `go test -c` vet checks in untouched `Customer.go`/`model.go` report format-string defects; the package compile and isolated compatibility tests are separate checks, and full upstream vet/test certification is not claimed.

## Rollout dependency

1. Review both patch files and the manifest against the actual deployed upstream revisions. A different revision requires regeneration and retesting; the source commits are not proof of the deployed versions.
2. Apply `src/modules/checkout/migrations/0007_exchange_stock_proof.sql` to the shared writer using the controlled migration role. This adds one proof table and its parent-line index; it performs no legacy backfill or inventory adjustment. Give the payment service transactional write access to this proof and the rewrite API read access only. Keep migration privileges separate.
3. Deploy the reviewed payment adapter/transaction and API-v2 proof/scope guards as a coordinated change. Verify the shared schema, driver isolation, privileges, payment-method mapping and nonnegative stock behavior in an approved sandbox before enabling normal exchanges.
4. Verify a sandbox exchange and timeout recovery end to end with the actual services. Existing paid/incomplete children without proof require an audited repair; never synthesize proof from an HTTP response or current stock balance. Missing/unrecognized proof remains fail-closed in the rewrite.

This patch does not verify the deployed `pos_stock_syncer` procedure. The sibling backup starts/commits its own transaction and must not be called inside a financial writer transaction. Saleable return restoration remains gated until the deployed routine/projection contract is independently proved. Invoice legal parity, live provider certification, legacy ambiguous-exchange import and the complete route parity release gate remain separate open requirements.
