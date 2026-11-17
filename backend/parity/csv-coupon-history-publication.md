# Coupon history source attestation and publication

This is an independent qualification/publisher component. Normal application
history remains BigQuery-only; no API/worker installs this native source port
as a history fallback. No live DDL, row changes, publisher activation or cloud
write was executed.

`couponHistorySourceCapture` takes a read-only REPEATABLE READ snapshot through
the primary-role pool and returns bounded aggregate facts. The literal coupon,
customer, day and month predicates are preserved, including the original
user+coupon join multiplication and future records already in the snapshot.
Indexable date/month ranges match the original DATE/MONTH/YEAR expressions.
Coupon lot membership uses native collation; voucher-code equality preserves
the source's exact decoded string comparison. No raw coupon code, lot, customer
contact or financial row leaves this port.

Source attestations bind the source/schema/server, snapshot, exact request
scope, current coupon digest, participating-writer definitions, three head
revisions and computed result digest. Heads cover coupon-global order usage,
all target-customer orders/logs and coupon control/lot changes. The review SQL
contains ten mutation triggers plus existing-identity backfill and an explicit
completed-cutover control increment. The port checks actual installed trigger
bodies, not a configured contract assertion. These are review-only legacy
triggers/backfill and are deliberately excluded from application migrations.

`sealCouponHistoryPublication` compares independently queried warehouse facts
with the authenticated native capture, exact generation/snapshot/head identity
and CDC boundary. Missing, duplicated, stale or mismatched evidence is refused,
including for a true zero. The reader qualifier checks the publication seal and
warehouse facts again before producing the existing signed `QualifiedCouponHistory`.
Source, publication and replay keys must be distinct. These helpers make no
network calls and do not claim that a raw CDC timestamp is complete history.

The native suite proves five cases on a disposable schema, including literal
COUNT equality for old/future/status cases, 3×3 join multiplication, native
case/PAD SPACE lot behavior, exact code equality, rollback of head mutations,
zero-result attestation and refusal of missing mutation coverage. Nineteen
publication tests cover independent mismatches, scope/seal substitution, exact
revisions above 2^53, stale/empty results and missing/changed writer definitions.

Remaining code/integration includes the bounded BigQuery provider/candidate
query, a signed generation publication workflow, application preparation port,
legacy guard observation and final current-head validation accounting for the
source transaction's own mutations. Pre-order head equality alone is not a
transaction fence. Source birthday eligibility/guard and source-day expiry
remain independent mandatory contracts. Nothing in this component selects the
actual financial profile or certifies every source writer/deployment.
