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

`NativeCouponHistoryHeads` supplies a current native fence for the preloaded
capsule. Its preview is read-only and checks all ten installed trigger bodies;
it performs no historical eligibility queries. A final source invocation sets
a connection-local owner to the authenticated original stage nonce before
entering the source session. Every watched trigger records the revision before
that owner's first mutation; repeated mutations retain that start. Ordinary
writers continue to increment the same revision and clear the owner metadata.

The late validator runs after actual native order verification. For an owned
head its start must equal the published revision; for an unchanged head the
revision must equal it. Shared late locks remain through commit, while the
transaction already holds exclusive locks for its own head mutations. There
are no head locks across Cart-to-Order calculation. This preserves the legacy
Order-to-head lock order and allows unrelated transactions to share the global
controls fence. An intervening order, log or coupon mutation rejects the whole
source transaction. The physical root-commit guard runs after SQLAlchemy's
automatic ORM flush and checks the held rows again, so a mutation after
validation cannot escape the fence. Legitimate source SAVEPOINT releases remain
allowed. A source root commit, including one with an open savepoint, still
fails; checking only `Session.in_nested_transaction()` would leave an outer
commit bypass.
Owner cleanup occurs after the private source context ends and before pooled
connection reuse. Stale owners and failed cleanup invalidate the connection.

Seventeen native Python/MySQL cases cover repeated owned writes, concurrent
order/coupon/log changes, rollback, a waiting later writer, missing validation,
mutation after validation, a changed witness, invalid owner and pooled-owner
cleanup, real savepoint release, root/connection commit bypass attempts and an
unexpected connection close before cleanup. Pool check-in discards an unclean
owner before another checkout can receive the connection.
The shared source commit guard also discards a forbidden physical commit,
including when no coupon-head scope is selected.
All use exact 20-digit unsigned revisions. Source and warehouse
attestations support the same unsigned bound and reject overflow even when
the enclosing seal is authentic. Review SQL and the Python metadata manifest
are checked against the shared TypeScript definition builder. These remain
review-only installation artifacts; existing prototype head tables need the
reviewed nullable owner columns before installing these trigger bodies.

The bounded BigQuery provider/candidate, generation workflow and application
preparation integration are separate work. Source birthday eligibility/guard
and source-day expiry remain independent mandatory contracts. No helper here
selects the financial profile or certifies every source writer/deployment.
