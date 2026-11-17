# POS rewrite checkpoint

The application is an implemented review build, not a certified production release.
`backend/evidence/verification.json` records the most recent combined run, its
individual check outcomes, exact source checksums and any inputs changed during
execution. Inspect its exit status and `changedInputs` before treating that run
as a verified snapshot. Focused feature checks are listed below. Generated Vite
caches are excluded from source checksums; a direct filesystem check verifies
that regenerated cache files are ignored while actual source edits are detected.
`backend/parity/release-coverage.json` remains the release authority;
component test counts do not certify every original workflow.

## Implemented feature groups

| Group                    | Current implementation and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and access      | Password/OTP/TOTP, Google OIDC/PKCE, desktop browser handoff, current role/store authorization, archive/revocation and private media. Actual OAuth tenant acceptance remains required.                                                                                                                                                                                                                                                                                |
| Selling                  | Catalog, customer/cart/quote, discounts, gift cards, consent, checkout, payment recovery, returns, exchanges and pending cancellations. Reviewed upstream financial contracts remain required before live enablement.                                                                                                                                                                                                                                                 |
| Offline cash             | Cached stock, immutable completed cash receipts, print/reprint, reconnect import and manager stock conflicts. Physical devices/printers and shared-writer acceptance remain required.                                                                                                                                                                                                                                                                                 |
| Benefits                 | Money/Points adjustments, exact-paise vouchers/conversion and approved cancellation expiry restoration, with native concurrency/rollback checks. Unproved legacy funding and membership provenance remain gated.                                                                                                                                                                                                                                                      |
| Administration           | Store/operator/counter administration, reversible archives, stock imports, approvals, gift-card batches, access controls and history. See the administration feature map.                                                                                                                                                                                                                                                                                             |
| Reports and fulfillment  | Daily/historical reader separation, financial/reporting screens, fulfillment, scoped invoice variants and queued CSV/XLSX exports. Warehouse publication and real provider acceptance remain required.                                                                                                                                                                                                                                                                |
| Web and desktop          | React web build, Electron Windows/macOS targets, renderer isolation and offline shell. Both native CI jobs passed unsigned packaging, integrity, sandbox, restart and offline smoke at commit `cd589c5` (run `44032882645`); later CSV integrations need another native run. Signing and physical printing remain release gates.                                                                                                                                      |
| Cashier conveniences     | Scoped letter shortcuts, help/off switch and source staff quotes with asynchronous refresh. Ten shortcut unit cases, eight combined shortcut/cash browser cases, quote source/HTTP checks and quote/desktop browser checks pass.                                                                                                                                                                                                                                      |
| Dashboard and website    | Dashboard reader separation and the one-use, verified-customer website handoff are integrated. Source/native/browser checks pass; warehouse publication and actual website receiver acceptance remain required.                                                                                                                                                                                                                                                       |
| Barcode and country      | Atomic barcode assignment/audit/recovery, secondary-country search and the franchise store-picker fix are integrated. Twenty-four backend and twelve frontend checks pass, including native races and browser recovery.                                                                                                                                                                                                                                               |
| Invoice worksheet        | Manual prices, customer labels, exact totals, source-format CSV export and sandboxed printing. Fourteen focused checks and two Chromium workflows pass. This worksheet records no payment.                                                                                                                                                                                                                                                                            |
| Parent/store CSV         | Three-column product-family assignment import, atomic reset/delete/recreate, audit, shared durable worker and separate historical profile are wired. Twenty-nine merged database/source/parser checks and seven import browser workflows pass. Actual stock/sync/publication acceptance remains required.                                                                                                                                                             |
| Historical order reads   | Public date selections reach PRIMARY/DATA/BigQuery readers, with scoped cursors and post-read session revocation checks. Full source filters/sorting/queues/formatter are integrated: 43 pinned-Django vectors, 12 browser workflows and existing qualified detail/copy readers. Warehouse generations and workload acceptance remain required.                                                                                                                       |
| Order copying            | Actual Counter/Review integration preserves the original draft, separates copy recovery IDs and fences offline cash until a proved online terminal outcome. Native OTP/contact/session fences, serialized unsent cancellation and dedicated validated terminal clear are integrated. Fifty-three affected backend and 21 scoped frontend checks pass, including five actual Counter/Review Chromium flows and lost-clear recovery without another POST.               |
| Cash payment corrections | Durable prepare/arm/attest/record commands, cross-manager pending-return recovery and retained device claims are integrated. Native corrections compose with current collections, ledger, DSR and sealed historical deltas. The actual Orders page preserves confirmed receipts after a failed refresh and shows one scoped manager queue. Focused native/source/browser checks pass; production contracts stay unselected.                                           |
| Ecommerce inventory sync | Source threshold selection, writer-current system projection/checkpoints, authenticated complete catalog bridge and the actual settings recovery UI are wired into the existing queue/worker. Twenty-four merged backend checks (including 16 bridge subcases) and eight frontend checks pass, with strict checks. Actual stock/writer/catalog coordination and provider deployment acceptance remain required.                                                       |
| Whole-order fulfillment  | Dedicated PACK/SHIP/DELIVER commands, full immutable order-line scope, source-pinned STORE worker, public resources and deferred Orders recovery UI are integrated. Atomic rejected-return obligations, bounded dispatch, manager recovery and shared public/private financial handover guards are integrated. The standalone private receiver has its own command, bind settings and container target. Production ingress/vendor/writer acceptance remains required. |

