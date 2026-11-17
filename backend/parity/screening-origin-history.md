# Original customer first-order counts

Implementation is code-first; no new parity/tests/typechecks/builds have run.
Existing tests and release acceptance remain unchanged. This contract is private
source history, not customer/operator financial authority or an empty fallback.

Pinned API-v2 2960 `OrderController.py` uses three all-time queries: welcome
counts this customer's `NOT order_status=4`; app counts `status=3,flag=18`; web
counts `status=3,flag!=18`. SQL NULL exclusions remain literal. No HP join, paid
filter, event-date cutoff or future-record exclusion is added. The selected
source frame replays each query using independently published baseline facts plus
this exact newly inserted native Order only when that row satisfies its literal
predicate at the time of the query. For normal pending0 creation only welcome
has an extra row; the implementation does not assume future own statuses.

Runtime is `originHistoryRuntime` / `originCustomerHistory` in `history.ts`.
Only the lazy, bounded BigQuery SELECT port is reachable; capture/publisher modules
are not imported. Every execution has typed parameters, a dry run <=1GB, a total
deadline, explicit no-pagination completion, document bounds and abort/late-job
cancellation. Fixed project/dataset/location are tssgcp2025/tss_mysql_raw_layer/
asia-south1. A missing publication AND missing facts can enqueue the authenticated
customer/head demand. Partial, duplicate, mixed, tampered or oversized evidence
fails closed and is never interpreted as a zero cohort.

The published generation is operation-agnostic and bound to actual schema,
writer server UUID, complete writer-definition/security policy and customer head.
No artificial publication age expiry applies to unchanged all-time predicates.
Every new operation response remains freshly source-signed for <=60 seconds and
that original PREPARED command/cart/request. A changed head/origin/definition
requires another independently qualified generation. Conservative completeness
metadata uses capture start, not the later finish/publish time. It is not an
event-time query bound or a promise that later commits were included.

## Native all-writer fence

`history-heads.review.sql` covers User insert and every Order insert/delete or
id/customer/status/flag change. Revision/log updates share the original writer
transaction. Nonpositive/NULL guest IDs do not break unrelated writers; positive
orphan IDs acquire heads without fabricating a current authenticated customer.
Publisher capture separately requires the actual native customer row. Positive
old/new customer heads are acquired in sorted order on reassignment. Overflow
refuses the original transaction rather than wrapping or dropping a change.

Source admission/history save uses operational head metadata only. The final
head lock follows original Order/HP locks. A bounded exact revision log must
contain only this frame's own native order. A physical SQL commit listener checks
again after ORM flush/savepoint release; late watched writes invalidate/rollback.
No head or native SQL transaction crosses HTTP/BigQuery. Historical MySQL scans
occur only in the independently credentialed background publisher snapshot.

A real privilege boundary is mandatory. `history-security.review.sql` provides a
literal READS SQL DATA / SQL SECURITY DEFINER metadata function. Its audit owner
and the four-trigger owner must be distinct locked accounts with no roles. The
function is bounded and returns only trigger/account/grant metadata, no customer
or credential records. The source checks its actual owner/body/security mode,
actual four trigger bodies/owners/strict mode, physical integer columns/PKs,
source customer-prefix index and current no-role/no-proxy application grants.
The metadata function checks all static/dynamic global grants, routine grants,
roles/proxies and indirect control/grant-table view aliases. Dangerous database
patterns are classified with native LIKE plus literal equality, conservatively
including pattern interpretations when partial revokes treat them literally.
No JavaScript/Python case folding stands in for native permission matching.
Unrelated table permissions remain unchanged; this code never grants or revokes.

Non-DBA principals cannot have global escalation/definer/applier powers, indirect
routine EXECUTE, direct control writes, source-table DDL or mysql grant-table
writes. The source caller cannot be a configured DBA exception. Trusted DBA roles
cannot escape to another principal; caller/definer roles and proxies are refused
at both endpoints. The locked trigger owner owns only its exact four reviewed
triggers and minimal table grants. The locked audit owner owns only its exact
metadata function and explicit metadata visibility grants. ACCOUNT LOCK alone
would still permit definer execution and proxy use, so it is not the whole proof.

Other implicit triggers/events owned by a powerful DBA and DBA-definer views that
invoke stored functions are unqualified: they could expose that DBA's otherwise
inaccessible routines to an ordinary writer. Direct routine grants to source
callers permit only the fixed readonly metadata function. Such participants need
reviewed table-limited definers/rights before selection; the audit does not guess
that an unknown stored program is harmless. Unknown SQL bodies are not returned.
Each metadata array has a 1001 sentinel, with >1000 or >500KB refused rather than
silently treated as complete. These are explicit installation capacity limits.

The actual protected objects must be InnoDB base tables and SHOW CREATE must name
the non-temporary object this session would access. Cascading FKs that can alter
Order identity/predicates, delete Orders or mutate heads/logs are refused because
MySQL cascades do not invoke triggers. Incoming replication applier channels are
likewise unqualified without an all-origin head protocol. This avoids claiming
that checking a local writer UUID alone covers row-based replication.

