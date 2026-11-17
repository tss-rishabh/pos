# CSK preparation and same-command resumption

Implementation only, pending final validation. No selector is activated.

Register additive `screening-origins/system-preparation-migration.sql` and
package `system_preparation.py`. The existing source worker ports are unchanged.
Its bounded discovery now includes SOURCE_READY and expired source attempts.

The genuine CSK key/reference first owns a native preparation attempt and lease.
The original registration/address/cart prefix runs separately from the source
Order. Once prepared, its real customer, request and cart snapshot are encrypted
and sealed before any warehouse HTTP. An explicit resume restores that original
snapshot, rather than adding the same cart products or rerunning registration.
The real source Order, strict CSK pricelist, tax/refund and original payment body
remain in force. CSK's trusted positive prepaid declaration remains distinct
from a customer-selected payment flag or an invented PSP receipt.

A failed or expired preparation may pause only after the native customer /
command / original job fence proves no source creation, asset/effect receipt,
payment dispatch or order binding. It atomically tombstones that attempt and
retains a purpose-HMACed append-only no-dispatch receipt. Expiry itself does not
release anything. A delayed callback must still hold the exact active attempt
and lease, both before and at the final source seal.

`POST /external/screening-orders/{commandId}/resume` under the original API
prefix requires the genuine current CSK header and empty body. It authenticates
the exact closed native proof and unchanged source service/customer authority,
then arms SOURCE_READY. The worker takes a fresh attempt nonce. No GET starts
source work. An original already-created order uses only its original protected
Go payment stage/recovery; no second source order is possible.

Configuration/contact/identity changes retain AUTHORITY_PAUSED or require an
explicit successor. That changed-authority successor/reference-transfer feature
is still a separate code gap; this implementation does not silently adopt a
different customer, service revision, credential or configuration. A plain
snapshot expiry with unchanged authority can be explicitly renewed only after
its original no-dispatch receipt has been authenticated. Old attempts remain
permanently fenced.

The original input and source prefix are private encrypted payloads. Credentials
are not accepted as payload fields, and no reusable source login token is minted.
Public responses contain command/phase/order IDs only. Source task consumers now
also export `set_observer(callback)` for the closed original-command/actor/phase
events consumed by the dedicated Root supervisor.