## Remaining code and integration

Recent focused checks cover CSV coordination, financial approval/settlement,
whole-order recovery, private source/Go boundaries, API and trace isolation. The
approval/import UI passed 37 checks, including 23 Chromium workflows; the actual
Orders page passed 16 Chromium cases. These are bounded feature results. A fresh
consolidated run is still required for the latest composition, and no production
provider or complete original workflow is certified by these counts.

The combined local run on `56f2543` passed all 1,616 backend tests, 241 frontend
unit tests and every executed recovery-browser suite. Two readonly assignments
in a CSV test fixture failed its compiler check, so the verifier correctly skipped
the main browser suite and retained a failed overall result. The corrected
fixture compiler check and all 50 main Playwright cases then passed; the exact
follow-up scope is `backend/evidence/integration-followup-56f2543.json`.
Subsequent code requires another consolidated run. Native source/candidate tests
now also cover 41 CSV tender scenarios and 13 review cases, plus four Python
checks over 20 frozen source vectors. The user selected pausing tender/header
mismatches for manager correction before import. The correction API/UI and native
financial binding/approval/settlement composition are implemented. The private
source calculation-rejection producer and selected correction execution now pass
the pinned calculator/PosOrder → original Go confirmation → Node settlement
native workflow. Financial production flags remain unselected; complete private
startup, cooperating writers and provider acceptance remain required.

The connected manager-correction slice passes all77 scoped financial-core,
native coordinator/API and runtime checks, strict TypeScript and lint. All21
actual-page correction/approval Chromium workflows pass in the merged tree.
The native workflow now includes the new correction compiler/browser checks.
These focused results do not replace the pending consolidated parity run or
the complete private runtime and production source qualification. The newer
source-correction slice passes84 scoped checks, with its separate original-Go
bridge case passing as well; see `backend/parity/import-correction-source.md`.

The integrated private fulfillment runtime passes 50 focused checks, including
six native shared-guard cases, strict compilation and lint. The backend and
private receiver container target build; its default command passes a
network-disabled container smoke check. These do not certify real ingress or
provider acceptance.

Native CI on `cd589c5` passed both Windows and macOS, including unsigned
packaging, packaged integrity, restart, sandbox and offline smoke checks
(run `44032882645`). `backend/evidence/desktop-ci-cd589c5.json` records the exact
commit and job/step outcomes. Earlier failed runs remain retained as evidence.
Native CI bounds fixture concurrency to two unit workers and one recovery-browser
worker; assertions and timeouts were unchanged. Later CSV/profile integrations
still require their own consolidated and native runs. Signing and physical
printer acceptance remain outstanding.

The native run on `77151ca` passed macOS and failed the Windows sign-in flow.
Its retained trace showed the initial challenge-restoration reply clearing a
new OTP; three deterministic Chromium cases cover the fix. The next run on
`3f5a269` passed the native Electron/offline step on both systems, then failed
later browser recovery steps. The failed outcomes remain retained separately.
Windows exposed two first-workflow 5-second deadline failures; cold Vite setup
now finishes in fixture startup, with all 14 affected cases passing locally.
macOS exposed a correction fixture checking its receipt before commit; the
controlled-race fix passes all 8 cases. No deadlines or retries were increased.
Another native run is required. See `backend/parity/native-browser-readiness.md`.

