# Source Python runtime contract

The pinned POS source `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a` selects CPython3.10: `Dockerfile:21–23,47–48` and `Dockerfile.celery:19–21,40–41` install Python3.10 and explicitly link `python`/`python3` to it. The patch release is not fixed by those Dockerfiles.

`source-python.ts` validates CPython3.10 before executing pure operational-report AST/query oracles. It defaults to the caller-owned required workbook `.venv` interpreter, with the Windows `Scripts/python.exe` path where applicable. `POS_OPERATIONAL_SOURCE_PYTHON=/absolute/path/to/python3.10` is an explicit alternative. It fails clearly when unavailable or wrong-version, never installs an interpreter, changes global PATH, selects another ambient Python, or writes bytecode. Caller inputs, arguments, buffer limits, deadlines and exact result assertions are retained.

This corrects an oracle prerequisite, not a production money calculation. Frozen r9 used a PATH with Homebrew first; its unqualified `python3` was CPython3.14.7. For the actual source reducer and the same synthetic refund bucket, Python3.10.22 returns `-11.950000000000001`; Python3.14.7 returns `-11.95`. The existing TypeScript ordered `+=` matches source3.10. Neither rounding nor approximate assertions should hide this distinction. The original frozen r9 log is retained unchanged at `backend/evidence/private/verification-backend-tests.log` in its frozen worktree.

Migrated seventeen calls in eleven operational-report test files: flash-sales; performance-domain; order-report-domain (rows/headers); privacy; scheduled-domain; mysql.integration (returned-orders/performance-query/performance/inventory/acceptance); feedback-history.mysql.integration; flash-sales.mysql.integration; hyperlocal-daily.mysql.integration; order-report-mysql.integration; scheduled-data.mysql.integration. Every migrated Python script executes this same pinned POS deployment's pure source logic with standard-library fixture seams, not another source application's runtime. Native MySQL tests retain their existing assertions and environment gates; launcher qualification alone does not certify native query results.

Other report generators and unrelated source applications retain their own runtime contracts. No global PATH replacement or shared-venv mutation is introduced.

Focused command from `backend`, using an already-installed validated interpreter and owned mitigated Node24 dependencies:

```sh
POS_OPERATIONAL_SOURCE_PYTHON=/absolute/path/to/python3.10 node node_modules/vitest/vitest.mjs run tests/operational-reports/flash-sales.test.ts tests/operational-reports/performance-domain.test.ts tests/operational-reports/order-report-domain.test.ts tests/operational-reports/privacy.test.ts tests/operational-reports/scheduled-domain.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc -p tests/operational-reports/source-python-tsconfig.json
```

There is no remaining ambient `python3` subprocess caller in `backend/tests/operational-reports`. Other directories were not migrated by this bounded change; they must be reviewed against their own source runtime before sharing this launcher.

Focused result:10 unchanged source-comparison tests across five files passed on CPython3.10.22. Nineteen pure SQL-extraction variants used by migrated native tests launched successfully through the helper; no database queries were run for those smoke checks. CPython3.14.7 was explicitly refused before oracle execution. All eleven caller files and the helper passed focused strict TypeScript and ESLint. The native MySQL suites themselves were not rerun by this tooling correction.
