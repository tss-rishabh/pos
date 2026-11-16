# Global TSS Money and Points adjustments

The user explicitly approved the corrected wallet semantics in `compatibility/upstream/global-benefits/decision.md`: TSS Money updates its own balance/history and preserves cashback, while Points uses the intended order/product/platform/reason fields. The original behavior remains independently executable as source evidence. This is an approved divergence, not a claim that the original strict-mode SQL succeeded.

## Implemented resources

| Resource | Behavior |
| --- | --- |
| `GET /api/v1/wallet-adjustment-capabilities` | Fresh internal-administrator access and explicit activation state |
| `POST /api/v1/benefit-customer-lookups` | Strict `{email}` body, unique active/unblocked customer; routine data from the primary reader |
| `POST /api/v1/wallet-adjustments` | Strict operation/customer/adjustment command; atomic idempotent writer |
| `GET /api/v1/wallet-adjustments/:operationId` | Original operator's writer-verified immutable receipt |

Every route has a static checkout module/resource/action trace. Email appears only in the lookup body, never a URL, command record or application log. The recorded command contains validated customer/order/product/operator IDs, amount, source enum/reason choice and date. Legacy activity uses opaque customer ID and structured text, preserving source platform names without storing names/emails in new audit entries. Original request ID is retained with the operation.

Authorization rereads active PosUser role/user type under shared lock. Only current internal roles1–3 qualify; cached roles and franchise role1 cannot grant access. Mutations recheck the current customer status/block flag under update lock, and optional order references must belong to that customer. Product references must exist. Duplicate email identities never silently choose the first customer.

## Atomicity and arithmetic

Migration `src/modules/checkout/migrations/0014_wallet_adjustments.sql` contains rewrite-owned operation and consumption audits; it does not alter legacy tables. A transaction binds the global operation UUID to operator/customer/body hash and execution claim. It locks the customer and source earning histories, plans the coherent original Python FLOAT64/cent/FIFO arithmetic, writes the appropriate native DOUBLE ledger and native FLOAT balance, applies consumption batches of200, and records both source-compatible activity and immutable operation evidence. Cashback is preserved. Optional reference rows lock before the customer to retain the ordinary order→wallet lock order.

Same-operation retries return the original verified receipt, without another credit/debit/history/audit. Different operations serialize on the customer row and cannot overdraw. A pending preexisting command with no receipt fails closed. A late ledger/audit/storage failure rolls all financial writes back. Reads/replays verify the original immutable history bindings and bounded consumption audit using locking current reads; later legitimate balance/earning consumption changes do not erase the earlier receipt. Missing ledger evidence never authorizes another credit.

Inputs use source reason/platform choices, positive two-decimal amounts up to the source UI's ₹99,999 maximum, signed BIGINT-safe ID strings and validated date-only expiry. Credits require explicit expiry; unset debit expiry is SQL NULL. A new earning expiry cannot precede the business date. Source expiry midnight is preserved without inventing a validity period. Non-cent/corrupt balances, unsafe FLOAT storage, incomplete earning allocation, duplicate/corrupt earning rows or more than10,000 candidate histories require review before mutation. Tied creation timestamps use exact ascending history ID for deterministic FIFO. Source `DONATION_POINTS` is visibly unavailable because it is absent from the real enum; no alias is guessed.

## Browser recovery

`GlobalBenefitAdjustmentsPage` reviews the selected customer and frozen fields before submission. Dexie V6 adds `walletCommands` and `walletCommandOwners`, preserving V1–V5 cash/cart/payment/clear data. An atomic per-operator pointer captures one immutable command across tabs, then a separate fenced claim is committed before the first POST. Protected asynchronous hashing happens outside the IDB transaction, followed by owner/session/role/type/full assignment/expiry/logout checks inside it.

A lost response retains the same command, UUID and body. Reload/background recovery performs GET only. An explicit retry first checks status, then resends the exact saved command; a404 does not create a new identity or prove failure. A confirmed receipt is retained after starting a new command, and old callbacks cannot clear or replace a newer active pointer. Logout/operator changes stop publication and preserve financial evidence. This global wallet workflow requires connectivity; it does not enable offline wallet spending or adjustment.

## Activation and remaining dependencies

- `GLOBAL_BENEFIT_ADJUSTMENT_CONTRACT=pos-global-wallet-adjustment-v1` selects the approved replacement behavior.
- `GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT=pos-wallet-user-lock-v1` may be set only after every other writer of these customer balances/earning histories honors the shared customer-row lock. A local flag cannot certify remote code.
- Cached API-v2 `auth_user` snapshots are not fresh financial authorization. Ordinary Go confirmation now locks/rechecks active/blocked customer and balances; Node pre-confirmation/projection/payment checks do the same. Source POS quote/profile cache coherence remains an independent private-context contract gate; a postcommit Redis DEL alone is insufficient.
- Historical inconsistent balances/earning histories need audited repair. There is no automatic cashback correction, history deletion or write-off.
- Global Gift Voucher issuance and its validity/history enum/default decisions remain separate work; these routes do not fabricate that feature's success.

## Evidence

- Four policy checks include320 independent original/corrected coherent FIFO vectors and strict validation/integrity rejection.
- Six source SQL checks execute against real isolated MySQL with verified physical columns/defaults and strict date mode.
- Fourteen atomic writer checks cover20 concurrent replays, competing commands/debits, late-trigger rollback/exact retry, current role/type/activity, duplicate/blocked customers, actor/body binding, original ledger proof, missing contracts/history and Python text-read FLOAT behavior,250-history SQL batch boundaries and exact BIGINT reference binding.
- Nine real IndexedDB/WebCrypto command checks cover20 cross-tab submissions/claims, restart, lost committed/uncommitted responses,30 read-only recovery passes, actor/cached-scope changes, old-callback/new-command isolation, changed replies and storage failures before/after server commit.
- Four production Chromium workflows pass: Money/Points review and completion, lost committed response recovered by GET after reload, explicit exact retry of an unconfirmed response, and offline mutation refusal. Browser server receipts are controlled fixtures; native tests independently verify actual MySQL writes.
- The portable `fields.ts`/`contracts.ts` are copied by `tools/checkout/benefit_contracts.py --write`; normal verification is read-only. Strict configs are `tools/checkout/global-benefits.tsconfig.json` and `frontend/tests/wallet-adjustments/tsconfig.json`.

No production schema/source patch, live wallet mutation, charge, order or message was performed. Mocked browser receipts do not certify database arithmetic.
