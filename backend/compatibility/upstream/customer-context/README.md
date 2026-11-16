# Fresh POS customer context

This separately reviewable API-v2 candidate targets commit
`2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. It has not been deployed. The
generator reads committed source and verifies its SHA-256; its default mode
checks the saved patch and manifest without changing either repository.

```sh
python3 compatibility/upstream/customer-context/prepare.py
python3 -m unittest discover -s compatibility/upstream/customer-context -p 'test_*.py' -v
```

The source AuthHandler caches customer identity, Money, cashback, Points,
gender and birthday in `auth_user:{id}`. Deleting the key after a writer update
does not close the concurrent read-old/repopulate-after-delete race. The private
branch bypasses both cache lookup and population for the exact authenticated
POST paths under `/api/v2/`: `cart`, `pos/cart`, `pos/product`, `pos/order`,
`validatecheckout`, `processorder`, `coupon`, `wallet`, `giftvoucher`, `pg` and
`store-discount-pg`. Gating `processorder` matters: a new request must not replace
a freshly read cart with another cached customer context during quoting.
`pos/cart` and `pg` are compatibility allowlist entries; this patch does not add
routes absent from the pinned API-v2 router.

The backend verifies its own HS256/HS512 customer JWT, then sends a distinct
`TSS_POS_CUSTOMER_CONTEXT_KEY`, contract and customer ID. API-v2 still verifies
the JWT, validates the binding, and loads the active, nonblocked, nondisabled customer using
the request-scoped writer session. Ambiguous block/disabled/status values fail closed;
the native nullable disabled flag accepts only NULL or integer zero.
The parsed request must be POS-scoped with a positive store ID. Guest operator
accounts and tab IDs retain their source behavior. Source membership lookup and
2FA checks remain in place. The helper creates no logs and exposes no database
exception, customer fields or key in errors.

Successful responses identify the contract and bound customer. The backend
rejects missing/wrong proof as an uncertain POST outcome, preserving the
existing reconciliation rules. The key is absent from other API-v2 routes and
payment confirmation; it is separate from the payment projection key. The
context contract is required before these cart/order calls dispatch.

This is a fresh snapshot at the authentication boundary, not a lock held across
remote calls or proof of a financial settlement. Go/Node wallet row locks,
refund-allocation proofs and checkout projection proofs remain mandatory. It
does not change subscription cache behavior or certify all existing third-party
wallet writers. Existing API-v2 logs and deployment ingress need their own
accepted privacy/secret-redaction configuration.

Nine Python checks execute the actual patched AuthHandler method and helper:
cache bypass, fresh membership input, source binding, purpose/path/method scope,
status/block/disabled validation, guest tabs and generic failure messages. Six Node
checks cover signed identity/2FA/expiry/BIGINT, all gated paths, separation of
private keys, missing configuration and uncertain unproven responses. The
existing four projection tests also pass with the private branch.

Before enabling `UPSTREAM_POS_CUSTOMER_CONTEXT_CONTRACT=pos-customer-context-v1`,
review/apply the exact candidate to the deployed revision, configure the new
key through its secret manager, restrict ingress, and demonstrate current
profile/balance values after concurrent changes in an approved sandbox. Record
that deployment and source-route acceptance. No configuration flag replaces
that evidence. No live patch, DDL or provider request was made during these tests.
