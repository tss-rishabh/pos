# Production store creation default operators

The source pin `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a` reads `STOREDEFAULTUSER` as comma-separated strings (`POSAdmin/settings.py:637`). `CreateStoreView` resolves each against `PosUser.contact_email`, skips missing identities, and retains assignments for existing archived users. Login email and the creator's ID are not substitutes.

The production App previously omitted `defaultStoreOperatorIds` when registering administration. Consequently its real store-create route always returned dependency unavailable, even though standalone tests with injected IDs passed. `registerAdministration` now parses the actual source configuration and passes contact identities into the existing service. No App/finance/other registration block changed, and no startup identity query was added.

Set `STOREDEFAULTUSER` to exact comma-separated contact email tokens with no whitespace around tokens. Explicit empty/blank configuration means no default assignments; an absent variable keeps creation unavailable. Invalid/oversized configuration is rejected without exposing supplied values. Individual tokens are not trimmed or otherwise normalized into another identity. The resolver uses the writer's native collation and current locked operator records inside the creation transaction. It skips missing/deleted contacts, validates supported operator settings and rejects ambiguous identities/configuration before store/franchise/counter/assignment writes. Archived recipients retain their source assignments while active-account checks continue to deny access. No archived account is activated. The existing server-constructor ID option remains supported; supplying both ID and contact sources is an explicit refusal, and explicit constructor configuration takes precedence over environment discovery.

Actor role/organization checks and the existing registry→actor lock prefix remain. Recipient rows are read with shared writer locks in ID order, and native grouping checks ambiguity using SQL collation. One bounded bulk identity read replaces per-recipient lookups, with one additional grouping read when multiple contact matches need validation. No schema/index change or plaintext/PII logging was added.

Fresh targeted verification passed **7 checks**: six actual `buildApp`/signed native-cookie cases plus configuration parsing. Configured contacts resolve different recipient IDs from the actor and login email; archived-cookie access is401; explicit empty creates with no grants; missing configuration creates no partial rows; recipient deletion/replacement after startup is resolved at the write; archived creators are denied; and a controlled duplicate-collation fault is refused atomically. The fault case alone drops/restores the existing unique contact index on its disposable schema. Normal cases retain captured physical metadata. The existing **15 creator-authority regressions** also passed, preserving current role/organization boundaries and legitimate internal/franchise capabilities. Those behavior checks preceded a parser-only removal of token trimming; the final7-check App/config execution exercised the final parser bytes.

Backend strict, separately scoped test strict (including the repository's existing typed paytmchecksum declaration) and changed-file ESLint passed. [The receipt](evidence/administration/store-default-operators-native.json) records exact hashes, cases, boundaries and cleanup. All tests used owned bounded localhost MySQL; exact-ID removal with volumes left no container or anonymous volume. No live database, provider or frozen r9 input changed. This does not certify the separate four-route source/forms/browser workflow, which remains in progress.

Targeted command from backend with Node24 and locked dependencies:

```sh
CI=true NODE_ENV=test TZ=UTC \
  STORE_DEFAULT_OPERATORS_MYSQL_URL=mysql://root@127.0.0.1:OWNED_PORT/pos_rewrite_store_defaults_test \
  node node_modules/vitest/vitest.mjs run \
    tests/administration/store-default-operators.mysql.test.ts --maxWorkers=1
```

The test creates/drops only its unique physical fixture schema; the caller owns its disposable MySQL container. The source email list is runtime configuration, not a request-body field or a fixture-only handler override.
