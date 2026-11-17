# POS rewrite checkpoint

The application is an implemented review build, not a certified production release.
The last shared checkpoint, recorded at `2026-11-16T22:29:31Z`, passes all 73
checks: 1,211 backend tests, 195 frontend tests and 50 end-to-end browser scenarios.
`backend/evidence/verification.json` binds that tested input snapshot; no input
changed during the run. Later integrated features have focused checks and are
listed below. `backend/parity/release-coverage.json` remains the release authority;
component test counts do not certify every original workflow.

## Implemented feature groups

| Group                   | Current implementation and evidence                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and access     | Password/OTP/TOTP, Google OIDC/PKCE, desktop browser handoff, current role/store authorization, archive/revocation and private media. Actual OAuth tenant acceptance remains required.                                           |
| Selling                 | Catalog, customer/cart/quote, discounts, gift cards, consent, checkout, payment recovery, returns, exchanges and pending cancellations. Reviewed upstream financial contracts remain required before live enablement.            |
| Offline cash            | Cached stock, immutable completed cash receipts, print/reprint, reconnect import and manager stock conflicts. Physical devices/printers and shared-writer acceptance remain required.                                            |
| Benefits                | Money/Points adjustments, exact-paise vouchers/conversion and approved cancellation expiry restoration, with native concurrency/rollback checks. Unproved legacy funding and membership provenance remain gated.                 |
| Administration          | Store/operator/counter administration, reversible archives, stock imports, approvals, gift-card batches, access controls and history. See the administration feature map.                                                        |
| Reports and fulfillment | Daily/historical reader separation, financial/reporting screens, fulfillment, scoped invoice variants and queued CSV/XLSX exports. Warehouse publication and real provider acceptance remain required.                           |
| Web and desktop         | React web build, Electron Windows/macOS targets, renderer isolation and offline shell. Both native CI jobs passed unsigned packaging, integrity, sandbox, restart and offline smoke at commit88b7a4e; later changes need another native run. Signing and physical printing remain release gates. |
| Cashier conveniences    | Scoped letter shortcuts, help/off switch and source staff quotes with asynchronous refresh. Ten shortcut unit cases, eight combined shortcut/cash browser cases, quote source/HTTP checks and quote/desktop browser checks pass. |
| Dashboard and website   | Dashboard reader separation and the one-use, verified-customer website handoff are integrated. Source/native/browser checks pass; warehouse publication and actual website receiver acceptance remain required.                  |
| Barcode and country     | Atomic barcode assignment/audit/recovery, secondary-country search and the franchise store-picker fix are integrated. Twenty-four backend and twelve frontend checks pass, including native races and browser recovery.          |
| Invoice worksheet       | Manual prices, customer labels, exact totals, source-format CSV export and sandboxed printing. Fourteen focused checks and two Chromium workflows pass. This worksheet records no payment.                                       |
| Parent/store CSV        | Three-column product-family assignment import, atomic reset/delete/recreate, audit, shared durable worker and separate historical profile are wired. Twenty-nine merged database/source/parser checks and seven import browser workflows pass. Actual stock/sync/publication acceptance remains required. |
| Historical order reads  | Public date selections now reach PRIMARY/DATA/BigQuery readers, with scoped cursors and post-read session revocation checks. Forty-four backend checks and five browser cases pass. Full original order-list filtering/formatting is still in progress. |
| Order copying           | Actual Counter/Review integration preserves the original draft, separates copy recovery IDs and fences offline cash until a proved online terminal outcome. Three integrated Chromium and 33 existing offline/fast-cash checks pass. Customer-proof hardening and safe unsent cancellation remain in progress. |

## Fixed remaining code checklist

- Finish the dormant offline/Shopify CSV order jobs: the validated parser,
  encrypted staging, GET-only recovery coordinator and published-history repository
  integration exist; the financial adapters and service/API/worker remain unfinished. See
  `backend/parity/legacy-order-imports.md`.
- Membership provenance producers are integrated as source-pinned compatibility
  candidates. Actual Python staging → Go activation → Node cancellation passes
  native concurrency/rollback checks. Their deployment remains external; no
  historical provenance is fabricated.
- Integrate the implemented payment-status reversal slice into financial
  collections, ledger, DSR and historical publications before enabling it.
- Finish customer proof and unsent-operation cancellation for order copying;
  the shared readers, UI recovery and offline-cash guards are already wired.
- Complete the original order-list filters, sorting, queues and formatter fields;
  the simplified projection's qualified history reader does not certify them.
- Finish ecommerce inventory synchronization, whole-order Vinculum status and
  inherited administration add-form boundaries in the source map. Parent/store
  CSV is integrated. The BD upload templates are explicitly retained as an
  inactive prototype: their classes/routes and sidebar are commented in source.
- Reconcile every source route, template, websocket, administration surface and
  background job against `backend/parity/legacy-inventory.json`; attach full
  workflow evidence to the release coverage ledger. It currently certifies no
  complete source workflow.

## External release checklist

- Google OAuth client configuration, registered HTTPS callback and tenant tests.
- Reviewed upstream patches and current shared-writer/stock contracts, accepted
  in an approved writable sandbox with the real payment/notification providers.
- Historical BigQuery table coverage, projections and complete publication/CDC
  proofs. Read-only project access is supplied; it does not establish completeness.
- Repeat Windows/macOS native checks for the final source, then signing,
  printer/device acceptance and representative performance measurements.
- Reviewed migration/backup/rollback rehearsal and production configuration.

## Verification

With local MySQL fixtures and the pinned source checkouts available:

```sh
cd backend
npm run verify:project -- --mysql --browser
```

The source workbook oracle uses the isolated Python environment documented in
`deployment.md`. Verification never receives live service credentials. During a
consolidated run all agents hold source edits; only failures justify another run.
