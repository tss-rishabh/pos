# Exchange CI fixture contract repair

macOS job `134972064065` in [CI run 44352617041](https://github.com/thesouledstore-tss/pos/actions/runs/44352617041) failed at `frontend/e2e/checkout/exchange.spec.ts:192`: the existing zero-stock XL button was absent within the original five-second expectation. This was a test fixture integration gap rather than a Counter/IndexedDB migration failure.

`ReturnsPage` now requires an authenticated earlier-exchange recovery read to return `state: none` before displaying a fresh exchange form, and a current eligibility read before confirming it. The fixture did not handle either `/exchange-recovery` or `/return-eligibility`; its fallback continued to the demo API, which cannot supply those native reverse-flow facts. The production guard therefore withheld the form and size controls.

The fixture now answers the two exact synthetic order/line GET endpoints with responses validated against the production `exchangeRecoverySchema` and `returnEligibilitySchema`. It checks the counter, retained verification ID, exchange kind and operator binding, and confirms both reads occurred before submission. The original XL-disabled assertion, five-second deadline, rejected replacement/reload/retry/reconciliation flow, count expectations and invoice checks are preserved. No production recovery or eligibility guard changed.

Validation on the current integrated source:

```sh
cd frontend
node node_modules/@playwright/test/cli.js test e2e/checkout/exchange.spec.ts
```

The unchanged test scenario passes against the built full App with its demo bootstrap and controlled reverse-flow transport (1 test, 12.4 seconds including fixture startup). Main/focused strict, changed lint and frontend production build also pass. The browser and both owned test servers exited normally. This targeted local result does not rewrite the historical failed CI run or claim a fresh full macOS/Windows certification.
