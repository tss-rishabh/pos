# Customer website authenticated handoff

Source: `order/views.py:4486` AjaxOnlineOrderView and `helpers/helpers.py:535` at `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`. The source accepts an arbitrary posted customer/store, finds the operator shadow with an unordered `.first()`, and puts a general customer JWT and website API key in the query string. Its helper uses HS256 or `2f.` + HS512, custom expiry minutes and the selected customer subject. An executed AST oracle proves both algorithm branches, 300-second fixture expiry, original store/operator-shadow attribution and the source's missing-shadow fallback to `0`. It emits no JWT/key/full unsafe URL.

The rewrite preserves the selected customer, original operator, original operator-shadow ID, store and counter. It deliberately corrects arbitrary-customer impersonation and URL credential exposure. A writer-current owned open/quoted checkout, active assigned/check-in scope, active type-2 customer, exact original type-8 operator shadow, current contact revision and actual native verified OTP proof are required. The operator's **original revocable POS session ID** and current authentication epoch are checked inside the grant transaction; cached checkout verification flags or a new login session cannot replace them. Issuance also requires explicit website consent in the strict body.

`registerCustomerWebsiteHandoff(app, config, db, sharedCustomerOtpService, options?)` registers:

| Resource                                                                                           | Request                                                                                                      | Result                                                                                            |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| GET `/api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-website-handoffs/capabilities` | Captured authenticated operator/session                                                                      | Availability, verification requirement, current checkout version and qualified receiver origin    |
| POST same base                                                                                     | `{operationId, expectedVersion, customerConsent:true}`                                                       | Fixed-expiry grant `{contract,id,operationId,checkoutId,checkoutVersion,url,serverNow,expiresAt}` |
| DELETE same base `/:grantId`                                                                       | Current owner/scope                                                                                          | Revoked unused link; consumed grants are not represented as website logout                        |
| POST `/api/v1/auth/customer-website-handoffs/redemptions`                                          | Separate constant-time service header, exact configured website Origin; `{operationId,token,browserBinding}` | Minimal original identity/scope receipt and fixed website session expiry                          |

All routes carry static resource/module/action traces. Normal routes require `X-Operator-ID` to match the authenticated principal and revalidate the POS session after async work. The service route requires its independent header before DB work, including when an authenticated browser cookie is present. Requests/receipts/tokens/contacts/bodies/raw errors are not logged. Its `Origin` header is an additional receiver constraint, not a substitute for the service credential. Tokens, consent, contacts, JWTs and keys are never accepted in query strings.

`migration.sql` creates a dedicated grant table. Only purpose-separated HMACs of capability/browser/config/authority plus scope/audit IDs are stored; no plaintext cap/customer JWT/contact enters this table. Grant token derivation binds the complete original authority, config, IDs, challenge and all fixed lifetime fields. Checkout locking serializes issuance/redemption. Exact lost-reply issuance repeats the same URL/expiry; superseding issuance revokes the prior unused link. Exactly one consumer operation/browser binding wins; only that same attempt may retry its immutable receipt, still under current authority and original expiry. A new operation/browser, expired/revoked/superseded grant or changed native scope fails closed. There are no payments, customer/cart mutations, provider messages or historical fact queries in this feature.

Frontend export: `CustomerWebsiteHandoffAction` from `frontend/src/pages/customer-website-handoff`, with `{user,storeId,checkoutId,checkoutVersion,online,onOpen}`. Parent CheckoutReview supplies the approved opener and desktop origin policy. Preparation and opening are separate user gestures. The exact HTTPS `/pos/secure-login#<opaque43>` destination is checked against the server capability origin. The component keeps its original operation/link only in memory, aborts old actor/sale continuations, expires the link on a monotonic local timer and offers explicit revocation. There is no localStorage/IndexedDB/clipboard/contact/JWT storage.

Options (owned validator; parent wires deployment examples):

| Environment variable                       | Default/contract                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `CUSTOMER_WEBSITE_HANDOFF_ENABLED`         | false                                                                           |
| `CUSTOMER_WEBSITE_HANDOFF_CONTRACT`        | exact `pos-customer-website-handoff-v1` required                                |
| `CUSTOMER_WEBSITE_HANDOFF_RECEIVER_URL`    | approved HTTPS URL, exact `/pos/secure-login`, no userinfo/query/fragment       |
| `CUSTOMER_WEBSITE_HANDOFF_SERVICE_KEY`     | separate 32–4096 printable ASCII header secret, must differ from SESSION_SECRET |
| `CUSTOMER_WEBSITE_HANDOFF_TTL_SECONDS`     | 60, bounded 15–120                                                              |
| `CUSTOMER_WEBSITE_HANDOFF_SESSION_SECONDS` | 300, bounded 60–900; additionally capped by OTP/POS session                     |

Demo/absent receiver/OTP/config stays unavailable. No missing integration is replaced by a fabricated successful login. The additive [Laravel candidate](../compatibility/upstream/customer-website-handoff/README.md) is pinned to the locally available website source; no existing `/pos/login` receiver was found in inspected website/API source. Actual deployed website auth/session/order-attribution and web/Electron navigation acceptance remain external qualification requirements. This is not evidence that today's ecommerce deployment already accepts this new receiver.

Verification:

```sh
CUSTOMER_WEBSITE_HANDOFF_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_customer_website_handoff_test \
  node node_modules/vitest/vitest.mjs run tests/customer-website-handoff
node node_modules/typescript/bin/tsc -p tools/customer-website-handoff/backend.tsconfig.json
node tools/customer-website-handoff/check-receiver.mjs
```

The native fixture guards the exact localhost database template, uses randomized isolated schemas and verified physical columns/defaults, applies real migrations, calls the real OTP service/worker with an in-process fake sender, and never connects to production. Tests cover 20-way exact request/redemption retries, competing browsers, fixed expiry, original identity mapping, supersede/revoke, original session/logout, current assignment/store/operator/role/contact/customer/check-in/version/OTP/config changes and tampered lifetime. Fastify checks prove invalid/absent machine credentials and wrong Origin perform no DB work. Receiver script tests prove fragment clearing precedes transport and lost replies retry the exact in-memory body. Actual network-disabled PHP tests cover native session establishment/reset, full-width IDs, CSRF and expiry; they do not boot or certify a whole deployed Laravel application.
