# Membership provenance producers and native revision fence

This is a concrete, source-pinned compatibility candidate. It has not been applied to either protected source repository or a live database. Configuration remains blank until the deployment and acceptance checks below are complete. Historical membership cannot be reconstructed from its current EAV rows.

## Source and artifacts

- API-v2 base: `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. `controllers/user/userDal.py` SHA256 `ad0135cb60aa2c8ffd8d5aa5bc6d8b343efb97227fd3394a1ff31989054141a8`; `controllers/OrderController.py` SHA256 `821ee475e4e19d0f48c1078e0eaf6dc0f17fbd57506d0e97f125be45b26746ad`.
- Payment service base: `434f3e438d1cb48c64e5723222c6efda506db571`. Its original synchronous allocation and activation expressions remain generated from `juspay/model.go` by `ordinary/prepare_source.py`; the new boundary is `internal/poscheckout/membership.go`, included in `patches/payments-pos-checkout.patch`.
- `api-v2-membership-producers.patch` surrounds the actual `PosOrder` membership block and decorates all eight source member/expiry setters, including the historical `_check` functions. It installs `middleware/PosMembershipProvenance.py` and `middleware/PosMembershipFence.py`.
- `membership-fence.sql` supplies four reviewed native triggers. It is deliberately **not an automatic rewrite migration**. `membership-producer-manifest.json` binds the helper, patch, source and candidate hashes. Read-only regeneration checks are `python3 -B compatibility/upstream/pending-cancellation/prepare_membership_producers.py` and `python3 -B compatibility/upstream/ordinary/prepare_patch.py`.

The membership patch and the independently approved per-HP refund patch compose in either order against the pinned controller; the source composition test compares every resulting Python file. The private customer/membership reader patches remain required, separately pinned artifacts. A successful Beaker invalidation is never treated as fresh membership evidence.

## Transaction protocol

The API producer locks the actual order/lines, current eligible customer, native-collation email owners, revision and EAV rows before the source setters run. It records the **true pre-stage state**. The transaction facade suppresses the original nested `commit()` calls and defers cache invalidation until the membership changes, monotonic revision and HMAC proof commit together. Failed staging rolls back the original setters as well as the proof. An exact replay returns the existing staged proof without extending expiry again. The wrapper does not make the whole original order-creation HTTP request idempotent; the existing Node uncertain-order boundary remains necessary.

Source ORM queries also refresh their identities with current locking reads. Refreshing an object alone would still read an old RepeatableRead snapshot; a row lock alone would still reuse an old SQLAlchemy identity. The native stale-session regression exercises both together and refuses an already supplied customer object/contact that no longer matches the locked identity.

The staged contract is `pos-cancellation-membership-staged-v2`. Go confirmation requires that exact staged proof/current revision and EAV state for a configured membership SKU before calling the original allocations. After those allocations it records the actual activated state and `pos-cancellation-membership-provenance-v2` in the **same transaction** as stock, financial/status changes, projection and delivery outbox. It retains the original before-state. A late SQL failure rolls back activation, revision and proof. Already-confirmed replay validates the immutable proof, not the customer's later membership state, and does not repeat activation or stock changes.

The Node pending-cancellation consumer accepts either the staged or activated v2 record, subject to its existing pending COC14/order/provider/projection checks. It requires exact current order/customer/native header, current unique email digest, revision, EAV rows and proof HMAC. Cancellation restores only the proved before-state, including the original expiry and timestamps, and increments the revision again. It cannot consume the same proof twice. A later unrelated membership/contact change refuses cancellation for reconciliation instead of revoking another entitlement.

The proof HMAC is the existing Node `operationHash` serialization: outer keys `kind,input`; recursively ordered input keys; domain `pending-cancellation.membership-provenance.v2`. Input binds decimal-string order/customer/revision, native header hash, before/confirmed rows, phase contract, original UUID, UTC proof creation string and stored purpose-keyed entity digest. EAV hashes use native `JSON_OBJECT` and `UNIX_TIMESTAMP`, and timestamp states are canonical UTC seconds; restoration uses `FROM_UNIXTIME`. This preserves native TIMESTAMP instants even when API, Go and Node SQL sessions use different time zones. The current email is never persisted in the proof.

The literal source has an upgrade anomaly: API-v2 extends the prior expiry during staging and Go extends it again during activation. The bridge explicitly records that source result (2030 →2031 →2032 in the365-day fixture); this candidate does not silently change the sale's original upgrade arithmetic. Cancellation still restores the independently captured2030 expiry. The already approved cancellation correction therefore preserves the true prior entitlement.

## Native all-writer fence and rollout

Apply the rewrite-owned `cancellations/benefit-migration.sql`, then the additive `cancellations/membership-producer-migration.sql`. The latter only adds nullable `entity_digest`; old/null/v1 records remain unproved and are never automatically resealed or backfilled.

Review and deploy `membership-fence.sql` separately under normal source-schema change control. Preconditions, verified again inside every affected membership transaction, are:

- `users.email` uses the verified `utf8mb3_general_ci` native collation and a visible full leading email index. `user_eav` has a visible full `(entity,attribute)` leading index and native TIMESTAMP creation/update columns.
- All four exact trigger bodies/timing/events/tables and strict captured SQL mode match the generated fence hashes. Missing or changed definitions refuse the operation. Current reads retain table metadata locks so an index or trigger cannot disappear during the financial transaction.
- EAV INSERT/UPDATE/DELETE changes bump the owning customer's revision only for `EXCLUSIVE_MEMBER`/`EXCLUSIVE_EXPIRY`. Notify-only changes do not bump it. Email UPDATE changes bump the customer's revision even if the email is later restored. Native-collation duplicate owners cause the triggering write to roll back; no arbitrary owner is selected. Orphan EAV has no fabricated owner; subsequent email changes still advance the customer's identity revision.

Compliant lock order is order →customer →revision →EAV. A legacy raw EAV writer can first hold an EAV row and then acquire the customer lock through its trigger. This can produce a normal InnoDB deadlock against a financial transaction. Roll back the whole database transaction and allow only the existing bounded **DB-only** retry. Never retry an external payment, message or order side effect because of this failure. The native bridge proves an external writer cannot commit through a held customer fence and that rollback also rolls its revision back.

Deployment must install the rewrite tables and supporting indexes before the source triggers, then enable the compatible API/Go/Node producers together. Do not enable a flag against the unpatched services. Preserve existing live triggers and review ordering/compatibility before installation; this artifact does not drop or replace unrelated triggers. No live DDL is performed by tests or the rewrite migration runner.

Set the same reviewed SKU manifest in API-v2/Go `POS_MEMBERSHIP_PRODUCT_IDS` and Node `POS_PENDING_CANCELLATION_MEMBERSHIP_PRODUCT_IDS`. The API checks the exact union of source `EXCLUSIVE_PRODUCT`/`EXCLUSIVE_UPGRADE_PRODUCT`; Go checks the exact union of its four normal IDs and `EXCLUSIVE_UPGRADE_IDS`. Review the existing `EXCLUSIVE_UPGRADE_365`, `_330`, `_270` values against the source expiry settings as part of activation.

API-v2/Go also require `POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT=pos-membership-native-revision-v1` and the separate random secret `POS_MEMBERSHIP_PROOF_KEY` (use at least32 ASCII characters). Node uses the same secret only as `POS_PENDING_CANCELLATION_MEMBERSHIP_PROOF_KEY`, plus `POS_PENDING_CANCELLATION_MEMBERSHIP_WRITER_CONTRACT=pos-cancellation-membership-provenance-v2`, the existing `POS_PENDING_CANCELLATION_MEMBERSHIP_CACHE_CONTRACT=pos-membership-fresh-reader-v1` and `UPSTREAM_POS_MEMBERSHIP_CONTEXT_CONTRACT=pos-membership-fresh-reader-v1`. No customer JWT signing key is reused. Keep this proof key available for historical proof verification; rotation requires an explicit versioned-key migration rather than silently making old orders refundable.

## Reproducible isolated evidence

From `backend`:

```sh
sh compatibility/upstream/pending-cancellation/run-membership-native.sh
sh compatibility/upstream/ordinary/run-isolated-tests.sh
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/checkout/cancellation-benefits.mysql.test.ts tests/checkout/cancellation-benefit-candidate.test.ts tests/checkout/cancellation-membership-context.test.ts
npx -y node@24.22.3 node_modules/typescript/bin/tsc --noEmit -p tools/checkout/cancellations.tsconfig.json
```

The first runner creates and removes its own MySQL8.4 container/network, publishes only an ephemeral localhost port and compiles the pinned Go test binary. It uses the locked pricing Python runtime without editing it. The actual patched original Python membership block/setters, actual extracted Go allocations and actual Node consumer communicate through that disposable database. Tests cover20 concurrent staging calls,20 confirmation calls, new/prior memberships, original/candidate native differentials for all eight setters, failures after source nested commits/activation/restoration, exact replay, UTC timestamp restoration, native insert/update/delete/email fencing, external writer blocking, notify exclusion, duplicate email ownership and missing trigger/index refusal. They never start the old applications, call a provider, send a message or touch the supplied reader.

The existing Go ordinary suite runs with `-race` and retains wallet/gift/stock/payment/consent/privacy coverage. These checks establish the candidate's isolated behavior, not deployed-source qualification. Existing historical orders without a captured pre-stage proof still require separate evidence and manager reconciliation.
