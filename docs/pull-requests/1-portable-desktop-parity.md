# PR #1: portable native desktop parity tests

[PR #1 — Make native desktop parity tests portable](https://github.com/thesouledstore-tss/pos/pull/1)
contains commit `88b7a4e24745a0fd272f429fabaa7e48a4b5a4ac` from
`fix/portable-desktop-parity`, targeting `main`.

The Windows and macOS CI runners checked out only the rewrite. Two frontend
source-comparison tests tried to read an untracked sibling `backend-pos-web`
checkout and failed before desktop packaging/runtime verification could finish.
This PR makes those particular tests runnable from a standalone rewrite checkout.
It changes test infrastructure and desktop evidence documentation; it does not
change production search behavior or the application runtime.

The five changed files are:

- `frontend/tests/source-oracles/datatables-smart-search.json`: exact pinned
  DataTables regex-escaping and smart-search function fragments, original source
  identity and checksums.
- `frontend/tests/source-oracles/datatables-smart-search.ts`: strict fixture
  validation, combined-fragment checksum verification and shared source oracle.
  If the sibling source file is present, its entire file checksum and the exact
  fragment inclusion are also checked.
- `frontend/tests/catalog/snapshot.test.ts` and
  `frontend/tests/finance/ledger-rows.test.ts`: consume the same source oracle
  instead of maintaining separate sibling-file extraction code.
- `desktop-platforms.md`: records the portability failure and the scope of
  desktop packaging/runtime evidence.

The fixture is pinned to source commit
`78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, file
`static/adminlte/plugins/datatables/jquery.dataTables.js`. Its whole-file SHA256
is `ab679fa2da076e735d72fcd717645c575d5ca16c5e9136cca91c65a3c36c2a1b`;
the joined function-fragment SHA256 is
`44e2d73c87f2ba10ec91cc4afd98e67f8d63d9281ba1314beb5209ddaf684878`.
The extracted function executes to produce expected search patterns; fixture
absence or mismatched checksums fails the test rather than substituting a
candidate implementation.

## Historical validation

The [successful desktop workflow, run 43983200922](https://github.com/thesouledstore-tss/pos/actions/runs/43983200922),
ran the exact PR commit above. Both jobs completed successfully:

| Job | Completion time (UTC) | Recorded result |
| --- | --- | --- |
| [Windows](https://github.com/thesouledstore-tss/pos/actions/runs/43983200922/job/133704633097) | 2026-11-17 00:03:32 | Success |
| [macOS](https://github.com/thesouledstore-tss/pos/actions/runs/43983200922/job/133704633552) | 2026-11-16 23:58:34 | Success |

Both jobs passed frontend type checking, build and unit tests; native Electron
and offline browser checks; browser sign-in, customer and order recovery; scoped
invoice checks; unsigned packaging; and packaged integrity, native restart,
sandbox and offline-profile checks. Both retained review artifacts. These are
historical results at the PR commit, not a fresh validation of later `main`.

The PR description additionally records local frontend unit tests, five affected
checks from a temporary checkout without the source sibling, scoped strict
TypeScript/ESLint and a credential scan as passing. This document distinguishes
that author-reported local evidence from the independently inspected GitHub job
statuses. No tests were rerun when this documentation was authored.

The [initial failed workflow, run 43980750466](https://github.com/thesouledstore-tss/pos/actions/runs/43980750466),
remains historical failure evidence. The old documentation's pending packaging
wording describes that earlier state; the successful run above subsequently
completed the listed packaging/runtime steps.

## Limits

A standalone fragment oracle certifies the selected DataTables comparison cases.
Full-project verification still requires the clean pinned original checkout.
These jobs produced unsigned review artifacts and synthetic test evidence;
signed Windows installers, Apple signing/notarization and real OS credential
store acceptance, physical receipt printers, configured provider acceptance and
complete legacy feature parity remain separate release requirements. This PR
and its historical CI do not declare the entire rewrite production-ready or
certify later commits. Merge administration is handled separately; this document
does not perform a merge or deployment.
