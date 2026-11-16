# Customer website handoff receiver candidate

This is an additive, reviewable receiver for **laravel-web `cd02b3476cbb58d3d89f0ee32b77d74586021104`**, not evidence of a deployed ecommerce receiver. The pinned POS `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a` sends a JWT/API key to `/pos/login/`. No corresponding receiver was found in the inspected API-v2 `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`, Laravel website or wt-api-main source. API-v2's order controller consumes POS store/operator attribution; that is not an authentication receiver.

The available Laravel native session contract is `controllers/theStore/UserController.php` (`Auth::attempt`) and `models/User.php` (`users`, customer type 2). The candidate uses `Auth::login($customer, false)` with the native current account, never an invented API-v2 login or a general customer JWT. It clears the previous account/cart session and regenerates its session ID. Only account/receipt/store/operator identifiers and expiry are added. Names, contacts and balances are not copied into new session fields. Website presentation that expects the old email/name convenience session keys needs qualification against the actual deployed frontend.

`PosWebsiteHandoff.php` and `routes.review.php` are to be installed together with `receiver.html` outside the public directory and loaded through the qualified application's class loader/routes. Existing source files remain untouched. Configure `pos_handoff` server-side:

```php
array(
  'contract' => 'pos-customer-website-handoff-v1',
  'receiver_url' => 'https://YOUR-APPROVED-WEBSITE/pos/secure-login',
  'redemption_url' => 'https://YOUR-POS-API/api/v1/auth/customer-website-handoffs/redemptions',
  'customer_connection' => 'YOUR-QUALIFIED-WRITER-CONNECTION',
  'service_key' => 'SEPARATE-SERVER-ONLY-SECRET'
)
```

Use a server-side session store with secure HttpOnly SameSite cookies, reliable server clock and trusted TLS/proxy origin configuration. Qualify the explicitly named customer writer connection and native Auth user provider; a stale replica must not authorize a blocked account. PHP cURL/OpenSSL and 64-bit integers are required. Do not put these routes behind body/response/session/credential logging, analytics, a service worker or a cache. The page has no external assets. It clears the fragment before transport, then submits the capability in a CSRF-protected same-origin JSON body. The server exchanges it over verified HTTPS with a separate header credential, fixed origin, no redirects/cookies and bounded response/time limits. No raw errors or upstream contents are returned/logged.

The server's random preauthentication session binding is preserved across a fresh login session ID and exact lost-response retries; the cap itself never enters server session or browser storage. `regenerate(false)` retains the previous **preauthentication** session for a lost-cookie retry without granting that session the new login. CSRF is intentionally retained through this transition. Native durable grant consumption permits only the identical redemption operation and original browser binding within its original expiry. Reloading after the fragment was cleared requires a new store link.

Apply the expiry/current-customer guard to every sessionful website route before its action, including AJAX/API routes that rely on that session. The new website session lasts at most the configured POS handoff session duration (default five minutes), original OTP proof and original POS session, whichever ends first. POS logout/contact/scope changes before redemption reject the link, including exact replay. An already established native website session has a bounded fixed lifetime; instantaneous cross-application logout after establishment is not claimed. A separate live session introspection integration would be needed for that policy.

Preserve `pos_store_id` and `pos_user_id` (the original operator's customer-shadow ID), plus `pos_operator_id`, in the actual website order producer. The checked-in source does not establish how a modern website forwards those fields into API-v2. Accept the current website/session/order-attribution integration before enabling `CUSTOMER_WEBSITE_HANDOFF_ENABLED`; an approved URL and secret alone do not establish deployment compatibility. The receiver returns only `{"status":"signed-in"}`, never an ecommerce JWT.

Run actual PHP syntax and isolated facade contracts with the already present local image:

```sh
node tools/customer-website-handoff/check-receiver.mjs
```

That program uses `php:5.6-cli --network none` and a read-only mount. It does not boot Laravel, contact a website, log in a real account or certify a deployed receiver. The Python source oracle extracts and executes only the pinned pure view/helper methods with synthetic secrets and returns token-free summaries.
