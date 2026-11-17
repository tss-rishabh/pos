# Historical CSV import approval UI

The actual results table lazily opens a financial review for each pending order.
It reads the server-derived original business date, payment value, currency,
product IDs, quantities and original unit prices. Staff must select one of the
three reasons and explicitly confirm that review before granting approval.

The only approval mutation body is `{commandId, reason}`. Job/order scope,
original actor, store/counter, amounts, plan and current authority stay on the
server. Approval grant IDs are distinct from request command IDs. The original
one-hour expiry and current server `stale` status remain visible; GET never grants
or renews approval. This UI does not start an order, provider, settlement or resume
operation when refreshing an approval.

`pos-order-import-approval:[owner,job,order-operation]` contains only version,
owner ID, job ID, order-operation UUID, command UUID and the reason enum. It is
saved and read back before POST. Existing upload and resume journal keys and
payloads are unchanged. Browser locks serialize competing row references and
receipt retirement; storage failures/corruption or missing coordination prevent
approval dispatch. No CSV, customer fields, prices, amounts or product lines are
persisted by the approval UI.

Reload/reconnect prefers GET for the saved exact command. An absent receipt
permits only an explicit same-command/same-reason retry after another review; a
newer latest grant cannot retire the unresolved command. Saved references remain
recoverable outside the current result page when a terminal file reference is
retired. Full owner/role/type/assigned-store identity remounts local work, and
component lifetime aborts protect both requests and waiting browser locks from
late old-scope responses. Existing file/hash continuations also stop after scope
replacement.

Focused checks use synthetic API fixtures and actual Chromium on temporary
loopback ports with temporary Vite caches. They do not need sibling source
repositories or activate the disabled production source contracts.

Run using the installed Node 24 runtime:

```sh
node node_modules/typescript/bin/tsc --noEmit -p tests/order-imports/tsconfig.json
node node_modules/eslint/bin/eslint.js src/pages/administration/order-imports tests/order-imports
ORDER_IMPORT_BROWSER_TESTS=true node node_modules/vitest/vitest.mjs run --config tests/order-imports/vitest.config.ts
```

The 37 checks comprise 14 journal/transport unit cases and 23 real Chromium cases
(10 existing CSV/resume flows, including the assignment/digest boundary, plus 13
approval flows). Approval cases cover explicit source-field review, lost reply,
absent receipt/same UUID, newer-latest isolation, expiry/stale and denied
authority, storage failure/corruption, multiple rows, changed actor/assignments,
an abort during queued marker retirement, and StrictMode recovery. An API fixture
rejects every unrelated financial/order action and verifies metadata was already
durable when the approval POST arrives. Production provider/source acceptance
and financial import qualification remain separate requirements.
