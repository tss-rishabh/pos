# Report and close-entry control restoration

Source: POS `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`, active `report/urls.py:69–81`. This change restores specific executable controls; it does not certify the entire report/finance family.

Fresh day-close entries require seven explicit amounts, including explicit zeroes. Saved revisions retain their values. Submitting opens a native modal with business date, Cash/Total Online/Banking System–Actual–Result and Cancel; valid closed revisions explain that the original version is retained. Only confirmation submits the frozen entries/date/version. Existing UUID/digest command persistence, unknown-result GET recovery, server recomputation and native check-in/store/role guards remain in place. No comments or amounts are added to browser persistence. The page restores online payment components and stale signing time/attempt/cause/order reference as escaped React text.

Daily filters subtract five days, retain the source one-minute end rollover, restrict local options to active physical STORE rows using the existing finance options endpoint, retain franchise assignment scope, and offer Select All/Clear All. Shared catalog behavior is unchanged. Cash-ledger controls visibly initialize to the source business-month start/today.

The source rollover is real: five pinned GET/helper executions feed the shipped jQuery/Moment/date-range-picker and active template AJAX configuration. At23:58:59 on Nov18 the range is Nov13–18; at23:59:00 all three (input, initialized picker and outgoing configuration) use Nov13–19. Two source close-page executions additionally verify blank manual declarations, blocked incomplete submission, System/Actual/Result review, Cancel and explicit confirmation. Source GET metadata/render/clock are fixture seams; the page's AJAX and DataTable transports are captured. Source decorators/deployed HTTP are outside this proof. Seven source-file/library hashes and five retained outputs are in `source-defaults.json`; the live source runner checks them before execution.

The midnight default does not relax financial publication requirements. The whole mixed historical/current/future range still requires complete same-generation warehouse manifests and matching source position, including tomorrow. Missing qualification remains an explicit refusal; no future zero row or DATA supplement is fabricated. This frontend change adds no backend date-policy exception.

Focused verification on Node24.22.3:

- Production frontend strict, focused test strict, changed ESLint and production Vite build pass.
- Five unit checks pass across `source-controls.test.ts` and existing `commands.test.ts`; the latter retains unchanged unknown-result UUID/digest and changed-payload assertions.
- `source-widget.mjs`: five pinned real-widget/date-request cases and two active source close-page flows pass.
- `review-browser.mjs`: actual production finance/report pages pass explicit declarations, Cancel/Escape/draft retention, first close, existing-financial-modal priority, revision warning/version, stale cause/reference, online breakdown, one-POST lost-reply GET recovery and date/bulk-selection controls. A bounded same-origin HTTP fixture supplies synthetic state; this is not native authenticated App parity.
- Existing unchanged backend `tests/finance/mysql.integration.test.ts`:10 passed on an owned nonce-labelled pinned disposable MySQL, preserving native concurrent command deduplication, actual collection SQL, stale/version/role guards, ledger/history checks. This is separate native-service regression evidence, not a claim that the controlled browser completed a real native financial write.

The first native setup stopped before any case: readiness saw MySQL's temporary initialization server through its Unix socket. The private runner was corrected to wait for TCP; the test and assertions were unchanged. Both attempts' exact owned container and anonymous volume were independently absent after cleanup. Private logs retained in `/tmp/pos-report-finance-controls-native-before-tcp-readiness.log` and `/tmp/pos-report-finance-controls-native.log`.

Run from `frontend` with owned mitigated dependencies:

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tests/finance/controls-tsconfig.json
node node_modules/vitest/vitest.mjs run tests/finance/source-controls.test.ts tests/finance/commands.test.ts --maxWorkers=1
POS_PARITY_SOURCE_ROOT=/absolute/pinned/backend-pos-web node tests/finance/source-widget.mjs
node tests/finance/review-browser.mjs
node node_modules/vite/bin/vite.js build
```

Source execution needs Python3 and Playwright Chromium (optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE`). Source files are read only; no live database, provider or credentials are used. The UI runner closes its browser and random-port Vite server in `finally`. Native regression uses `MYSQL_INTEGRATION_URL` pointing strictly to a disposable loopback fixture; the test creates/drops its own random schema. No release ledger or historical receipt is promoted.
