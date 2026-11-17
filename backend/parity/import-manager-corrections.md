# Manager correction before historical CSV import

The user selected **pause tender/header mismatches for correction before import**.
The dual-value variance execution candidate in `csv-tender-decision.md` remains
unselected. This workflow never interprets the CSV as independent evidence of
cash collected, change, a refund or a provider payment.

## Active policy

An internal role1–3 manager may correct their own upload only, while currently
checked into its active store/counter with a valid original authenticated
session. Current native role, assignment, store, counter, account and session
checks run under writer locks. Ownership is retained deliberately: an offline
row with no email resolves the original operator's shadow customer. A different
manager must not silently substitute their own shadow. Cross-manager takeover
is outside this correction policy; the separate cash-return manager queue is
unaffected.

Review loads one bounded encrypted original group (at most999 ordered CSV rows),
not the entire upload. It shows product IDs losslessly, quantities, original
prices, business wall time/channel, original line declaration and the safe
qualified source bill. Customer email/name/address/message and private proofs
never enter the HTTP review. The original immutable upload digest, encrypted
group digest, plan/request/namespace, order-stage nonce, rejection proof and
customer/contact binding remain in the server descriptor.

The trusted financial-core `inspectRejectedBoundary` port is mandatory. It must
prove the original source command committed a signed, permanent no-effect
rejection with no order, later stage, hold or financial effect. A failed flag,
HTTP error, missing receipt or equal amounts is insufficient. The original row
must be `FAILED`, with no native order/receipt/projection. Uncertain, started,
order-created or completed rows remain recovery-only. Missing calculation facts
or an unqualified benefit profile keep the row paused.

The active version preserves prices, products, quantities, customer, historical
date, store/counter, payment channel and SMS/message instructions. The manager
separately enters and attests `historicalTenderAmount`, including explicit0.00
only when the qualified source bill is zero. It must match that bill. If the
historical sale record differs, the row remains paused. Nothing changes source
header/refunds, removes automatic benefits or invents change to obtain equality.

Actual pinned-source tests prove25.49×2 declares50.98 while its source bill is50;
with a permanent10% coupon100 produces90, but changing the price to90 produces81.
Copying both price and inferred tender cannot fix this discrepancy. Changed
prices require a separately qualified fresh retained source calculation. The
optional typed `inspectCorrectedPlan` seam is read-only under the native
transaction; the initial profile does not invoke it or advertise price editing.
There is no HTTP under correction SQL locks.

## Immutable successor and approval

One correction UUID atomically creates one linked one-row successor job and
operation, plus an HMACed immutable binding/receipt. A unique original-operation
key prevents two successors, including competing tabs/devices. Original rows,
amounts, counters and completed siblings are untouched. Bounded ancestry retains
the root upload and at most10 financial successor generations.

`LegacyOrderImportPlan.originalTenderAmount` stays the line-price declaration.
The independently attested tender is a separate strict `ImportCorrectionBinding`
included in the corrected plan/request/approval/source hashes by the financial
core. Every successor requires **historical-correction** approval, even on an
open current day. The approval UI displays both declaration and attested tender,
source payable and correction UUID, and fixes the reason to that purpose.

The sealed group contains an internal `manager_correction_id` marker. The
coordinator refuses it without a matching verified `correctionForOperation`
resolver, preventing an accidentally unconfigured worker from treating it as an
ordinary CSV row. The adapter start remains outside its SQL transaction.
Receipt `pending-approval` never means an imported order/payment is complete.

## Lost replies and definite correction-command fences

The browser saves opaque original correction/successor/evidence UUIDs and a
complete input hash **before POST**. It stores no CSV, contact, price or tender.
Lost/500/404 responses retain the original UUID and recover with GET only.
Changing actor or scope aborts continuations before a new fetch/storage write.

Creation and GET recovery share the native original-row and command-PK lock.
If an accepted correction exists, GET returns its immutable accepted receipt.
Otherwise GET can atomically retain a purpose-HMACed `not-created` command
fence; a delayed POST for that UUID must observe the fence and cannot create a
successor. A committed unresolved/malformed command stays uncertain. A fence
never erases an accepted correction or declares the **original source** command
effect-free.

The client may begin an explicit fresh review only after this exact scoped,
authenticated fence, and checks it again before retiring the saved reference.
The original IDs/audit remain in native command records. Bare404/HTTP status is
never that proof. Original source no-effect/profile/authority validation is
still required for a fresh successor. Accepted/fenced outcomes remain readable
with the retained key when new correction creation is disabled. A known receipt
is retained independently of a later successor-status fetch failure.

## Integration

