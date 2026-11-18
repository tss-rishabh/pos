# Catalogue workflow native validation

The fourth setup/validation execution passed all eight original-response gates
across two independent profiles, with the actual pinned Django handler,
candidate serialized service and authenticated HTTP application. The raw receipt
is `backend/parity/evidence/catalog-details/workflow-validation.json`; no rows,
array ordering, money or concatenations were normalized to make it pass.

The executed content hashes match the implementation committed as `601a258`
on the `bfd2a64` production graph. The raw receipt retains its actual pre-commit
HEAD and all922 executed input hashes; committing those same bytes does not
substitute another execution. The later documentation update is editorial.

| Scenario                        | Source reads | Service reads | Authenticated HTTP reads |
| ------------------------------- | -----------: | ------------: | -----------------------: |
| Parent, one store,25 rows       |            2 |             3 |                        6 |
| Parent, eight stores, deep page |            2 |             3 |                        6 |
| Selective exclusive-price sort  |            3 |             4 |                        7 |
| Category aggregate sort         |            3 |             3 |                        6 |
| Matrix,25 rows                  |           58 |             4 |                        7 |
| Matrix,100 rows                 |          108 |             4 |                        7 |
| Matrix, literal wildcard        |           10 |             4 |                        7 |
| Dense parent,25 rows            |            2 |             3 |                        6 |

Native Performance Schema calibration independently observed one text SELECT,
one prepared SELECT and one CTE read on each profile. Text SELECT used
`statement/sql/select`; prepared SELECT used `statement/com/Execute`. Their
separate weights were verified rather than assuming status-table `Com_*`
counters. All three source aliases' Django execute counts matched native deltas.
Actual connection/session profiles, source hashes, physical columns/collations
and recorded index metadata remain in the receipt.

The matrix removes per-row ERP reads. Parent catalogue query count is sometimes
higher in the candidate; no universal query-count improvement is claimed.
The HTTP boundary includes authentication reads absent from the other boundaries.
No timing samples, warmups, percentiles, global application speedup or production
p95 were measured or claimed. Dense2000-product/8-store/24-category/2-price-row
dimensions, strict equality and existing deadlines were preserved.

Initial three setup failures are retained privately as r1/r2/r3 receipts. The
useful diagnostic localized the failure to the pinned source driver's native
password-authentication dependency. Hash-locked RSA dependencies fixed that
isolated environment without downgrading MySQL authentication or changing
source models/handlers. Existing source/shared environments were not mutated.

The fourth container's exact recorded ID was verified absent after cleanup.
Its data lived in the bounded tmpfs; no anonymous volume existed. The private
Python environment/cache was removed. No production database/provider was
queried, and no release ledger was promoted. Measurement requires a separate
explicit release and a fresh output file.
