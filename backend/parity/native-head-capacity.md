# Native head privilege capacity

The original 65-row sentinel accepted at most 64 `SHOW GRANTS` rows. It cannot
represent the Node application's required table-scoped writer grants when all
features share `MYSQL_WRITER_URL`. Schema-wide DML and roles would violate the
existing source-head policy and are not substitutes for that table surface.

`tools/native-head-metadata/node-writer-minimum.review.json` records a verified
minimum at `17c7e39`: **229 mutated physical tables**, **281 read-or-write targets**
and **651 explicit privilege cells** (264 SELECT, 215 INSERT, 149 UPDATE and
23 DELETE; one grant statement may combine rights on one target). Every table
has a source mutation/read reference. This uses actual app-reachable Drizzle
calls, upserts, finite image/wallet/terminal helpers and bound raw mutations,
not every model in the reflected schema. Independent publisher/private-worker
tables and migration DML are excluded. Migration/trigger/function installation
requires a separately authorized deployment account; the app does not gain DDL.
The catalog is a review aid, not automatic GRANT SQL or an expanded allowlist.
Additional raw lookups and locking-read rights can exceed this minimum.

The same review file allocates **3,888 privilege cells** across the expected
Node writer/readers, API/private CSV/Go/Django source writers, independent
capture/publication accounts, locked origin/member/coupon/counter/stock definers,
audit owner and explicitly reviewed DBA/platform/migration accounts. Only the
Node minimum is code-measured; the other allocations are declared deployment
budgets, not fabricated captures of production grants. The fixed full-server
metadata function still inspects all actual accounts and privileges. Exceeding
the whole-install cap refuses qualification, even if each individual account
fits. Unrelated grants must not be silently filtered to fit this capacity.

`compatibility/upstream/screening-origins/native-head-limits.json` is the sole
reviewed numeric source:

| Bound | Accepted maximum | Overflow proof |
|---|---:|---|
| Caller grant statements | 512 | 513th row or any non-EOF/error refuses |
| One grant statement, UTF-8 | 8 KiB | Every row is measured |
| Caller grant statements, total UTF-8 | 512 KiB | All rows contribute |
| Full-server privilege cells | 4,096 | SQL returns the 4,097th sentinel intact |
| Every other metadata section | 1,000 | Existing 1,001-row sentinel remains |
| Entire metadata JSON, UTF-8 | 2 MiB | Oversized/invalid documents refuse |

Node consumes mysql2's complete execute result, never a sliced grant prefix;
Python requests the sentinel through the bounded native result reader; Go reads
to EOF and refuses scan/iteration errors. A row within these byte budgets still
passes the original privilege checks. No protected-head DML, schema/global DML,
grant option, unqualified routine, role/proxy route, unknown privileged definer
or incomplete metadata is newly accepted. Ordinary grants on unrelated tables
remain inspected. SQL timeouts and transaction/metadata-lock requirements remain.

`tools/native-head-metadata/generate.py` renders the SQL sentinels and generated
Python constants, embeds the same limits in Node/Go descriptors and includes the
limits digest inside the installed function body. Changing any budget therefore
changes the exact function hash without adding a new JSON authority path.
The generated `native_head_limits.py` is a runtime import for source qualifiers,
the readonly capture and standalone counter checks; the JSON is a generation and
review input. Both belong in the qualified source bundle. Node/Go consume their
generated descriptor; no request or environment option overrides these limits.

Deployment is a reviewed upgrade: fence/drain source writers, install the exact
new readonly metadata function under its existing locked audit owner, deploy all
matching Node/Python/Go descriptors/source manifests, then requalify and recapture
the affected source-history/counter publication evidence. Do not keep an old
function or silently accept an old metadata hash. Existing immutable completed
financial receipt reads retain their frozen proof semantics. This review neither
changes source business effects nor authorizes live grants/DDL. Actual complete
production grant counts, account topology, metadata size and runtime remain
external installation qualification.

Local evidence: `capacity.test.ts` compares the actual Node/Python helpers on
16 grant vectors and seven metadata UTF-8/JSON vectors, including exact byte
limits, malformed rows, EOF boundary, empty values and complete result overflow.
`capacity.mysql.test.ts` installs the real reviewed metadata function and all
origin/member/coupon/counter families on digest-pinned MySQL 8.0.39. It applies
the measured Node catalog's actual table rights plus two explicitly declared
readonly test participants. Their combined metadata exceeds 1,000 cells and
qualifies; source/Python and Node both accept exactly 512 caller rows and 4,096
global cells, and refuse the 513th/4,097th intact sentinel. Protected-head DML,
schema DML and a granted-but-inactive role still refuse inside the permitted
capacity. The test does not claim that the two readonly participants are a
minimal read-pool permission set. It uses existing `CHECKOUT_MYSQL_TEST_URL`, or
the explicit `NATIVE_HEAD_CAPACITY_MYSQL_TEST_URL`, and a guarded disposable local
schema. No production grants, data or provider effects are used.
