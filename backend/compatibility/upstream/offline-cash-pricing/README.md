# Private source compatibility for offline cash

These stateless resources run beside the existing API-v2 artifact. The rewrite
backend remains Node/TypeScript. The compatibility process executes selected,
hash-checked source methods without importing the application, creating a cart,
persisting ORM models, writing Redis, or invoking payments or fulfillment.
The Node importer owns the atomic settlement, inventory and audit transaction.

The source must be commit `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`.
Checks cover the initializer, price manager, product wrapper, calculations,
rounding helpers, order constructors, model definitions and refund helper.
Source drift fails closed. Neither resource modifies a sibling source checkout.
Keep this immutable original reference artifact separate from the running API-v2
artifact when deploying the approved refund patch to ordinary checkout. The
template projection checks the original bytes, then applies its verified
correction in memory; pointing it at an already patched directory fails closed.

## Resources and contracts

Both resources require `X-POS-Offline-Key` and an operator ID in
`X-POS-Operator-ID`. A valid UUID request ID is propagated; a missing or invalid
one is replaced with a fresh UUID. Input validation rejects extra fields,
duplicate JSON keys, nonfinite values and unsupported methods. Requests are
limited to 128 KB and responses to 8 MB. Query strings are refused.

`POST /internal/pos/offline-cash/prices` produces
`pos-offline-cash-prices-v1`. It accepts up to 1,000 unique products and 99 unique
quantities for the current store/counter business date. Expiry is at most eight
hours and cannot cross that date. Seven reads share one repeatable-read,
read-only snapshot: store, counter, source products, variants, batched stock,
barcode/first HSN and batched tax slabs. Tax boundaries use native MySQL FLOAT
comparison and Latin1 collation in a bound JSON_TABLE query. Each quantity keeps
the source's rounding; receipt sums retain its whole-basket rupee floor.

Membership, bundles, mystery items, customization, artist rules and other
basket-dependent products are explicitly excluded from an anonymous offline
grant and remain available through online checkout. The snapshot lists excluded
IDs. Missing products can be excluded; ambiguous stock/pricing, invalid source
configuration or unrepresentable money reject authorization. An all-excluded
request cannot authorize a sale.

`POST /internal/pos/offline-cash/import-template` accepts only a receipt UUID and
returns `pos-offline-cash-template-v1`. It reads the persisted accepted receipt,
authorization, snapshot, device key and trusted server key; verifies signatures,
hashes, scope, quantities and amounts; and invokes transient source order,
order-store and product constructors. Frozen prices, taxes, line-item mode and
cash amounts survive later reference-price changes. Source category flags,
per-line refund audit allocations and cancellation mapping are retained. A
receipt contains at most 1,000 units and 100 product lines.

The user approved correcting duplicate-SKU refund overwrites. Templates select
the explicit `pos-refund-per-hp-v1` profile with patch SHA256
`e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11`.
Only the individual line predicate changes in memory, against the original
pinned source; the corrected controller hash is independently checked. Refund
math and audit INSERTs remain source methods. Every line must be nonnegative,
cent-exact, equal to its audit allocation, and sum to the original paid amount.
The original oracle profile is preserved for differential evidence. This
approved correction changes affected source results and is not a
response-identical query optimization. See
[`offline-cash-refund-query.md`](../../../parity/offline-cash-refund-query.md).

The source timestamp uses the signed completion time when valid. An out-of-window
device time requires a durable, versioned manager approval bound to the complete
signed receipt hash and authorization. Its attributed SQL timestamp must be
unambiguous in the configured timezone and inside the original grant/day. Neither
manager approval nor import changes the signed receipt or its money.

## Runtime

Use Python 3.12 and the supplied `uv.lock`; the compatibility process uses its
own locked SQLAlchemy/PyMySQL, cryptography and Gunicorn dependencies. Existing
upstream settings are loaded from the pinned settings module without importing
the upstream application.

```sh
uv sync --frozen --no-dev
uv run --frozen gunicorn --chdir /opt/pos-offline-cash-pricing --config /opt/pos-offline-cash-pricing/gunicorn.conf.py 'runtime:create_application()'
```

Inject through the secret/configuration provider:

- `POS_OFFLINE_SOURCE_ROOT`: immutable pinned API-v2 source directory.
- `POS_OFFLINE_MYSQL_READER_URL`: dedicated `mysql+pymysql` SELECT-only DSN,
  without URL query options. Use a deployment account and the accepted-receipt
  consistency contract required by the importer.
- `POS_OFFLINE_MYSQL_CA_FILE`: trusted CA; hostname verification is mandatory.
- `POS_OFFLINE_SERVICE_KEY`: distinct printable secret, 32–4,096 characters.
- `POS_OFFLINE_BUSINESS_TIMEZONE`: defaults to `Asia/Kolkata`.
- The pinned upstream settings environment that determines GST and allocation.

Use network-private HTTPS ingress reachable only by the rewrite backend.
Disable raw URL, header, query, body and error capture at ingress/APM. The supplied
Gunicorn logger replaces raw error/access logging. Application events allow only
module, resource, event ID, event instance ID, request ID, operator user ID and
static result/status. User/customer names, addresses, phones, receipt contents,
database exceptions and secrets are never emitted. Sessions verify their
read-only flag, use bounded reads and always roll back; an unverified proxy
read-only flag fails closed. A shared 20-second monotonic budget is checked
between source calculations and reads. Each SELECT receives only its remaining
MySQL execution allowance, rather than resetting the request budget per query.

On the rewrite backend, configure exact HTTPS URLs in
`TSS_OFFLINE_CASH_PRICING_URL` and `TSS_OFFLINE_CASH_TEMPLATE_URL`, and the key in
`TSS_OFFLINE_CASH_SOURCE_KEY`. Select
`UPSTREAM_POS_OFFLINE_CASH_PRICING_CONTRACT=pos-offline-cash-prices-v1` and
`UPSTREAM_POS_OFFLINE_CASH_TEMPLATE_CONTRACT=pos-offline-cash-template-v1` after
deployment acceptance. The separate import and legacy writer schema contracts,
signing keys and receipt limits must also be accepted before grants are enabled.
The source unset-event-date schema correction is documented in
[`offline-cash-import/improve-query.md`](../offline-cash-import/improve-query.md);
it has not been applied to a live writer.

## Evidence

Run `uv run --frozen python -m unittest discover -s . -p 'test_source*.py'` from
this directory. The 26 checks include signed scope, source basket/refund behavior,
transient constructors/defaults, flags, manager attribution, closed logging and
the independent 51-vector original/corrected refund comparison. Backend Vitest
also validates the strict Node DTO, 44 native FLOAT boundary vectors, complete
seven-query hydration and both resources through the actual read-only
SQLAlchemy/PyMySQL driver against isolated verified MySQL tables. Fixtures are
synthetic. This evidence does not certify the deployed upstream artifact,
production reader/writer configuration or physical receipt printers.