Membership completion snapshots and actual application/worker recovery are now
integrated. On `6ec6824`, 125 membership, runtime, repository and resumptions
checks passed, including disposable MySQL workflows. Another 99 historical
membership reader/publication checks passed with native publication fixtures.
The backend and membership fixture compiler checks passed. These are focused
integration results, not a new consolidated project result. Recovery retains a
verified completed order after lost acknowledgment without another source,
payment, stock or publication dispatch, even when new-work configuration is
disabled. See `backend/parity/import-app-recovery.md` and
`backend/parity/csv-membership-core.md`.

The actual private transport now binds the prepared membership history document
to its order capability. Source admission verifies/copies it before SQL, then
the literal eligibility code uses memory only and retains its original execution
second. Source short circuits still run without history. The latest affected
regression passed 266 checks; its separately compiled original-Go case passed
as well. Protocol/startup/tender checks and strict compilation passed. Async
preparation selection, durable no-dispatch closure/resume and complete warehouse
freshness remain code/integration work. See `backend/parity/csv-membership-handoff.md`.

Automatic coupon and POS complementary profile candidates are merged, with
71 focused checks passing on a disposable MySQL fixture. Original eligibility,
per-HP refunds, exact counter/log/grant evidence and exhaustive line ownership
are covered. Their source/core composition, original-Go consumption emitter,
qualified coupon warehouse history and cooperating-writer cutover remain code
work. Review-only legacy enum changes are not applied automatically.

The project verifier includes membership, benefit and check-in fixture compiler
checks, the isolated native publication database input, the dedicated benefit
native runner and the manager correction compiler/browser suite. These focused
results do not replace the pending consolidated project and full parity runs.

- Finish the dormant offline/Shopify CSV order jobs: the validated parser,
  encrypted staging, native authorization/preflight, job API, recovery UI,
  worker loop, explicit blocked-job resume and published-history repository are
  integrated, including original-nonce resume recovery without reimporting completed orders.
  The real financial adapter, purpose-bound approval API and standalone processor
  are now wired, with production contracts unselected. Ordinary payment,
  cancellation, return, exchange and finalization guards are integrated; original
  provider evidence survives a newly encountered hold. Financial approval UI,
  public handover composition and the executable pinned private Python receiver
  and Go confirmation overlay are integrated. Full source-runtime, durable broker
  and cooperating-writer qualification remain unaccepted.
  Source-qualified membership staging and screening admission candidates are
  merged, with native rollback, replay and contention checks. Manager correction
  APIs, recovery fences and UI are also merged; the original signed rejection,
  native correction, approval and settlement composition passes scoped checks.
  Membership history handoff/freshness, all-writer screening coordination and
  remaining benefit/complementary profile composition still require implementation
  and consolidated qualification. Historical publication producer and immutable
  membership completion/recovery candidates are integrated. Tender/header mismatches stay paused before
  import; the user selected explicit manager correction rather than recording a
  financial variance. See
  `backend/parity/legacy-order-imports.md`.
- Membership provenance producers are integrated as source-pinned compatibility
  candidates. Actual Python staging → Go activation → Node cancellation passes
  native concurrency/rollback checks. Their deployment remains external; no
  historical provenance is fabricated.
- Qualify the integrated durable cash-return preparation/attestation, manager
  queue and financial guards as part of the consolidated workflow run. Current
  collection/ledger/DSR and sealed historical correction deltas are integrated;
  actual publisher/source-barrier acceptance remains external.
- Qualify the source order-search historical publication/contact-key generation
  and representative queue workload; the complete UI/API/source-filter code is integrated.
- Qualify the integrated standalone private whole-order receiver, container
  target and shared financial handover fences. The dedicated API/UI, source-pinned STORE chain,
  atomic rejected-return obligations, bounded dispatcher and scoped manager
  recovery are integrated. Ecommerce stock/catalog
  synchronization, parent/store CSV and source-default account creation are
  integrated with their operational acceptance still required. The BD upload templates are explicitly retained as an
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
