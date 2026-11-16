# POS rewrite working instructions

Follow the user's Semble search workflow for implementation discovery. Preserve
the source baseline and all feature requirements in spec.md. Source code and
current configuration take precedence over stale README descriptions.

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
