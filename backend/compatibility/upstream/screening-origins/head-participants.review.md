# Shared history head installation

This is a manual DBA review plan, not an automatic application migration. No
account changes or production DDL have been executed by this rewrite.

The application reads the fixed `pos_rewrite_origin_history_metadata()`
function in `history-security.review.sql`. Its locked audit owner has only the
dictionary visibility checked by `origin_history_privileges.py`; the function
returns bounded metadata, never history, credentials or request values. Grant
application and capture accounts EXECUTE on this one function, SELECT on the
required head tables, and SHOW_ROUTINE so they can compare its exact body.
After function creation, grant its locked audit definer EXECUTE on that exact
function too; MySQL requires this self-execution right. The qualifier permits
no other executable object or blanket EXECUTE privilege for the audit account.
Remove their old TRIGGER grants. Neither a global/schema EXECUTE grant nor a
role-based substitute qualifies.

Install each reviewed trigger family under its own ACCOUNT LOCK owner. Use
explicit DEFINER clauses when applying the reviewed definitions. The source,
membership, coupon, counter and audit owners must be distinct, have no proxy or
role grants, and must not appear in the trusted administrator exception list.
Keep existing trigger bodies, SQL modes and transaction behavior unchanged.

| Family | Environment declaration | Exact reviewed definitions |
| --- | --- | --- |
| Source | `POS_SCREENING_ORIGIN_HISTORY_DEFINER` | `history-heads.review.sql` |
| Membership | `POS_MEMBERSHIP_HISTORY_TRIGGER_DEFINER` | `../public-screening-writer/membership-history-writers.review.json` |
| Coupon | `POS_COUPON_HISTORY_DEFINER` | `../legacy-order-imports/benefit-profile/coupon-history-writers.review.json` |
| Counter | `POS_SCREENING_COUNTER_TRIGGER_DEFINER` | `../legacy-order-imports/screening-counter-definition.json` |

`head_participants.py` is the executable allowlist for table rights and exact
objects. Each trigger owner receives SELECT/TRIGGER only on its watched tables
and the listed DML only on its family's head/projection tables. The counter
owner alone receives EXECUTE on its exact `pos_screening_sync_marker`
procedure. Grant no schema-wide DML, grant options, extra routines or ownership
of unrelated objects. The audit account alone owns the metadata function.

The independent counter publisher is an active service account declared as
`POS_SCREENING_COUNTER_PUBLISHER_GRANTEE`, separate from the application and
all locked owners. It may SELECT/INSERT/UPDATE counter heads and counters,
SELECT/INSERT/DELETE contributions, and read source tables. It owns no stored
objects. SHOW_ROUTINE permits it to compare the exact readonly metadata function
body. A dedicated counter-publication qualifier accepts this exact current
publisher only while performing projection CAS; ordinary application/source
qualification continues to reject that caller. All grant, object, role, proxy,
table, alias and trigger checks still apply. This declaration is included in the history policy; it is not a DBA
exception or permission for interactive historical reads. Warehouse readers
remain read-only and are never reused as warehouse writers.

Perform a coordinated cutover: fence all relevant writers, drain application,
publisher and worker sessions, install/reassign the complete reviewed families
and metadata function, remove broad grants, and verify the full v3 qualifier
under each actual runtime account. Unknown head writers, active roles,
unqualified cascades, replication appliers and control-table aliases continue
to refuse admission. Do not bypass these failures with administrator entries.

Before reopening writers, invalidate publications created under the old head
policy: increment every existing membership head revision and the coupon
`controls/0` revision under the writer fence, preserving all other head
columns. Check unsigned revision capacity before incrementing. Discard old
pending capture/publication jobs and cached eligibility documents, then
recapture and publish using the new native head/configuration. Membership
writers hashes also include the v3 policy. Existing coupon wire definition
hashes remain stable, so the explicit controls revision cutover is mandatory.
Rebuild every existing quota baseline from a new authenticated full generation
and install it with the publisher's expected-generation CAS before reopening
quota-dependent writers. Retained baselines from the old TRIGGER-grant policy
do not establish a clean starting state. Preserve head revisions and use the
reviewed publisher replacement/recovery path rather than direct projection
edits or counter resets.
Never reset revisions, reuse an old generation after cutover, or update a head
while ordinary writers are active.

Final validation must exercise these account boundaries, denied bypasses,
concurrent mutations and publication invalidation in an isolated MySQL
installation before deployment. That validation remains deferred until feature
implementation is complete.