- Pure contracts: `correction-contracts.ts`.
- Pure native binding verifier: `correction-evidence.ts`:
  `verifyImportCorrectionRow(row,secret)` returns the strict binding after
  receipt/native scope/HMAC/active-policy checks. Its proof is
  `financialImportHash(secret,'manager-correction-record',rowWithoutProofHash)`.
- Factory: `legacyOrderImportCorrections(db,config,{secret,contract?,boundary?,clock?})`.
  It exposes `review/create/read/readCommand/correctionForOperation`.
- Registrar: `registerLegacyOrderImportCorrections(app,config,db,options)` from
  `correction-routes.ts`. Options accept shared `service`, or `runtime` +trusted
  `boundary`. HTTP validates the current session before and after awaited work.
- Routes: GET/POST
  `/api/v1/admin/order-imports/:jobId/orders/:operationId/corrections`; GET
  `.../corrections/:correctionId` returns `accepted` or the exact `not-created`
  command outcome. No PII filters occur in URLs.
- Existing import-service/repository option `correctionForOperation` must receive
  the factory's resolver. Root financial-core hooks bind and reverify it before
  approval/start/source execution; no browser-supplied binding is accepted.
  `configuredLegacyOrderImports` now installs the same service/resolver for the
  server and standalone worker. The normal import registrar mounts correction
  resources, and both forward migrations are registered in order. Recovery
  remains available with the retained key when financial transport is disabled.
  Approval review exposes the independently attested tender and qualified source
  payable; correction approvals always require `historical-correction`.
- `readImportCorrectionOptions` reads the existing retained
  `LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1` and optional
  `LEGACY_ORDER_IMPORT_CORRECTION_CONTRACT=pos-import-manager-correction-v1`.
  Default/DEMO creation is disabled. Selecting a flag does not qualify a source
  producer or its calculation/effect receipts.
- Automatic rewrite-only migrations, in order: `correction-migration.sql`, then
  additive `correction-command-migration.sql`. The registered first migration
  checksum was not changed. No legacy ALTER/index change is needed.
- UI is integrated into the existing historical import page; no root App/nav
  edits are required. Global opaque-reference recovery survives row collapse
  and job changes. Only current operational command/control evidence is read on
  the writer for this mutation; this is not a historical report/MySQL fallback.

## Executed evidence and limits

From `backend` using Node24.22.3:

```sh
npx -y node@24.22.3 node_modules/typescript/bin/tsc -p tools/import-corrections/tsconfig.json --noEmit
LEGACY_ORDER_IMPORT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_legacy_order_imports_test npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/import-corrections --maxWorkers=1
compatibility/upstream/offline-cash-pricing/.venv/bin/python -B tools/import-corrections/source_oracle.py -v
```

The29 new native/API tests pass. They cover20-way same-UUID replay, competing
successors, original/sibling preservation, rollback, current authority,
qualified zero, missing proof/profile/refused price change, missing resolver,
tampering, late POST, in-flight creator versus fence, race outcomes and
post-commit401 recovery. The26 affected existing coordinator/runtime/resumption
native regressions and3 actual pinned calculator oracles pass.

The real Node financial-core composition also has a native MySQL workflow in
`tests/legacy-import-financial/correction-integration.mysql.test.ts`. It stages
a mismatched original, consumes a signed no-effect rejection, creates the
immutable successor, refuses execution without approval even on an open day,
settles the attested amount, replays without another financial source call and
retains its correction descriptor after contact changes and write disablement.
The source receipt and order transport in that test are trusted fixtures; it
does not certify the private Python correction/calculation producer or actual
Go/provider deployment. Those source integration steps remain code and release
work, not evidence inferred from this Node test.

From `frontend`:

```sh
npx -y node@24.22.3 node_modules/typescript/bin/tsc -p tests/import-corrections/tsconfig.json --noEmit
ORDER_IMPORT_BROWSER_TESTS=true npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/import-corrections/browser.test.ts tests/order-imports/approval-browser.test.ts --maxWorkers=1
```

All8 new actual-page Chromium workflows and13 existing approval workflows pass.
They cover review/independent tender/approval, lost commit, exact fence versus
bare404/500, blocked source profiles, zero, actor change during hashing, original
price protection and storage failure. Browser tests use isolated ephemeral
Vite/cache and controlled APIs, not a live financial provider.

The module native fixtures explicitly supply a typed synthetic financial-core
boundary: they certify current native manager/queue/command behavior, **not**
source HMAC verification or completed source financial execution. The separate
financial-core inspector, qualified source calculation producer, corrected
source capability/approval/finalization and common-generation historical
publication need their own integrated evidence before production activation.
Old source rejection receipts without safe calculation facts remain paused.
No production flag, live data/schema, source sibling, provider or deployment was
changed by this slice.