Trusted DBA exceptions are explicitly enumerated, never inferred from caller or
an account's locked/system status. Unrestricted administrators and installed
server extensions remain a reviewed trust boundary; the code does not purport to
defend against a hostile DBA/server. Privilege/DDL installation or maintenance
requires a coordinated source write fence, connection drain and requalification;
old temporary tables/authority cannot survive the cutover. The exact metadata
function and qualifier hashes join the writer policy hash. Existing generations
cannot mask a changed policy. `history-grants.review.sql` contains the concrete
grant/cutover plan. All legacy DDL, definers, roles and bootstrap/cutover remain
manual; none are run by constructors.

Source env requires POS_SCREENING_ORIGIN_HISTORY_DEFINER,
POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER and a reviewed explicit JSON list
POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES. These affect the authenticated
writer policy. A physical read replica cannot stand in for writer origin: native
server UUID/schema/read_only flags must match the runtime witness exactly.

A still-PREPARED original command can explicitly prepare history again after
expiry/head change. `origin_history.save` locks/checks its authentic original
command and appends immutable history versions before updating its authenticated
active reference. It cannot reopen RESERVED/BOUND/COUNTED/unknown work, create an
order or change the original command nonce. Root/consumer owner calls save after
native reauthorization even when an older active document exists. Completed
creation/replay stays first and does not need current history/keys/configuration.

## Publisher integration handoff

The leaf encrypted demand/journal factory is `originHistoryDemands(db,
{journalKey,sourceKey},clock?)` in history-generation-demand.ts. Its selector is
pos-screening-origin-history-demands-v1. Journal key must be independent of source,
capture and publication keys. `history-generation-migration.sql` is rewrite-only.
Source `history-versions-migration.sql` is likewise additive rewrite-only; Root
registers/packages it. Source helpers include origin_history_privileges.py,
history_capture.py plus the three review-only SQL files. OriginCommands/CSK
consumer changes remain with their owners; no ordinary frame/issuer is rewritten.

The executable publisher is now implemented in
`history-generation-worker-main.ts` (`runOriginHistoryPublisher`). It rejects demo
mode, accepts no CLI payload/identity arguments, and reads separately bounded
credential files. Native readonly writer-origin capture uses a private bounded
stdin/stdout subprocess with all required owned import directories, TLS and exact
server/schema/head matching. A changed authenticated native head supersedes only
a never-dispatched demand without reading historical rows. The child never
receives the source admission key and cannot issue an order capability.

The encrypted journal captures before dispatch, materializes actual native rows
and the signed manifest in one immutable original BQ job, independently SELECTs
those rows/counts/ordered-set commitment, seals their equality, then atomically
publishes SELECT-derived counts plus the signed publication in its second original
job. Provider metadata must match project/location/job/query/typed parameters.
Unknown/late responses retain original IDs and are GET-only, including when new
work selection/source configuration is missing. No source/order/payment/provider
is redispatched. Readonly source capture alone can repeat after its lease expires.

Writer credentials must differ from the supplied readonly reports SA and reader
credentials. Writer targets are explicit owned `pos_origin_history_` tables;
reader view aliases are configured independently. Warehouse DDL is review-only.
Constructors do no network/DDL. Actual source, SDK and publication calls occur only
from the explicit worker. Journal and source transactions never span remote calls.
Worker shutdown aborts work and has a 40-second close deadline. Events contain
module/resource/eventInstanceId/requestId/userId:null/timestamp and counts only.
No source IDs, URLs, credentials, SQL, rows or exception stacks enter logs.

Readonly budget preflight now finishes outside SQL before the permanent write
checkpoint. The claim compares the original journal version and authenticated
plan; only its winner can consume the exact in-memory preflight witness once.
Budget/estimate failure leaves the original prepared/qualified state available.
After a checkpoint, missing jobs and interrupted dispatch still remain GET-only.

The bounded privilege/indirect-writer refusal audit is implemented. No new tests,
parity checks, typechecks, builds or live I/O have run under the code-first order.
No remaining publisher/runtime connection is deferred as a deployment task. Source
installation/grants/all-writer cutover, separate publisher-origin/warehouse writer
credentials, reviewed table/view deployment, capacity and performance acceptance
remain unqualified; selectors must not imply production readiness.
Final acceptance must cover native/independent BQ empty/orphan/NULL/future
rows, proxies/roles/definers, cross-writer races, timeout/budget/privacy, original-job
recovery, immutable default-byte behavior and deployment performance. Exact hot-head
matching can legitimately starve a constantly changing customer; no head relaxation
or native request-time fallback hides that pending measured acceptance.

The native security assumptions above follow MySQL's documented privilege and
stored-object behavior: [global/dynamic privileges](https://dev.mysql.com/doc/refman/8.0/en/privileges-provided.html),
[proxy accounts](https://dev.mysql.com/doc/refman/8.0/en/proxy-users.html),
[temporary-table shadowing](https://dev.mysql.com/doc/refman/8.0/en/create-temporary-table.html),
and [FK actions that do not activate triggers](https://dev.mysql.com/doc/refman/8.0/en/create-table-foreign-keys.html).
These references support the qualification conditions, not evidence that any
live deployment already meets them.
