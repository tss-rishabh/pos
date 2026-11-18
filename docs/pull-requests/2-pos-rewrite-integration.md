# PR #2 — POS rewrite integration and handoff

PR: https://github.com/thesouledstore-tss/pos/pull/2

The user requested integrating all accumulated rewrite work into main and
documenting each PR. This is a repository integration, not production release
acceptance. The original all-feature migration remains unfinished.

## Included changes

- Separate Node24/TypeScript backend and React/Electron web/Windows/macOS clients.
- ORM access, primary/daily/qualified BigQuery read routing, Google OIDC/PKCE
  integration, input validation, resource/request/user tracing and PII-safe logs.
- Checkout, payments/refunds, financial/import recovery, administration,
  inventory, fulfillment, reporting and notification modules with scoped evidence.
- Completed offline cash receipts, cached stock and manager reconciliation;
  durable commands; additive IndexedDB v10 exact-barcode aliases.
- Authorized N/HL/HE details and explicit genuine-N invoice scope, per-line
  eligibility/recovery, original counter attribution and duplicate-SKU restoration
  group proofs. Current product/customer dimensions remain distinct from old facts.
- Exact barcode lookup and scan/sale-context guards; buffered direct quantity;
  product/repair links; quote summary and complementary-product removal.
- Approved per-line refund, wallet/cashback, voucher paise, expiry/archive and
  inconsistent-import handling corrections, retaining the separately requested
  original extra Points history behavior.
- Handoff preservation of administration source/App proof and order/warehouse
  proof authoring, explicitly identified as incomplete rather than certified.

PR1's portable source-oracle commit is merged into this integration branch so
both PRs retain their changes without losing later validation documentation.
See [PR1 documentation](1-portable-desktop-parity.md).

## Validation and important limits

The last complete verifier remains the failed immutable r9 run on caba871:
163 expected checks,162 executed,157 passed,5 failed,1 unexecuted. All five have
passing scoped corrections; no fresh complete run proves the final integrated
graph. backend/evidence/verification-caba871-r9.json retains the exact failure.

Historical Windows/macOS CI44344235142 passed4f30e87, including unsigned native
packaging and recovery checks. Later CI44352617041 failed a stale exchange test
fixture after new guarded reads were added. The fixture correction retains the
original zero-stock/recovery assertions and passes the affected actual-App
scenario locally; see backend/parity/exchange-ci-fixture-contract.md. Current
platform CI results must be inspected independently rather than inferred from
either historical run.

Relevant focused evidence is documented in:

- backend/parity/global-online-invoices.md
- backend/parity/online-exchange-recovery.md
- backend/parity/checkout-barcode-resolution.md
- backend/parity/checkout-counter-catalog-bindings.md
- backend/parity/checkout-summary-controls.md
- backend/parity/administration-store-default-operators.md
- backend/parity/administration-store-create-slack-default.md

Scoped fixtures/source helpers, controlled browser transport, native SQL,
provider carriers and actual routed-App tests have different evidence boundaries.
None is silently promoted into whole-template, real-provider or production
warehouse acceptance. All396 inventoried declarations and all12 release
requirements still await final admission/acceptance.

## Remaining work after integration

Follow HANDOFF.md for the exact implementation/test gaps, preserved branches,
source pins, dependency environments and continuation commands. Important items
include joined lost-claim browser/provider acceptance, new-only gift-card exchange guard,
the full administration/source-order workflows, complete control inventory and
final full parity/regression. Live SSO/client callbacks, curated warehouse/CDC,
financial/SDD providers, current stock writer, workers, signing, physical printing,
offline reconciliation, security/performance acceptance and rollback remain open.

No production schema change, provider call, charge, deployment or signing occurred
because of this integration. The new recovery-claim SQL is a migration artifact;
it has not been applied to a live database.

Immutable claim receipt lookup now has four focused native cases and23 client/
entry checks, strict/lint/build passing in its recorded integration graph; see
backend/parity/online-exchange-recovery-claims.md. Combined backend/frontend
strict checks and the preserved order-warehouse tooling typecheck also passed
on66f0aa7. These are bounded integration checks, not the missing full run.

## Merge condition

Organization ruleset14992756 requires one approving review. PR1's normal merge
attempt was rejected with REVIEW_REQUIRED; auto-merge is disabled. No rule change
or administrator bypass was used. The user authorized merging both PRs, but the
GitHub approval must still be supplied before normal merge completion.
