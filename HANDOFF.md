# POS rewrite handoff — 18 November 2026

The user requested handoff to another agent. Implementation is **unfinished**;
do not deploy this branch or claim complete source parity. New work was stopped,
owned local test fixtures were cleaned, and unverified work was preserved on
separate branches. This document supersedes the current-execution paragraphs in
CHECKPOINT.md where they differ; older receipts remain historical evidence.

## Start here

- Repository: https://github.com/thesouledstore-tss/pos
- Draft PR: https://github.com/thesouledstore-tss/pos/pull/2
- Main worktree: `/Users/rishabhbhatia/code/pos-rewrite`
- Main branch: `feature/order-copy-history-integration`
- Implementation head before this handoff document: `e9c65583c896bbb0df7023699af15a3562cab1d8`.
- Original POS: `/Users/rishabhbhatia/code/backend-pos-web`, pinned
  `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.
- Main branch is the integration baseline. Cherry-pick the individual WIP
  commits below after review; do not blindly merge their old branch ancestry.
- Read this document, CHECKPOINT.md, backend/parity/source-surface-map.md,
  backend/parity/coverage-ledger.json if present, and the relevant scoped parity
  documents. Mapping a source surface is not proof that its behavior is complete.

The user's required work order is **finish all implementation first, then run
full parity/testing**. Necessary focused checks may verify a real fix, but do not
keep rerunning broad suites while known code gaps remain. Earlier updates were
too broad; report concrete merged commits and actual remaining requirements.

## Required outcome and retained decisions

Separate TypeScript backend/frontend under this repository; Node24 LTS, React
with Electron for web and Windows/macOS desktop, ORM queries, proper state,
offline-first support, Google OIDC authorization-code/PKCE, strict input
validation and no TypeScript `any`. Improve measured performance, preserve every
reachable source feature, use readable/reusable code and meaningful endpoint names.

Interactive reads use PRIMARY, current daily reports use DATA, and older facts
use qualified BigQuery publications. Current writer authority reads are distinct
from historical financial facts. Never fall back to MySQL for missing historical
facts or manufacture complete warehouse publications.

Logs must exclude customer PII, secrets, tokens, payloads and sensitive SQL
values. Retain module/resource/event ID, request ID, user ID and event-instance
traceability. This is desktop, not a mobile app. The earlier localhost4273
preview was explicitly closed; do not reopen it without a new request.

Approved business decisions already implemented or recorded:

- Offline cash sales complete with receipts from cached stock; reconcile
  conflicts to a manager after reconnecting.
- Correct duplicate-SKU per-line refunds, preserve cashback on Money changes,
  and fix approved Points ledger bindings.
- Preserve exact voucher paise and original earning expiry on cancellation.
- Archive stores/operators and revoke access while retaining financial IDs.
- Pause inconsistent CSV tenders for manager correction.
- Use calendar-date ordering for payment-failure restoration, but retain the
  source's extra Points history entry when restoring Money, as explicitly requested.

## Integrated work most relevant to resuming

| Main commit | Change |
| --- | --- |
| `426b597` | Authorized N/HL/HE detail reads; current product/customer dimensions remain separate from immutable financial facts. |
| `1947373`, `b519cf1`, `4a83b66` | Reloadable operator/store/counter/order/line return links and guarded super-admin override. |
| `57225d9`, `7ec52eb` | Genuine paid N full/SDD invoices, explicit global access, native financial/issuer/history proof and detail callsite. |
| `9a89415`, `3ed2a9c`, `5cd4fc9` | Actual-App configured default store operators, exact contact tokens, source blank Slack creation default. |
| `23c3c52` | Exact barcode endpoint including alternate GTINs and wide IDs; current authority/session checks. |
| `c0675f6` | Stale-scan protection, scoped durable offline aliases via additive IndexedDB v10, safe product/troubleshoot links. |
| `bcc19d2` | Buffered direct quantity editing, preserving blank edits and explicit zero/removal. |
| `3d06ef0`, `0129219` | Eligibility, recovery discovery/claim/adoption, original counter preservation and complete duplicate-SKU restoration conservation proofs. |
| `e9c6558` | Backend read-only quoteDisplay projection and configurable cashback credit message; frontend completion is WIP. |
| `1ae7710`, `4bd392e` | Full-verifier registration for actual native online detail/browser and counter barcode source/browser targets. |

Other existing modules include checkout/payment/refund/financial recovery,
inventory/administration, reporting, imports, coupons/vouchers/benefits,
fulfillment, notifications, offline cash and desktop packaging. Their presence
does not establish all-feature acceptance; follow the source inventory and evidence.

## Immediate unfinished implementation

### 1. Checkout quote summary and complementary-product removal

Preserved **unverified** commit `ad6f1a1` on `fix/counter-scan-bindings`.
Worktree: `/Users/rishabhbhatia/code/pos-rewrite-counter-scan`.

It adds CartQuoteSummary, CheckoutCartLines, typed quote-summary parsing, a
CheckoutReview mount and complementary Remove using existing PUT
`line-items/:productId` with quantity0. Backend changeLine already dispatches
deleteCartPayload for quantity0, including complementary-only SKUs; it does not
substitute setproduct. Draft synchronization and quote invalidation must remain.

WIP has not been compiled, linted or browser/native tested. Its browser entry is
only a fixture; a browser test runner is not authored. Verify the mount/client
schemas, source display gates, removal/recovery behavior and stale quote state.

Source anchors: create_order.html450–547 calculations and Cart Details;
complementary controls165–174 and rebuilt1601; remove handler2583.
Cashback is gated by discount_eligibility, not an invented show_app_cashback flag.
Use fresh version/customer-matched existing customer-benefits app.discountEligible.

Backend `state.quoteDisplay` is optional and contains:

```
nonCouponDiscount: string | null
totalBeforeRounding: string | null
cashbackCreditMessage: string
```

It derives only total_savings−coupon_discount and total+rounding_off using exact
decimal source values; it never changes official payable/quote/payment state.
Missing/malformed inputs return null, never a made-up zero. Raw quote metadata
already reaches the frontend through publicCart. Config CASHBACK_CREDIT_MESSAGE
defaults to the pinned source text and preserves explicit empty text. Nine
projection checks, changed lint and backend strict pass. The first config test
needed isolated demo config; the first strict attempt needed Decimal's named
import. Both were corrected; no full regression ran afterward.

### 2. Lost recovery-claim response and renewed customer proof

Preserved **unverified** `50e2129` on `fix/source-online-order-details`.
Worktree: `/tmp/pos-online-order-detail-fix-20261118`.

Known bug in integrated3d06: pending claim originally retained no original
proof/counter; the Check original action replayed POST and could clear an unknown
outcome on409 after proof renewal. WIP adds an immutable claim receipt table and
read-only exact-claim GET, current actor/check-in/fresh customer-proof checks,
atomic receipt insertion, original pending fields and an explicit renewal path.
It retains receipts after later authority handoffs. Receipt fields are only
identifiers/hashes/result UUID, not provider/customer payloads.

New migration: return-workflow/recovery-claims-migration.sql, registered after
0004_returns in backend/src/db/migrations.ts. **Do not deploy/apply it live.**
Only already-running backend/frontend typechecks passed on WIP. Next checks:

- Add migration to focused checkout native fixture setup.
- Update changed-body expectation to IDEMPOTENCY_CONFLICT.
- Test recorded/not-recorded, original-proof expiry→fresh-proof lookup,
  revoked actor denial, later handoff receipt retention and read-only UI recovery.
- Then focused lint/build/native/UI checks; do not claim this WIP complete.

Also **not implemented**: source `_return_exchange_cells.html` suppresses NEW
exchange for current Product.prod_type8, while failed-exchange recovery precedes
that branch and stays allowed. Add the narrow new-selection/eligibility guard and
reason while preserving retry/adoption. Do not apply a blanket type8 recovery ban.

Verified group delivery0129219 already supports complete exchange-only duplicate
SKU restoration groups with separate saleable/held conservation, immutable
certificate/recheck and explicit requalification when a legitimate group expands.
Incomplete/mixed/unassigned/surplus facts still refuse safely; do not invent
restoration or replay an old return. Native stock/provider handover acceptance
remains external, not implied by the fixture.

### 3. Administration four-route source/App proof

Preserved **WIP proof** `5a0da2e` on
`proof/administration-forms-current-20261118`.
Worktree: `/tmp/pos-administration-forms-workflow-20261118`.

Nine files under backend/tools/administration/forms-workflow and corresponding
frontend/tests. See its README for the owned fixture command. Full24-case target
was interrupted for this requested handoff after11 completed operator cases;
**not a full pass**. Its owned runner performed normal exact cleanup. No final
r4 success receipt exists. Artifacts: `/tmp/pos-forms-workflow-evidence-20261118`.

- r1/r2 failed and remain retained.
- Source create persists blank stores.slack_group_url as empty string; candidate
  inserted NULL. Narrow create-only fix5cd4fc9 is integrated.
- r3 diagnostic exactly repeated the first store case:1/1 source Django→actual
  built routed App/native cookie→physical-table equality passed.
- Ordinary baseline stores now use source-created empty Slack strings. An
  additional explicit NULL-edit exception retains the rewrite's existing secure
  blank-update preservation and verifies both representations show disconnected.
  Do not normalize ordinary comparisons or relabel the exception as source equality.
- Full source classes/forms/decorators/child templates execute, but unrelated
  base chrome is explicitly substituted. This is not whole-layout admission.
- Runner currently documents a Python3.12.15 environment; source deployment is
  CPython3.10. Qualify runtime-sensitive comparisons before broader claims.

### 4. Joined historical order/source/SDK proof and final coverage review

Preserved **unexecuted authoring** `c8bd5a4` on `proof/order-discovery-native-ui`.
Worktree: `/tmp/pos-order-discovery-native-ui-20261118`.

Official BigQuery SDK fixture transport/private proxy with bounded synthetic
literal SELECT publications was planned, not executed or accepted. Do not claim
real warehouse acceptance from contract-port tests. New rich detail requires
its own complete online-detail publication; old search/public-order v1 facts
are insufficient. No live dataset DDL or old-fact MySQL fallback is permitted.

Checkout's complete reachable-control inventory was still being closed when
the user requested handoff. Useful local scratch inventories:
`/tmp/pos-checkout-action-source-controls.txt`,
`/tmp/pos-checkout-action-source-bindings.txt`,
`/tmp/pos-checkout-rewrite-bindings.txt`.
The source map/CHECKPOINT current gap wording predates the last few commits;
reconcile it once the real missing controls are finished. Do not declare zero
missing features solely because all routes have module mappings.

## Actual validation state

Last full verifier r9 is **FAILED**, frozen at
`caba871773b55009d4fe21b20305cd2653824d5d`:

-163 expected checks;162 executed;157 passed;5 failed;1 generic browser check not run.
- Backend inside that run:2722 passed,90 skipped,1 failed.
- Raw report: backend/evidence/verification-caba871-r9.json, SHA256
  `3ff9a11ceaae72fd51e84937fb1b4b8cdcb7e2b9aa8ab293bcd2537991c676fd`.
- Canonical verification.json retains that failed report. Never overwrite or
  relabel it as testing newer code.
- Five failures have passing scoped corrections: deployment-Python oracle,
  reminder/release-note navigation clocks, and stale order-history/payment
  default-metadata fixtures. A fresh full run still has not proved them together.
- Frozen checkout `/Users/rishabhbhatia/code/pos-rewrite-validation-20261118-r9`
  and private run `/tmp/pos-rewrite-validation-20261118-r9` remain preserved.
  Full runner is terminal; its exact container and volume are absent. Do not restart it.

Windows and macOS CI44344235142 passed exact historical4f30e87, including unsigned
packaging/recovery. See backend/evidence/desktop-ci-4f30e87.json. Later features
are not covered by it. Hosted CI triggered by newer pushes may still be running;
inspect GitHub rather than inferring a result. Signing/physical printing remain unaccepted.

All396 inventoried source declarations currently await final admission; all12
release requirements remain unaccepted. Existing scoped tests/receipts are useful
evidence with explicit seams, not complete production certification.

## Safe continuation and external dependencies

Use Semble first for code discovery, then read returned files. Preserve source
pins, failures, deadlines, assertions, and exact tested input hashes. Never
rehash an old receipt to pretend it executed new code.

An owned mitigated dependency checkout is available at
`/Users/rishabhbhatia/code/pos-rewrite-validation-20261118-corrections`.
It contains copies used for the last quote projection; compare its dirty files
to committed main before clearing anything. Do not reset another worktree blindly.
Original/shared node_modules and Python environments were intentionally untouched.
Both packages have a reviewed local picomatch mitigation tarball; it is not an
official patched release or a claim of zero dev advisories. Production dependency
audit was previously clean, but security acceptance is not complete.

Known Node24 executable on this machine:
`/Users/rishabhbhatia/.npm/_npx/c9870267d9e0f935/node_modules/node/bin/node`.
Source order oracles now use cached offline CPython3.10/Django4.2.5/PyMySQL1.1.1
via backend/tools/order-search/run-oracle.sh. Operational oracles use an owned
CPython3.10 workbook environment or POS_OPERATIONAL_SOURCE_PYTHON. Do not use
ambient Python3.14 float-sum behavior as the deployed source oracle.

After implementation is complete, freeze a new owned checkout and run the
registered full verifier with Node24:

```
cd backend
npm run verify:project -- --mysql --browser --release
```

This requires an explicitly owned loopback MySQL fixture via POS_VERIFY_MYSQL_URL,
copied private Python/Go oracle dependencies and pinned source roots. Reuse the
documented r9 owned runner setup as a template, not its frozen checkout/process.
The verifier sanitizes environment and must never inherit live credentials.
Other-origin source/cache prerequisites are documented in
backend/tools/other-origin-verification/README.md and CHECKPOINT.md. Do not skip
registered phases to obtain a green headline.

External acceptance still includes Google client/callback/tenant configuration,
complete curated BigQuery/CDC publications, actual financial providers/SDD
renderer, current shared stock writer/procedure contract, background workers,
representative performance/security review, physical offline reconciliation and
printing, signed Windows/macOS installers/upgrades and deployment/rollback.

Google issuer is accounts.google.com; reference repo service is
tss-fullstack-admin/apps/web/app/services/auth/oauth_service.ts. BigQuery reader
key remains local at `/Users/rishabhbhatia/Downloads/reports-bigquery-reader.json`;
project tssgcp2025, raw dataset tss_mysql_raw_layer, location asia-south1. Access is
strictly read-only data plus bounded query jobs. Never print/copy the key or
credentials. Supplied live MySQL access was read-only; current pos_stock_syncer
was absent on inspected reader/writer. Old backup self-commits and is not an
accepted atomic writer contract. Do not make live calls/writes or invent it.

The OpenObserve inspection request was explicitly cancelled. Do not resume it.
AWS access was authorized for relevant inspection, not arbitrary deployment.
Do not send messages, charge providers, deploy, merge the draft PR, run live
financial writes or apply production DDL as part of this handoff.
