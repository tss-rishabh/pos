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

## Single-stack and schema-freeze decisions — user, 18–19 November 2026

These supersede earlier WIP patterns. Every agent must follow them.

- **Production schema freeze.** Add no tables, columns, indexes or triggers.
  Delete every `pos_rewrite_*` table, registered migration and `*.review.sql`.
  Durable data goes only into existing production tables, written
  synchronously as legacy Django does. Ephemeral state goes in Redis, as legacy
  does: sessions, OTP, idempotency, locks, recovery claims, job queues. If a
  legacy behavior cannot fit existing tables or Redis, stop and ask the user.
- **Node/TS/React/Electron only.** No `.py`, `.go` or `.php` in the repository.
  Legacy oracles are replaced by committed golden JSON fixtures captured from
  the pinned legacy source outside this repo, plus read-only live MySQL parity
  tests. Live MySQL credentials come only from the environment
  (`POS_PROD_RO_MYSQL_URL`). Never write them to disk, logs or evidence.
- **Removed features.** Delete the screening subsystem, everything under
  `backend/compatibility/**` (upstream patches and the customer-contacts
  service), the cash-return intent protocol, demo mode and CSV import authority
  succession. Order submission calls API-v2 `pos/order` exactly as legacy does.
  Keep "pause inconsistent CSV tenders for manager correction".
- **Approved addition: desktop offline billing.**
  - Encrypted SQLite in the Electron main process, with the key wrapped by
    `safeStorage`.
  - Payments: cash plus a manually entered card/UPI reference.
  - The receipt shows a provisional reference stored in `orders.order_ref_no`;
    the real invoice number is assigned at sync.
  - No benefits, either offline or at sync.
  - Syncs automatically on reconnect; conflicts stay on the device for a
    manager to resolve.
  - Limited to 2 hours or 10 orders, whichever comes first, configurable through
    `tss_settings` rows `POS_OFFLINE_BILLING_MAX_MINUTES` and
    `POS_OFFLINE_BILLING_MAX_ORDERS`.
  - Web clients need internet to bill.
- The full plan is in `docs/plans/single-stack-schema-freeze.md`.

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
