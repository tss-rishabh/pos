# Scoped customer OTP verification

This slice replaces the ordinary checkout-benefits and order-return OTP transport. Financial actions, proof consumption, Go consent, checkout/return state reconciliation and their public routes remain owned by checkout. No public route is added by this module.

## Source evidence and corrections

`tools/customer-otp/source-otp-oracle.py` executes the actual pinned API-v2 `OmniChannelSendOtp`, `OmniChannelVerifyOtp` and `_whatsapp_fallback_worker` with synthetic in-memory dependencies. It checks these complete file hashes at commit `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`:

| File | SHA256 |
| --- | --- |
| `controllers/AuthController.py` | `c81a9d9752b115d74c27dc32d0472356cf0f3834a808d947cbd30038bd604b85` |
| `libs/helper.py` | `4070e7da46499c8041c6831777b0403b2ffbf9d30911551da2da9ef0575b7766` |
| `settings.py` | `10f18f0098b02363e66853945ebe8c971fafd5d32c2d29648d5ef8f8faf80917` |

The executed source generates four random digits, writes a customer-global Redis key without an expiry, accepts another store's supplied customer/code, retains that code after successful verification and accepts a correct code after twenty wrong attempts. SMS credentials, destination and code enter GET parameters. The source schedules a 20-second WhatsApp thread; because verification leaves the Redis key present, that fallback still sends after verification. Its reachable sender also uses GET and logs provider response/error text. Source email requests the external MJML `use-tss-points-and-money` template; its rendered external body is not supplied by this repository.

The replacement deliberately changes those security properties: six CSPRNG digits; HMAC-only verification storage; purpose/operator/store/counter/customer/checkout-or-return/order binding; current contact revision plus native MySQL digest; current operator auth epoch; bounded expiry and shared send/attempt budgets; body-only POST transports; durable delivery receipts; and no raw provider/PII logging. These are explicit security corrections, not response-identical query optimizations. The source's employee-mobile restriction is retained, with case-normalized company-email classification. Invalid/placeholder email is not treated as a reachable real contact.

## Service and lifecycle

`customerOtpService(config, db, options, delivery, clock?)` exports:

- `request(user, scope, challengeId, operationId, expectedContact)` queues an immutable, exact-scope challenge and returns pending/sent/uncertain/rejected status.
- `verify(user, scope, challengeId, operationId, sixDigitCode)` durably records failures or a fixed proof. Failed intent replay never buys another guess.
- `read(user, scope, challengeId)` reconciles the same private challenge without sending anything.
- `readOperation(user, scope, challengeId, operationId)` returns only original operation kind/error plus current safe challenge status, or null if it never committed. Wrong-code recovery never repeats a guess. A request replay must keep its original operation ID; another ID cannot manufacture additional receipts for the same issuance.
- `assertVerified(transaction, user, scope, challengeId, expectedContact, verifiedUntil)` checks an unspent proof inside the caller's existing writer transaction. It never opens a nested transaction, sends, guesses or writes another operation. Accepted financial-operation replays remain the financial module's immutable responsibility.

The `CustomerOtpScope` purpose is `checkout-benefits` with a checkout UUID and null order, or `order-return` with a return-verification UUID and order ID. The caller first persists the matching checkout `verificationChallenge.id/contact` or return `otpChallengeId/contact`; arbitrary customer IDs cannot create independent OTP authority. Ownership/check-in/current actor and store locks precede scope, MUser/revision, challenge and sorted budget locks. Archived stores/operators, disabled customers, changed counters/scopes, restored credentials with a newer epoch and changed/restored participating contact revisions cannot resume an old proof. Native contact bytes additionally detect independent legacy contact edits; coexistence with blind legacy writers still requires the shared contact rollout fence.

Issuance, code verification and dispatch require an open/quoted checkout. Reading/asserting an already verified proof can also continue during `order-created` only when the private frozen order consent exactly binds the saved order, customer, operator, store, counter, native contact and the original stored proof expiry. A forged order or even internally matching altered expiry fails. This permits the required final check before confirmation without authorizing a new code or reviving an archived actor's proof.

