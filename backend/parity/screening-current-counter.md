# Screening current counter implementation handoff

Implementation checkpoint, **pending final validation**. The user's code-first
work order defers further parity/test runs until feature integration is complete.
Nothing here selects a production contract or certifies a source surface.

The literal source counts marker rows joined by marker.order_id→Order.id and
marker.has_product_id→HP.id, marker.user_id=current customer, HP.prod_id=390238,
Order.status NOT IN(0,17). Duplicate markers count separately. Quantity,
HP.order_id, Order.customer/date/payment do not change that result. NULL status
and missing joined rows do not count. The original helper's read-error→zero is
an explicit unsafe-source correction: missing evidence refuses admission.

## Production code

`screening-counter/contracts.ts`, `publisher.ts`, `warehouse.ts`, `options.ts`
implement the signed native qualification capture, complete independently read
BigQuery generation, conserved rows/hash, optimistic initialization and explicit
publisher factory. Qualification alone may read old native rows, in an independent
read-only RR writer snapshot. Checkout/preview/final admission never does so.

`reader.ts` verifies the baseline HMAC, native server/schema, current head/revision,
same reviewed definer, nine exact trigger bodies/routine, required physical index
prefixes, narrowly scoped runtime grants, and ≤10,000 current contributions. A
signed complete empty baseline is required for zero. A dropped trigger, changed
definer, missing head/seed, oversized cohort, missing key or broad application
grant refuses before checkout. No historical MySQL fallback exists.

`writers.ts` supplies trigger-only definer maintenance for all marker INSERT,
UPDATE and DELETE, Order INSERT/DELETE/id/status eligibility changes, and HP
INSERT/DELETE/id/product changes. This covers orphan joins becoming present and
marker/customer/parent reassignment while preserving literal multiplicity. The
head and each affected initialized contribution/count update atomically with
the original source DML. Parent loops are bounded and failures roll back DML.

`entry.ts` provides `withScreeningCounterWriter(tx,{customerId,orderIds,lineIds},work)`
for an already witnessed current-customer transaction, and
`screeningCounterMutation(db,{customerIds,orderIds,lineIds},work)` for an owned RC
maintenance transaction. The latter locks sorted users, then sorted Order/HP
parents and nonblocking named entry locks, rechecks the complete affected scope,
then runs the original mutation. There are no deadlock retries or new financial
permissions. Missing entry is rejected by the triggers before contribution/head
locks. Unexpected cross-scope parents require explicit maintenance scope; no
financial handler silently widens its authority.

`screening-profile.ts::readScreeningTicketCount` now reads that projection.
Source `screening_counter.py` mirrors qualification and exact helper replay.
`ScreeningSourceRuntime` captures before preview's SQL guard, replays only the
exact pinned helper in memory during actual Cart/Validate/Processing/PosOrder,
then validates actual owned new-marker contribution. Public creation.reserve
uses the same current reader. Public and CSV capability namespaces stay distinct.
The public frame integration is admin-owned: mandatory
`public_scope(session,cap,preview=preview)` yields the replay Session, closes
after CURRENT reset and before physical success/negative COMMIT or rollback.
Preview installs no reservation/writer hook and always rolls back.

Go `screening_counter.go`/generated definition replace interactive COUNT with
the same authenticated current projection. Confirmation acquires current customer
before Order/HP entry and validates before/after original Apply. Owned named
locks are released before physical COMMIT; failures discard the dedicated pooled
connection if cleanup cannot be proved. The pinned Go baseline remains unchanged;
`prepare.py` composes the candidate overlay. `ScreeningCountSQL`/Python COUNT_SQL
remain exported qualification/oracle literals, with no interactive callers.

The optional public-benefit ABI retains old absent bytes. New creation
`benefitsHash` binds the strict source-HMAC descriptor and original saved work cap
including optional `benefitsContract`/`membershipHistoryHash`. Native membership,
gift, consent and funding checks remain separate; this binding creates no grant,
renews no contact proof and executes no current historical lookup.

## Root integration hooks

- Register only `screening-counter/migration.sql` (three rewrite control tables)
  if desired. The legacy-table procedure/triggers are **review-only DBA cutover**
  in `screening-counter-writers.review.sql`, never automatic app startup DDL.
- Runtime Node/source/Go: `POS_SCREENING_COUNTER_CONTRACT=pos-screening-current-counter-v1`
  and `POS_SCREENING_COUNTER_PUBLICATION_KEY`; leave unselected until qualification.
  Ordinary non-screening profile entry does not require these options.
- Independent publisher: `POS_SCREENING_COUNTER_PUBLISHER_CONTRACT=pos-screening-counter-publisher-v1`,
  independent `POS_SCREENING_COUNTER_SOURCE_CAPTURE_KEY`, publication key,
  `POS_SCREENING_COUNTER_BQ_CONTRACT=pos-screening-counter-bq-candidate-v1`,
  `BQ_SCREENING_COUNTER_PUBLICATIONS_VIEW`, `BQ_SCREENING_COUNTER_ROWS_VIEW`.
  Reuse the shared read-only BQ runner/cap (at most 1GB).
- Executable metadata-only capture/complete entry:
  `node --import tsx tools/screening-counter/publisher.ts capture CUSTOMER_ID`
  then `complete screening-counter-capture-SNAPSHOT_UUID.json [PRIOR_GENERATION]`.
  It requires explicit `POS_SCREENING_COUNTER_ARTIFACT_DIRECTORY`, independent
  publisher writer credentials, private artifacts, and no demo configuration.
  An independently authorized BQ publisher executes the review generation SQL
  between these two phases. No provided read-only credential may execute it.
- Additive common/public generator blocks include the counter definition/source
  modules and Go overlay. Preserve Root's later benefits descriptor manifest
  block and lazy negative-resource import on merge; regenerate at integrated HEAD.
- All participating Node/source/Go mutation owners must enter the supplied
  customer/parent writer boundary before affecting screening join keys. The
  database triggers refuse any missed path; an unconverted writer is a rollout
  blocker, not permission to bypass maintenance. Parent-level callbacks that
  already hold Order before customer need their earlier authority prefix moved;
  do not acquire the customer late or retry an inversion.

## Deployment inputs and deferred acceptance

The bounded read-only metadata evidence
`evidence/bigquery-screening-counter-metadata.json` observed raw orders and HP,
but neither screening marker spelling. The separately authorized publisher must
replicate actual `tss.spiderman_screening_orders` and publish the normalized
generation in `screening-counter-bigquery.review.sql`; there is no alias to an
unrelated table. The supplied reader SA stays read-only. Source completeness
must come from a verified connector/source barrier, never BQ background apply
time/max_staleness. The native capture/full cohort equality and native revision
check are additional independent conservation checks.

The application must not be the trigger definer/publisher, have projection DML,
maintenance EXECUTE, schema/global write/DDL/definer/grant privileges or active
roles. The grants template is review-only and runtime checks enforce refusal.
All-writer cutover, source completeness, restricted application credentials,
schema/index installation, publisher execution, original-source differential
fixtures and mutation/concurrency/rollback/unknown-outcome acceptance remain
pending final integrated validation. Existing fixtures are retained; no test
count is presented as a parity certificate.
