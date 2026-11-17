# Check-in authority lock ordering

`assertCurrentStoreAccess` now locks the current operator before the Store,
then checks the current franchise category and required assignment. Its fifth,
server-only argument is `storeLock: 'share' | 'update'`, defaulting to `update`.
Writer callers already take a later exclusive Store lock for financial/native
effects; taking that final mode first avoids two actors upgrading shared Store
locks after locking their own check-ins. Pure readers can explicitly select
`share` and must not subsequently upgrade it. Internal role1 retains its
assignment bypass; franchise role1 still requires an assigned franchise store.
The authorization helper does not add an active-store policy of its own.

`assertCheckIn` now runs one writer transaction even when the caller does not
supply one. It locks current actor → exclusive Store → assignment and explicit
counter → check-in, checking active store/type, current counter ownership,
expiry and exact requested scope before returning. When the counter is omitted,
the already-exclusive Store provides the common serialization boundary: the
current check-in supplies its counter, then a current counter locking read
validates it. Cooperating Store→counter→check-in writers cannot overtake that
Store lock. There is no plain in-transaction hint, RR snapshot priming, extra
pool connection, retry loop or all-counter lock.

No epoch-table query is added. The locked actor already prevents cooperating
credential/epoch writers, and the helpers never acquire an epoch lock later.
A caller that requires an explicit epoch proof must keep its existing
actor→epoch→Store prefix. Callers that already hold later locks must not invoke
the helper as a substitute for acquiring that prefix in the correct order.
An unrelated legacy writer with an inverse prefix is not certified by this
change.

Current check-in presentation uses explicit shared authority locks. It may
discover an unlocked check-in hint before opening its own transaction, then
locks actor/Store/counter and re-reads the current check-in. A changed store or
counter hint yields no current check-in. The hint grants no mutation authority,
does not consume an existing transaction/pool slot and never primes a financial
transaction's RR view. Existing expiry calculation and notification recipient
queries remain unchanged. Clearing a check-in only deletes that row and does
not acquire inverse actor/Store locks.

The original `CHECK_IN_REQUIRED` precedence is retained for a missing, expired
or mismatched check-in even when its Store/Counter scope is also unavailable.
Only those explicit business refusals reached after locking Store are deferred
until checking the current check-in. Native failures are never converted into
an authorization result and no refused path authorizes an effect.

The focused fixture uses verified native column types in a random localhost
schema. It observes real InnoDB waits/lock modes and demonstrates current-row
refusal across actor, Store and Counter archives, literal source-style prefix
contention, role2 assignment order, independent shared readers, two financial
actors, optional-counter moves/archives, a stale RR view, franchise/expiry/role
gates, and a presentation hint changing while blocked (17 focused cases).
The broader administration/application-link/checkout group passes 188 cases.
It runs no provider,
stock or live database action and contains no deadlock retry wrapper.

```sh
ADMINISTRATION_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_administration_test \
npx -y node@24.22.3 node_modules/vitest/vitest.mjs run \
  tests/administration/checkin-lock-order.mysql.test.ts --maxWorkers=1
npx -y node@24.22.3 node_modules/typescript/bin/tsc --noEmit \
  -p tests/administration/tsconfig.checkin-lock-order.json
```

No migration, environment setting or source activation is required. Root owns
any explicit shared-mode adjustments for additional read-only call sites and
the combined project verification.