Code validity is five minutes. Successful proof validity ends fifteen minutes after original issuance, even if verification happens later or is replayed. Defaults allow six requests/business day, one request/minute, five failed guesses/shared five-minute window and thirty failures/business day. Customer and hashed destination budgets are shared across checkout/return subjects and persist after cancellation/supersession. A request queues at most SMS plus real email, and optionally WhatsApp. All channel jobs share that one challenge code and consume one request budget. A new explicit request supersedes the previous code for the same scope.

`customerOtpOutbox(...).drain(signal, limit)` persists SENDING before I/O. Missing acknowledgement, thrown delivery and expired leases become UNCERTAIN and never automatically reissue that channel. A legitimately arrived uncertain code may still verify, within its original limits. Optional WhatsApp is a distinct planned channel, delayed by the source-default twenty seconds and cancelled after verification, supersession, expiry or revoked authority. It does not use the source's Redis or thread. Every dispatch rechecks the original current authority/contact and encrypted payload owner/purpose. Bounded cleanup erases expired pending secrets while retaining receipts, budgets and financial IDs.

## Deployment hooks

`src/modules/customer-otp/migration.sql` creates only four rewrite tables: challenges, budgets, deliveries and immutable operations. Apply through the writer migration registry after administration check-ins, checkout/return tables, auth epochs and customer-contact revisions. No legacy DDL or live source writes occurred.

`index.ts` exports `readCustomerOtpOptions`, `createCustomerOtpDelivery`, `customerOtpService`, `customerOtpOutbox`, `pruneCustomerOtpProofs` and the scope/view/delivery types. `worker-main.ts` is a supervised bounded poller with a ten-second shutdown deadline and sanitized resource/request/user events. The proposed package command is `node --env-file-if-exists=.env dist/modules/customer-otp/worker-main.js`.

Exact options are illustrated in `src/modules/customer-otp/.env.example`. Feature and worker default disabled. Activation requires the separate OTP secret, exact feature contract, verified writer and approved purpose-specific template contract/templates. SMS and WhatsApp reuse the safe form POST transport and require a parsed success acknowledgement. Email uses a bounded direct Netcore POST with static subject and escaped configured purpose text; this is not an unsupported claim to reproduce an unavailable MJML renderer. Provider/template acceptance and complete financial integration remain release checks. No real OTP, broker task or external message was sent during tests.

## Focused evidence

Twenty-eight focused tests currently pass: twenty isolated real-MySQL lifecycle/authority cases, five transport cases, two cipher/HMAC cases and one actual pinned source oracle. Native cases include twenty concurrent exact requests/workers, immutable wrong-intent replay and receipt recovery, absent-operation recovery, cross-purpose shared budgets, contact restoration fences, disabled/archived authority, expired sending leases, a late HTTP acknowledgement after another worker fenced the lease, transaction rollback, fixed proof expiry, employee policy, optional delayed/cancelled WhatsApp, transaction-scoped proof assertion and strict frozen-order consent. Strict TypeScript, ESLint and the source-oracle Ruff checks are separate gates. These prove this bounded component, not deployed provider acceptance or whole-application parity.

`frontend/tests/customer-otp/otp.browser.test.ts` runs eight real Chromium workflows: six against actual `CheckoutReview` and its immutable IndexedDB draft/snapshot binding, plus two against actual `ReturnsPage`. It covers pending/uncertain delivery via GET, original-ID recovery after lost checkout/return request replies, reload/recovery after committed wrong guesses, recovery of a successful checkout verification without extending/reposting it, stale operator continuations and offline blocking. Return cases forbid financial return/refund/exchange POSTs. The fixture asserts that OTP text does not persist in local storage/IndexedDB and that URLs do not carry code/contact fields. It uses an isolated ephemeral Vite origin/cache and fake API results; no provider message is sent. Enable with `ADMINISTRATION_BROWSER_TESTS=true`; its strict config is `frontend/tests/customer-otp/tsconfig.json`.
