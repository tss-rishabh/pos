# Manager correction through the private source writer

The selected correction preserves original CSV products, quantities, unit prices,
customer, channel and business time. It changes only the independently attested
historical tender. It creates a separate operation after the original has a
verified permanent no-effect rejection; it never restarts that original stage.

## Source calculation and authority

After all selected cart/profile guards pass, a tender mismatch raises the private
`CalculatedImportReview` before `PosOrder` runs. The receiver rolls back its owned
transaction, reacquires the original operation, checks that no source receipt or
binding won the race, and records the signed negative receipt. Its optional
`pos-import-rejection-calculation-v1` review seals the payable, exact plan hash,
stage nonce and rejection time. Other failures carry no invented calculation.
Retained legacy rejections without this review remain readable and ineligible
for manager correction.

For a successor, the Node transport adds `correctionHash` only to its private
order capability. This is a source-auth HMAC over the entire verified immutable
correction binding, covered again by the capability signature and expiry. It is
absent from public request schemas and from confirmation/publication capabilities.
The source needs no copy of the Node encryption key. It validates the capability,
the exact retained correction row, owner/store/counter/customer/time/channel,
the parent's immutable scope/contact, sole original stage/nonce, signed original
rejection/calculation and absence of later financial effects. Current source
authority still runs, and `historical-correction` approval is mandatory even on
an open current day.

`selected_correction` scopes the approved tender to this private invocation.
The literal calculator runs again; a changed payable produces another no-effect
review. Unit prices are never derived from that payable. The literal order
constructor and approved per-line refund allocation still write their original
values. Native verification uses the scoped tender, then Node retains the full
correction binding in its sealed completed proof. An ordinary import's request
and capability bytes remain compatible.

Both sides must explicitly select `pos-import-manager-correction-v1` through
their existing correction configuration. The private source setting is
`POS_LEGACY_IMPORT_CORRECTION_CONTRACT`. Default production flags remain unset.
This does not enable otherwise unqualified coupons, complementary lines,
membership or screening profiles.

## Executed native evidence

Using Node24.22.3, the locked Python environment and an isolated archive of
API-v2 commit2960acbea10c4eaf16b6d99e15ff6e03ef7724c5:

```sh
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
LEGACY_ORDER_IMPORT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_legacy_order_imports_test \
POS_LEGACY_IMPORT_SOURCE_ROOT=/path/to/immutable-api-v2-2960 \
npx --offline node@24.22.3 node_modules/vitest/vitest.mjs run \
tests/legacy-import-financial tests/import-corrections \
tests/legacy-order-imports/runtime-options.test.ts --maxWorkers=2

CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
POS_LEGACY_IMPORT_SOURCE_ROOT=/path/to/immutable-api-v2-2960 \
sh compatibility/upstream/legacy-order-imports/run-correction-tests.sh
```

The first command passes84 checks and explicitly skips the separate Go bridge
case. The second compiles the pinned Go source callback in a network-disabled
container, runs that bridge against the same kind of disposable localhost native
schema, and passes its case. All85 defined checks are exercised across these
commands. Strict fixture compilation, lint and checked overlay generation pass.
The Go bridge is registered in `verify:project -- --mysql`.

Seven source cases cover acceptance, missing correction capability, missing
source contract, changed retained binding, changed original receipt seal, wrong
approval reason and a newly recalculated payable. Every refusal leaves no
order, HP or source-effect rows. The accepted-Go case executes the pinned
calculator, literal `PosOrder`, original Go `sourceApply` and Node settlement:
₹25.49×2 remains ₹50.98 on the line, source payable/refundable cash is ₹50,
confirmation replay calls the original source once, and exactly one native
confirmation receipt is retained. Source producer publication runs with the
controlled fixture broker. These results do not certify real queue/provider
delivery or the complete private production factory.

The Go bridge needs actual companion proof/benefit/referral schemas rather than
synthetic missing-table fallbacks. `mysql-import-referral-schema.json` captures
only12 physical columns and5 index entries from two bounded read-only metadata
queries. The existing `unique_refer_pair(referred_to,referred_by)` already covers
the source referral update predicate; no production index change was applied or
needed. No application or customer rows were retrieved.

The auxiliary source checkout moved to a newer clean commit during this work.
The explicit source-root option reads the immutable baseline and continues to
verify its existing byte hashes. It neither edits that checkout nor updates the
baseline pins. Actual private startup, all-writer cooperation and complete
workflow/release qualification remain separate required work.
