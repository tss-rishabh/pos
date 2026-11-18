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
only these two executable objects and no blanket EXECUTE privilege for the audit account.
Install `transaction-security.review.sql` under the same locked audit owner. Its
small readonly function `pos_rewrite_origin_transaction_metadata()` returns at
most two current-connection state/isolation records and returns an empty array
when transaction instrumentation or its consumers are disabled. Grant exact
EXECUTE on this function to its audit owner, application/source/publisher
accounts, and the locked counter owner. The counter owner receives no direct
performance_schema read or PROCESS grant. The audit owner already has its
reviewed global SELECT dictionary visibility.
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

## Closed stock platform metadata

A MySQL 8.0.39 installation may retain the two stock `sys.sys_config` BEFORE
INSERT/UPDATE triggers `sys_config_insert_set_user` and
`sys_config_update_set_user`. The fixed metadata function now returns a bounded
`platformTriggers` hash-only section. Both complete identities, events, timing,
locked `mysql.sys@localhost` owner and canonical body hashes must match the
closed registry; that owner must also be an explicit reviewed administrator.
A partial, renamed, re-owned or changed body refuses qualification. Absence is
accepted only when the platform table itself is absent. These triggers only
fill the inserted/updated `set_by` column; the exception grants no permission
for unknown DBA triggers, events or privileged views.

Give source/application/projection callers SELECT on this one platform table
when present so they can retain metadata locks and SHOW CREATE its actual base
InnoDB object. No schema-wide platform privilege or DML is required. The closed
registry is inline in the Python qualifier and copied by the descriptor generator
into the Node and common-Go descriptors, so its code/body is bound by the normal
qualifier and metadata hashes. Runtime performs no platform DDL or grants.
