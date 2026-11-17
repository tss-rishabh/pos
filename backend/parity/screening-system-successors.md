# CSK authority successors before source dispatch

Implementation checkpoint; validation is deferred and all selectors stay off.

Register `screening-origins/system-successor-migration.sql` and package
`system_successor.py` plus the optional server-side `system_client.py`. The
reference head is required for the selected system writer. It is created in
the same transaction as the first durable job; a missing head/job after that
is an integrity error, not permission to recreate an order.

Select `POS_SCREENING_ORIGIN_SYSTEM_SUCCESSOR_CONTRACT=pos-screening-system-authority-successor-v1`
only for the reviewed integration. Current genuine CSK service authentication
is mandatory. `POST /external/screening-orders/{parent}/successors` (under the
original API prefix) accepts exactly `{successorId,expectedHeadVersion,reason}`.
Reasons are `customer-contact-changed`, `service-rotation` or
`source-reconciliation`. Scope, customer, request, prices and service identity
are native facts, never caller payload fields.

The current service, fixed original customer, old/new command, reference head
and jobs are serialized before transfer. The old command must have no Order,
creation, asset/effect receipt, payment/provider attempt or financial dispatch.
A previously started preparation also needs its exact authenticated immutable
no-dispatch receipt. Its encrypted frozen prefix is reused. An unknown prefix
without a proven original customer is refused rather than assigned a different
account. A never-started job can transfer its unchanged original request.

Transfer permanently tombstones the original attempt/command, appends an
old/new authority receipt, and arms one new source command with the same
reference/request and original customer. Generic exact-reference retries read
the active authenticated head. Neither old signed state nor a delayed original
callback can restore a closed attempt. The new source body still needs its own
current history, counter, native scope and original financial guards.

`GET .../{parent}/successors/{successorId}` reads the exact transfer receipt.
Lost replies never generate a new ID. The server caller journals only scope
digests/IDs/reason before POST; after loss it performs this GET, and a missing
receipt permits only an explicit same-ID retry. No service key, customer/cart
or original request is stored in that metadata journal. The actual external
caller retains its original request in its own existing private outbox.

This feature deliberately does not transfer an already-created Order or an
uncertain provider stage to another authority. Finishing such an accepted order
requires genuine original stage/Go evidence and a separate authority-recovery
contract; minting a new order would not be an acceptable substitute. This
post-creation case remains separate implementation work.
