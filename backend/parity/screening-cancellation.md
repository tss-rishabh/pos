# Screening cancellation fence

Pinned API-v2 `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`, `controllers/OrderController.py:5482`, sets `non_cancellable=True` for product390238 irrespective of status and displays “Screening tickets can't be cancelled.” The original POS whole-order write handler does not enforce that presentation predicate. This change makes the stated restriction authoritative; it does not claim identical unsafe old write behavior.

New cancellation evaluation makes a current, scoped HP existence read for390238 immediately after order authorization/locking and original receipt lookup. It refuses with `CANCELLATION_SCREENING_UNSUPPORTED` before projection, full line/audit, customer/benefit, stock or provider work. It applies to a ticket-only or mixed ticket order, including wallet headers. Store/check-in/native actor authorization and not-found errors retain precedence. Context shows the blocker, create refuses, and the frontend displays a plain ticket restriction.

The original immutable receipt still wins. GET, context and exact create replay of an already recorded cancellation continue to return the original receipt, even if a subsequent repair changes HP classification. No new stock, cash, benefit, command or audit effect is created by that replay.

This early denial also prevents a ticket cancellation from holding its Order while waiting for the screening admission's global customer lock. The native race holds customer first in another transaction, observes cancellation acquiring Order, then requests that Order while cancellation continues. Both zero-benefit and wallet-header ticket cases finish with one transaction attempt; retries cannot conceal an inversion. This is separate from the forthcoming screening counter/Go lock rewrite, which must also avoid locking unrelated non-ticket wallet cancellation orders.

No quota is released. The source counter continues its exact marker-row join and `orders.order_status NOT IN (0,17)` predicate; cancelled4 and returned6 are still counted by that source predicate. This fence neither fabricates return/refund rows nor changes marker records.

Scoped evidence (existing dependencies, local disposable schemas only):

```sh
node node_modules/typescript/bin/tsc -p tools/checkout/cancellations.tsconfig.json
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test node node_modules/vitest/vitest.mjs run tests/checkout/mysql.integration.test.ts -t 'screening|cancels one pending zero-benefit' --maxWorkers=1
node node_modules/vitest/vitest.mjs run tests/checkout/pending-cancellation-source.test.ts
```

Three native cases pass: zero/wallet denial plus the customer/Order race, immutable receipt preservation, and the existing20-retry ordinary cancellation regression. Three source/policy cases pass, including four literal source predicate vectors. Scoped backend strict compilation and backend/frontend lint pass. No schema, dependency, route, provider, live data or deployment change is involved.
