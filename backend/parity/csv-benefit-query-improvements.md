# CSV benefit query index proposals

Reviewable DBA changes only. No live DDL or application-row probes were performed. Source facts come from committed schema snapshots `mysql-import-benefit-profile-schema.json` and `mysql-customer-contact-schema.json`.

The native `order_coupon_log WHERE order_id=? ORDER BY id LIMIT 2 FOR UPDATE` check must preserve duplicate detection. Saved metadata has only the id primary key, so the current plan can scan the whole primary index. Coupon assignment lookup has separate user_id and c_id indexes but no composite matching both predicates and ID order.

```sql
CREATE INDEX ix_order_coupon_log_order_id
  ON order_coupon_log(order_id,id);
CREATE INDEX ix_coupons_users_user_coupon_id
  ON coupons_users(user_id,c_id,id);
```

Both indexes are nonunique. They do not delete/deduplicate legacy logs or coupon assignments and do not change the ORM query or response. Apply only after checking current deployment indexes, DDL capacity and collaborating writers. These source-table indexes are deliberately excluded from the rewrite migration registry.

The executable local proposal tool creates random disposable schemas, seeds 20,000 generated rows per narrow table, runs the actual Drizzle-bound projections/native digest expressions, compares every response field before/after, and records EXPLAIN plus EXPLAIN ANALYZE metadata. It never reads source/customer rows. Its CLI refuses non-local URLs and prints only traced metadata/static failure codes.

One observed fixture run:

| Query              | Before access            | Before maximum actual rows at a plan node | After access    | After maximum actual rows at a plan node |
| ------------------ | ------------------------ | ----------------------------------------: | --------------- | ---------------------------------------: |
| Coupon assignments | index_merge user_id,c_id |                                     6,659 | ref composite   |                                       67 |
| Order coupon log   | primary index scan       |                                    20,000 | ref order index |                                        1 |

The exact response remains 67 assignment rows with IDs above 2^53, one normal log and two duplicate logs in their separate test scopes. Response SHA256 is `cc4243ff1acddfeb1f10b3b5673d71d511c72dffeaeee4eb590dbfc687a607a1`. No truncation, sum change, deduplication or false-zero fallback is introduced. Optimizer estimates vary; notably LIMIT caused the original log plan to estimate two rows despite visiting 20,000. The table therefore reports observed plan-node rows, not a production latency claim or a sum of all plan nodes.

```sh
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
  node --import tsx tools/legacy-import-benefits/query-proposal.ts
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test \
  npx vitest run tests/legacy-import-benefits/query.mysql.test.ts \
    tests/legacy-import-benefits/query-privacy.test.ts --maxWorkers=1
```

The template is an explicit localhost permission marker; the tool connects without selecting it, creates its own UUID schema and drops only that schema. No existing host tables or timezone configuration are altered. This proposal establishes local exact-response/index evidence; production plan/latency and cross-writer acceptance remain deployment checks.
