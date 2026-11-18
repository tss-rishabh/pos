# Writer-current operator/store creation authority

The focused native regression runs against base `b2828883905bf9c1469924b1bf1057f66547cf3b` reproduced seven unsafe admissions: operator creation after demotion, reduced OPM tier, archive or organization change; store creation after an organization change; and current franchise role1/3 creation of an IN_HOUSE store. All eight legitimate creation cases already passed. These are implementation defects against the rewrite's existing authority/security contract, rather than newly inferred source financial or archival policies.

The correction reuses the existing writer-locked actor identity read through `assertCurrentOperatorIdentity`. Operator creation rechecks active account, current role/tier and organization after the real password hash and within the transaction holding both identity inserts. Store creation checks current organization before store/franchise/counter/default-assignment writes. Both retain the existing registry → actor shared-lock order. Other authority helper callers retain their previous behavior. Denials keep the existing AUTH_REQUIRED / ROLE_ACCESS_DENIED / OPERATOR_ROLE_DENIED / OPERATOR_SCOPE_DENIED / STORE_ACCESS_DENIED contracts.

`tests/administration/creator-authority.mysql.test.ts` executes real services, ORM transactions and PBKDF2 hashing against an owned physical-schema MySQL fixture. An independent native transaction locks the exact administration registry row. The test observes the request's actual `performance_schema.data_lock_waits` entry before changing the actor and releasing the lock. For operators this proves the actual hash completed before the controlled transaction admission. No timer-only assumption, password-function mock, API response substitution or live provider is used. The fixed deadline remains five seconds; missing lock instrumentation fails the prerequisite.

Every refusal verifies unchanged counts for `pos_user`, commerce `users`, `stores`, `store_counters`, `user_stores` and `pos_franchise`. Allowed cases verify internal operator roles1/2/3, franchise OPM creation of staff, internal/franchise store creation by roles1/3, actual counter/default assignment and empty commerce password fields. They do not certify complete browser forms, authentication middleware, deployed source data, arbitrary interleavings or provider integration.

Fresh corrected native execution: **15 passed, 0 failed, 0 skipped**. The unchanged test on the vulnerable baseline yielded **8 passed, 7 failed, 0 skipped**. Backend strict, separately scoped test strict, changed-file ESLint and whitespace checks passed. [The bounded receipt](evidence/administration/creator-authority-native.json) records exact input/raw-result hashes and cleanup; original raw failure/result logs remain at the recorded private paths without rewriting them. Both pinned MySQL8.0.39 containers used unique owned ports/CIDs/nonce labels, two CPUs/one GiB, tmpfs data, and were removed using exact-ID `docker rm -fv`; no anonymous volumes remain. No production database, schema or source checkout was changed.

Reproduce the targeted suite with Node24, locked backend dependencies and a separately owned localhost MySQL8.0.39 fixture with Performance Schema lock instrumentation:

```sh
CI=true NODE_ENV=test TZ=UTC \
  ADMINISTRATION_CREATOR_MYSQL_URL=mysql://root@127.0.0.1:OWNED_PORT/pos_rewrite_creator_authority_test \
  node node_modules/vitest/vitest.mjs run \
    tests/administration/creator-authority.mysql.test.ts --maxWorkers=1
```

The test creates and drops only its unique `pos_rewrite_barcodes_<nonce>` schema. The caller owns disposal of its database container. The outer template pathname is mandatory, port54777 is refused, and no supplied live credentials are read. This scoped evidence does not promote any source route or release ledger entry.
