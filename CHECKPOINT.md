# POS rewrite checkpoint

The application is an implemented review build, not a certified production release.
`backend/evidence/checkpoint-follow-up.json` records the last passing consolidated
checkpoint, retaining the original verification report and its two corrected
test fixtures. New source changes since that checkpoint have focused checks;
they are not covered by that historical result. `backend/parity/release-coverage.json` remains the
release authority; component test counts do not certify every original workflow.

## Implemented feature groups

| Group                   | Current implementation and evidence                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and access     | Password/OTP/TOTP, Google OIDC/PKCE, desktop browser handoff, current role/store authorization, archive/revocation and private media. Actual OAuth tenant acceptance remains required.                                           |
| Selling                 | Catalog, customer/cart/quote, discounts, gift cards, consent, checkout, payment recovery, returns, exchanges and pending cancellations. Reviewed upstream financial contracts remain required before live enablement.            |
| Offline cash            | Cached stock, immutable completed cash receipts, print/reprint, reconnect import and manager stock conflicts. Physical devices/printers and shared-writer acceptance remain required.                                            |
| Benefits                | Money/Points adjustments, exact-paise vouchers/conversion and approved cancellation expiry restoration, with native concurrency/rollback checks. Unproved legacy funding and membership provenance remain gated.                 |
| Administration          | Store/operator/counter administration, reversible archives, stock imports, approvals, gift-card batches, access controls and history. See the administration feature map.                                                        |
| Reports and fulfillment | Daily/historical reader separation, financial/reporting screens, fulfillment, scoped invoice variants and queued CSV/XLSX exports. Warehouse publication and real provider acceptance remain required.                           |
| Web and desktop         | React web build, Electron Windows/macOS targets, renderer isolation and offline shell. Actual Windows runtime, production signing and physical printing remain release gates.                                                    |
| Cashier conveniences    | Scoped letter shortcuts, help/off switch and source staff quotes with asynchronous refresh. Ten shortcut unit cases, eight combined shortcut/cash browser cases, quote source/HTTP checks and quote/desktop browser checks pass. |

## Fixed remaining code checklist

- Finish the dormant offline/Shopify CSV order jobs: the validated parser,
  encrypted staging, GET-only recovery coordinator and published-history repository
  integration exist; the financial adapters and service/API/worker remain unfinished. See
  `backend/parity/legacy-order-imports.md`.
- Integrate membership provenance around the actual original staging and
  activation writers. Typed capture/restore and the fresh-reader compatibility
  overlay exist; no historical provenance is fabricated.
- Close the retained legacy payment-status reversal API and remaining source-job
  gaps identified by the source audit. Hidden or dormant behavior stays in scope.
- Integrate the dashboard and customer website handoff slices. Complete order-to-cart
  copying, global barcode assignment, secondary-country search and the remaining
  inventory/job/model-administration gaps listed in `backend/parity/source-surface-map.md`.
- Correct unrestricted historical reads in public order browsing: both current
  `ordersService` methods still use the primary reader. Keep current financial
  authorization/proof reads separate from historical order facts, which require BigQuery.
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
- Windows/macOS native release tests, signing, printer/device acceptance and
  representative performance measurements.
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
