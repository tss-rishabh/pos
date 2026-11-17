# Native payment recovery fixture connectivity

Base: `6d8a4bc`. Windows run `44079638874` failed five actual OrdersPage cases
before their first payment/cancellation command. The missing controls were
`Record received payment`, `Recover original terminal payment` and
`Cancel pending order`. Every reported locator deadline was 6,500 ms. The
original UUID/recovery/benefit assertions had not yet run.

The unchanged sixteen cases passed locally. A deterministic negative control
then added only this browser initialization input to the original absent-cash
case, before navigation:

```ts
await page.addInitScript(() =>
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }),
);
```

It reproduced the exact first-button timeout after 6,500 ms, with no payment
POST. The actual application correctly skips initial payment/cancellation
context reads while offline. The fixture had left that input to the host OS,
despite intending to exercise an online request whose POST reply is lost.

The controlled HTML now declares its initial online transport before loading
the harness module. It preserves the host-reported value in an assertion-only
DOM attribute. All five affected flows deliberately start with the false host
input and assert that it was observed, then run their original recovery and
cart-preservation checks. Explicit manager network changes remain available.

A seventeenth actual OrdersPage case checks online → offline → online:
payment and cancellation controls become disabled, no financial command is
sent offline, and exactly one payment is recorded after reconnecting. No
application file, receipt logic, actor/storage guard, deadline or retry policy
changed.

Verification from `frontend/`:

```sh
ADMINISTRATION_BROWSER_TESTS=true npx --offline node@24.22.3 \
  node_modules/vitest/vitest.mjs run \
  tests/order-payments/order-payments.browser.test.ts --maxWorkers=1
npx --offline node@24.22.3 node_modules/typescript/bin/tsc \
  -p tests/order-payments/tsconfig.json --pretty false
npx --offline node@24.22.3 node_modules/eslint/bin/eslint.js \
  tests/order-payments/order-payments.browser.test.ts --max-warnings=0
```

All 17 browser cases, scoped strict checking and lint passed. The CI log did not
capture DOM or browser connectivity values, so the actual Windows runner's
value is unverified. This change removes a demonstrated uncontrolled fixture
input; a new Windows CI run is still needed to establish the remote result.
