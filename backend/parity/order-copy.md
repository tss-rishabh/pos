# Copy a previous order into the connected customer cart

This slice implements `AjaxFetchTheProducts` from `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, `order/views.py:2049–2155`. It requires a connected customer and adds **one unit for each original HasProduct row**, using that row's `prod_id`. Original `qty`, `sub_prod_id`, prices, spent benefits, payment information and funded gift-card identities are not imported. Existing customer benefits remain subject to the ordinary fresh quote and spending authority checks.

The literal source appends whole returned cart arrays, can duplicate earlier additions, can label a thrown partial failure “Cart Synced,” and best-effort clears a guest cart. The six-vector AST oracle retains those defects as evidence. The rewrite uses absolute target quantities, verifies every original HP identity and each acknowledged cart change, and explicitly reviews the actual resulting cart. These safety corrections do not claim parity with unsafe source success branches.

## Immutable draft and copy protocol

The original `draftId`, `draftVersion` and `draftImport.lineItems` never change. Existing `assertCheckoutDraft`, paid completion and recovery continue checking that original snapshot. The copy owns a separate immutable, HMAC-bound review containing the source facts, before-cart digest, origin-manifest digest, current operator/customer/store/counter/version, and one addition per HP. Duplicate SKU rows retain their individual HP IDs and combine only into their desired quantity. The hard bounds are500 original rows/products and999 units per SKU; larger or corrupt manifests are rejected rather than truncated.

Seven traced resources are registered beneath `/api/v1/stores/:storeId/checkout-sessions/:checkoutId`:

- POST `/order-copy-reviews`: `{reviewId,expectedVersion,source}`. `source` is `{kind:'store',storeId,orderId}` or `{kind:'customer',orderId}`. Customer mode always uses the server-bound connected customer.
- GET `/order-copy-reviews/:reviewId`: original review recovery.
- POST `/order-copies`: `{operationId,expectedVersion,reviewId,manifestHash}`.
- GET `/order-copies/current` and GET `/order-copies/:copyId`: saved command/result recovery.
- POST `/order-copies/:copyId/continuations`: `{operationId,expectedVersion}`, only after a lease expires **and no outstanding step was dispatched**.
- POST `/order-copies/:copyId/acknowledgements`: `{operationId,expectedVersion,resultHash}`.

Current check-in, fresh internal/franchise store authority, current customer eligibility, the owned customer-cart lease and the exact original draft are rechecked on the writer. Source-store access is checked independently. A member of one store cannot obtain another store's order facts by changing an ID or using return-specific permissions.

Each step is durably marked dispatched before calling the existing checkout cart/gift-card helper. A source reply must confirm the exact intended quantity and retain other products and existing gift instances. The actual new gift-card instance uses the existing v2 contract; old serials, PINs and funding are never reused. Known unavailable stock produces an explicit partial result with the unadded products listed. A response loss, malformed reply, failed postcondition, source error after dispatch, or lost SQL checkpoint remains uncertain. Equal quantities do not establish which command caused them. Original GET recovery never sends another add, set, sync or clear.

An existing pending command cannot be restarted through an idempotency replay. An explicit continuation can claim only proved undispatched remaining work after the60-second lease; the previous lease cannot publish or dispatch through its replacement. The immutable result is HMAC-bound to the original command, draft and exact step/result manifest. The copy retains the checkout's busy ownership through result review, fencing other profile/contact/voucher writers as well. A separate acknowledgement releases it before normal checkout mutations, quoting or submission. Manual cart edits after acknowledgement invalidate that active binding while the historical copy command remains stored.

This is a cart operation. It never creates a paid receipt, calls payment/order confirmation, completes a local draft, refunds cash, restores stock, or changes a tax/allocation formula.

## Read routing and the source cart boundary

Current business-day source order/HP facts use a bounded primary-reader query. Older facts use an injected `CopyFactsPort`, whose result must be qualified BigQuery data with every HP row, exact order/source ownership, completion/generation evidence, age and query-budget checks. The default does not fall back to old MySQL line reads. Missing catalog rows survive the fact manifest and become explicit current availability failures; there is no historical Product inner join that silently drops HPs.

The reporting-owned adapter is `publicOrderHistory(...).copyFacts({source:{kind:'store',storeId}|{kind:'customer',customerId},orderId,cutoff})`. Root maps customer mode to the current `targetCustomerId`, supplies `sourceStoreId:null` for customer mode, and injects it through `CheckoutRegistrationOptions.orderCopy.history`. The default current reader delegates old orders to that port; unconfigured warehouse history returns503. A raw CDC watermark or reader label alone is not accepted as publication qualification by the reporting provider.

The original API-v2 `SyncCart`/`MySQLCart` can commit in stages, and ordinary cart GET can persist wrapper/freebie/selection changes. This copy therefore operates directly on the **already connected** target cart using the existing authenticated checkout helpers, then reviews the acknowledged actual cart. It does not replay the old array-concatenation/sync sequence or clear an operator guest cart. `PosCartFactory` scopes its persistent cart by customer/store and ignores tab ID, so unconditional guest cleanup could erase another tab. There is no proved copy-owned guest namespace to clear here. The earlier explicit customer-attachment operation owns any actual guest-to-customer transfer; this copy must not retry that operation.

Uncertain dispatched steps remain frozen until a separately qualified upstream CAS/immutable-receipt contract supplies causal evidence. This slice does not manufacture such a receipt from the current cart. No compatibility patch has been deployed and no live provider call was used for testing.

## Offline collected-cash boundary

A copied server cart differs from the original immutable local draft. The child saves an ID-only `pos-order-copy-origin` marker **before dispatch**, and marker storage failure prevents sending. The marker survives acknowledgement, reload and operator logout. Counter disables new offline cash for that origin while `orderCopyRequiresOnlineReview(operatorId,storeId,checkoutId)` is true. Before every copy POST, Review rechecks the actual local cash receipt and immutable review/checkout binding through `bindReviewedCheckout`. Binding and cash completion serialize on the same IndexedDB stores; the lower cash completion path rejects an online-bound original snapshot even in a stale tab. Optional marker cleanup runs only after `completeSale` or `clearReviewedDraft` validates the terminal evidence. A copy acknowledgement never clears this marker or changes the original snapshot.

The writer refuses new copy work when **any** persisted receipt exists for the original `(operatorId,draftId)`, regardless of accepted/conflicted/importing/imported status. It does not infer availability from order linkage or zero/mutable statuses, and never changes, drops, refunds or reprices that money. Original GET recovery remains available after a receipt arrives. Database absence cannot prove that another offline device has no unsynced receipt. A late collected-cash arrival must retain its immutable amount/content and enter the existing manager conflict process; it is not rejected or silently converted to a new draft by this feature.

## Integration and scoped checks

- Apply `src/modules/checkout/order-copy/migration.sql` after the normal checkout migrations and offline cash0011. It creates two rewrite-only command/review tables. Add its exact path to the shared migration runner and copy this SQL into the backend deployment artifact. No source-table DDL is involved.
- `registerCheckout` calls `registerOrderCopy` through its narrow internal `orderCopyCart` port. Root supplies the reporting historical port through optional `orderCopy.history`.
- Review mounts `OrderCopyPanel` for the connected customer outside the editable-only block, with typed copy binding in the shared Checkout DTO. Its pending callback and server binding freeze competing actions, while its own GET recovery and acknowledgement remain reachable. `beforeDispatch` rechecks local receipt/binding evidence. `onSaved` refreshes the existing checkout; it never completes a sale. `checkoutOperationReference` keeps copy UUIDs out of the generic `/operations/:id` recovery protocol, including after acknowledgement/reload.
- Three additional actual Counter/Review Chromium workflows prove copy→acknowledgement→fresh quote, lost-reply reload with GET-only recovery, preserved original line quantities and terminal-clear marker cleanup. The existing 33 offline/fast-cash checks pass alongside these changes. The original draft assertion remains unchanged.

```sh
# backend
npx -y node@24.22.3 node_modules/typescript/bin/tsc --noEmit -p tools/order-copy/tsconfig.json
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/checkout-order-copy
# frontend
npx -y node@24.22.3 node_modules/typescript/bin/tsc --noEmit -p tests/order-copy/tsconfig.json
ORDER_COPY_BROWSER_TESTS=true npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/order-copy
```

The native fixture creates/drops its own uniquely named localhost schema, uses verified physical mappings and real check-in/franchise/lease locks, and injects only provider replies. Chromium uses an ephemeral Vite port/cache and the actual child component. Evidence covers20 concurrent exact starts, long HP identities/duplicate SKUs, origin conservation, explicit partial/result acknowledgement, stale franchise/customer authority, unknown writes despite matching quantities, SQL checkpoint failure, expired-lease continuation fencing, historical no-fallback routing, malformed/tampered input, known collected cash, lost request/acknowledgement reload, exact saved retry, stale actor abort, escaped product text, marker failure and offline blocking. Tests never contact a live service or write to the supplied reader.

## Customer purchase authorization fence

Connected-customer mode now requires the actual local `customerOtp.assertVerified` inside the source-authority writer transaction. Attaching/looking up a customer, or setting a future `verifiedCustomerUntil`, is insufficient. A new prepare rechecks the native proof/current contact before the historical read and again before saving its review. A new start requires that same unexpired native proof and exact reviewed scope. Store-source mode keeps its original current source-store assignment checks.

A private `customerAuthority` captures the native contact revision/digest, actor authentication-version fingerprint, challenge ID, fixed proof expiry and capture time. It is part of the existing HMAC-bound review and embedded command JSON; public DTOs and the historical reader port never receive it. No new DDL or fabricated historical snapshot is used. Old customer-mode reviews/commands without this capture remain unproved even if the customer happens to verify later.

Once a command was genuinely authorized, its GET/review/result/continuation/acknowledgement path checks the immutable capture against the current actor/contact/customer/store/counter/draft/lease. It can finish after OTP/review expiry without sending another code or extending consent. Changed contact/revision, actor version or scope refuses access while preserving every already dispatched change and journal outcome. New prepare/start is never authorized by this recovery exception.

All seven HTTP routes require an actual `request.authSessionValid` validator before work and recheck it after awaited work before returning source/result data. Missing, expired or revoked validators fail closed. A late session revocation withholds the response; it never erases a committed cart/result or treats an uncertain external change as undone. Controlled HTTP fixtures must explicitly install their test validator.

Composition: `orderCopyRepository(config,db,clock,{customerOtp})` and `OrderCopyOptions.customerOtp` accept the existing shared verifier. `registerCheckout` injects its already constructed shared native OTP service into the copy registrar; it does not mint another proof or use a legacy gateway. Existing fixtures add the already registered contact-revision/auth-epoch/customer-OTP prerequisites. Real native tests execute request → mocked queued delivery → verify → copy authorization, including expiry recovery, actor/contact races, forged flags, missing verifier, pre-fix rows and withheld revoked responses. Test traffic uses only disposable localhost schemas and mock delivery.

Availability is a separate pending boundary: a rejected unsent start cannot safely clear a browser origin marker from an HTTP error/404 alone. Until an authoritative serialized unsent cancellation/tombstone and independently validated terminal clear are available, retain the original intent/marker; dispatched/confirmed/uncertain work must remain read-only or follow its existing proved continuation. Do not discard a late immutable offline-cash receipt to release this fence.

Focused authorization checkpoint: 31 backend checks pass (the original 20 plus 11 native OTP/contact/session/historical-row cases), with the owned strict config and scoped lint. No frontend file, shared build/default port, live history/provider call or production database was used for this follow-up.
