# POS rewrite working instructions

Follow the user's Semble search workflow for implementation discovery. Preserve
the source baseline and all feature requirements in spec.md. Source code and
current configuration take precedence over stale README descriptions.

## Standing work order — user instruction, 18 November 2026

Complete all remaining feature and integration code first. Once implementation
is complete, perform parity testing and full verification.

Reaffirmed by the user as a persistent memory instruction: finish everything
first, then do parity and testing. Do not switch to the validation phase while
any required feature or integration code remains incomplete.

- Prioritize complete backend, frontend, desktop, worker, migration and
  integration implementations across the full original scope.
- While required implementation remains unfinished, defer test expansion,
  parity certification and repeated verification runs. Preserve existing tests
  and evidence; do not remove or weaken them.
- Track remaining code explicitly. A stub, missing runtime connection or
  incomplete feature variant does not count as completed implementation.
- After all required code is integrated, run the full source parity, native,
  browser, offline, security, performance and deployment validation phase.
- This changes execution order, not the final acceptance criteria. Do not
  claim production readiness until the later validation phase passes.
- Apply this order to every parallel agent and future continuation unless the
  user changes it.

- Frontend and backend remain separate folders. Desktop + web only.
- Strict TypeScript, no `any`, runtime input validation, exact money/ID handling.
- Use ORM queries for MySQL; bind values in warehouse/report SQL.
- Respect primary/data/BigQuery reader routing and writer consistency for
  mutations, authorization confirmation and session revocation.
- No PII, request bodies, query values, credentials, cookies or raw SQL errors
  in logs. Use registered resource events with request and user IDs.
- Do not execute writes, charges, messages or fulfillment actions against live
  services during migration verification. Use source oracles, sandbox adapters,
  and isolated local fixtures. Read-only production query inspection is allowed.
- Record exact parity scope. Never count an unverified endpoint, a disabled
  adapter, a unit test, or a working demo as full legacy feature parity.
- Keep the production release gate failing until every feature and required
  background job has implementation and test evidence.
- The user authorizes parallel agents. Assign exclusive file ownership, do not
  revert other agents' work, and coordinate shared configuration/schema changes
  through the primary agent.
