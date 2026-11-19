# W25: outbound-recipient allowlist for UAT

**Purpose.** The user will run every flow against UAT with real provider credentials. The UAT database may hold copies of real customer contacts. With the guard on, messages go **only** to recipients the user lists.

**Scope.** Backend only. It runs in the API process and the job worker, so it covers **web, desktop macOS and desktop Windows alike**: all three clients reach providers only through these backend senders.

**Status.** Implemented and unit-tested. No external service was contacted while building or testing it: every test uses fetch doubles and synthetic contacts. This is not parity or UAT evidence. The guard has not yet been exercised against UAT.

## Design

- **Guard module.** `src/outbound/allowlist.ts`.
  - `outboundAllowlistEnabled()` is synchronous and side-effect free.
  - `outboundPermitted(attempt)` answers whether the send may go ahead. It never throws.
  - Every sender calls `if (outboundAllowlistEnabled() && !(await outboundPermitted({...}))) return <success result>;` immediately before its network call.
- **Config.** `src/config.ts` (`outboundAllowlistEnvironment`, `readOutboundAllowlist`), validated with zod inside `readConfig`. An invalid configuration stops startup. Error messages name the variable but never echo its value.
- **Installation.** The guard is installed at startup by `buildApp` (API) and `jobs/worker-main.ts` (worker), each with:
  - the process logger;
  - a recipient directory (`src/outbound/recipients.ts`).

  A process that never installs it, such as a tool or a test, still reads the same variables from `process.env`.
- **Recipient matching.**
  - **Phones.** Normalised with `normaliseIndianPhone`, which strips non-digits and a `91` prefix (12 digits) or `0` prefix (11 digits). No shared normaliser existed: the senders pass `users.telephone` / `orders.phone_no` to the provider as stored, and Gupshup reads 10 digits as +91. Both the list entries and each recipient go through this function.
  - **Emails.** Trimmed and lower-cased.
  - **Slack webhooks.** Compared by SHA-256 of the URL `href`. The URLs themselves are never kept or logged.
- **API-v2 / mailr messages.** These endpoints carry only `order_id` or `user_id`; API-v2 resolves the contact itself. The guard therefore resolves **every** contact on record through the writer (falling back to the primary reader) and allows the send only if all of them are listed:
  - customer: `users.telephone` and `users.email`;
  - order: `orders.phone_no`, plus the customer's `users.telephone` and `users.email`.

  Empty values are ignored. The directory is read only while the guard is enabled.
- **Fail closed.** The send is suppressed (`reason: unresolved`) when:
  - the id is unknown;
  - the read fails;
  - no directory is installed;
  - the target list is empty.
- **Event.** A suppressed send logs a `warn` event with these fields:
  - `eventId: outbound.suppressed`
  - `module` (the calling module) and `resource: outbound-message`
  - `flow` and `channel`
  - `reason`: `not-allowlisted` or `unresolved`
  - `traceId`, `requestId` and `userId`, taken from the request or job trace
  - `eventInstanceId`

  The event never carries a recipient, a hash of one, a message body or a webhook.
- **Startup warning.** When the allowlist is enabled, each process logs one `outbound.allowlist.active` warning at startup. It carries list sizes only: `phones`, `emails`, `slackWebhooks`.
- **Disabled (the default).**
  - `outboundAllowlistEnabled()` returns false, so no directory read, no event and no change in any request.
  - Tests assert that requests to a listed recipient are byte-identical whether the guard is enabled or disabled.
- **Production.** The guard may be enabled in any environment, production included; it only ever stops messages.

## Environment (`backend/.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `OUTBOUND_ALLOWLIST_ENABLED` | `false` | `true` / `false`. An empty value means `false`. |
| `OUTBOUND_ALLOWLIST_PHONES` | empty | Comma-separated phones. `+91`, `91` and `0` prefixes, spaces and dashes are normalised away. Each entry must normalise to 8–15 digits. |
| `OUTBOUND_ALLOWLIST_EMAILS` | empty | Comma-separated emails, case-insensitive. |
| `OUTBOUND_ALLOWLIST_SLACK_WEBHOOKS` | empty | Comma-separated exact `https:` webhook URLs. These are secrets: only their SHA-256 is kept. |

When the allowlist is enabled, at least one list must be non-empty, or config validation fails.

**Order and customer messages need every contact listed.** For a test customer, list their phone **and** their email. A customer registered without an email has the address `<mobile>@temp.id`, so list that address too.

## Call sites (every guarded network call)

| # | File | Flow (`flow`) | Channel | Provider / endpoint | Recipient checked | Who triggers it |
|---|---|---|---|---|---|---|
| 1 | `src/auth/delivery.ts` `phoneSender.send` | `customer-registration-otp` | sms / whatsapp | Gupshup `enterprise.smsgupshup.com` / `WHATSAPP_GUPSHUP_API_URL` | phone | Checkout customer registration OTP. The SMS is sent at once; the WhatsApp fallback follows after a delay. |
| 2 | `src/auth/delivery.ts` `liveLoginOtpTransport.email` | `staff-login-otp` | email | Netcore `NETCORE_EMAIL_URL` | email | Staff login OTP (`otp_method=2`) |
| 3 | `src/auth/delivery.ts` `liveLoginOtpTransport.sms` | `staff-login-otp` | sms | Gupshup | phone | Staff login OTP (`otp_method=1`) |
| 4 | `src/auth/delivery.ts` `liveLoginOtpTransport.whatsapp` | `staff-login-otp-resend` | whatsapp | Gupshup media API | phone | Staff login OTP resend |
| 5 | `src/auth/delivery.ts` `liveLoginOtpTransport.slack` | `login-security-alert`, `whatsapp-failure-alert` | slack | `LOGIN_SECURITY_SLACK_WEBHOOK`, `SLACK_WHATSAPP_ALERT_WEBHOOK` | webhook | Login lockout alert; WhatsApp OTP failure alert |
| 6 | `src/modules/checkout/discounts/delivery.ts` `netcoreDiscountMailer.send` | `pg-discount-mail` | email | Netcore | email | Manager PG-discount OTP mail and discount-applied mail |
| 7 | `src/modules/gift-card-batches/delivery.ts` `send` | `gift-card-batch-mail` | email | Netcore | email | Gift-card batch archive, sent by the `pos.gift_card_batches.generate` job |
| 8 | `src/modules/checkout/order-sms.ts` `orderSmsHandler` | `order-sms` | api-v2 | API-v2 `omnichannel-sms` | order contacts | `core.tasks.send_sms` job. Online checkout, fast checkout and **desktop offline sync** all enqueue it through `checkout/finalizer.ts` |
| 9 | `src/modules/customer-otp/api-v2.ts` `sendOtp` | `customer-otp` | api-v2 | API-v2 `omnichannel-sendotp` | customer contacts | Checkout benefits customer OTP |
| 10 | `src/modules/checkout/service.ts` (verification `request`, legacy branch) | `customer-otp` | api-v2 | API-v2 `omnichannel-sendotp` via `gateway.api` | customer contacts | The same OTP when the customer-OTP module is not wired |
| 11 | `src/modules/invoice-documents/adapter.ts` `sendWhatsappInvoice` | `whatsapp-invoice` | api-v2 | mailr `api/v2/mailr/send-invoice-whatsapp/` | order contacts | WhatsApp invoice (`ENABLE_WHATSAPP_INVOICE`) |
| 12 | `src/modules/checkout/return-workflow/gateway.ts` `notify` (via `returnMail`) | `return-mail` | api-v2 | mailr `omnichannel-return-order/` | order contacts | Return completed |
| 13 | same `notify` (via `exchangeMail`) | `exchange-mail` | api-v2 | mailr `exchange/` | order contacts | Exchange completed |
| 14 | same `notify` (via `slack`) | `exchange-alert` | slack | Store or common `SLACK_URL` | webhook | Exchange/return Slack alert |
| 15 | `src/modules/fulfillment/effects.ts` `postSlack` | `fulfillment-slack-alert` | slack | Store `slack_group_url` / `SLACK_URL` | webhook | Express accept, reject, timeout and conversion alerts (API and the auto-reject job) |
| 16 | `src/modules/fulfillment/effects.ts` `simplePost` (via `outForDelivery`) | `out-for-delivery-mail` | api-v2 | mailr `express-order/out-for-delivery/` | order contacts | Express out-for-delivery |
| 17 | `src/modules/legacy-fulfillment/gateway.ts` `createOdTicket` | `onedirect-ticket` | onedirect | API-v2 `create-od-ticket` (OneDirect) | order contacts | Hyperlocal conversion and cancellation ticket |
| 18 | `src/modules/legacy-fulfillment/gateway.ts` `slack` | `hyperlocal-slack-alert` | slack | Store or common Slack | webhook | Hyperlocal alerts (API and the transfer and conversion jobs) |
| 19 | `src/modules/legacy-fulfillment/gateway.ts` `newOrderCommunication` | `hyperlocal-new-order-mail` | api-v2 | mailr `hyper_local/order_new/` | order contacts | `core.tasks.new_order_create_communication` job |
| 20 | `src/modules/administration/settings-adapters.ts` `deliver` | `settings-slack-notice` | slack | `SLACK_URL` | webhook | Store settings change notices |
| 21 | `src/modules/operational-reports/slack.ts` `postSlackText` | `report-slack-post` | slack | Report / finance webhooks | webhook | Scheduled Slack reports (inline) and finance alerts (`finance/alerts.ts`) |

### Reviewed, not guarded (no message to a person or channel)

- **`src/modules/operational-reports/scheduled-data.ts` `freshdeskReader`.** Freshdesk ticket **GET** for the CRM report. It reads only. The rewrite has no Freshdesk ticket-creation code: hyperlocal tickets go through API-v2 `create-od-ticket` (row 17).
- **`src/modules/administration/slack-provider.ts`.** Slack OAuth `oauth.v2.access` code exchange. It posts no message.
- **API-v2 `omnichannel-verifyotp`** (`customer-otp/api-v2.ts`, `checkout/service.ts`). This checks a code and sends nothing.
- **SendGrid.** No SendGrid adapter exists. All email goes to `NETCORE_EMAIL_URL` with a SendGrid-shaped payload. Pointing that URL at SendGrid stays guarded by rows 2, 6 and 7.
- **Transactional API-v2 calls that are not messaging calls.** Examples:
  - `pos/order`, `processorder`, `store-register`, `pos/exchange`
  - `express-to-warehouse-order`, `hl-online-order*`, `cancel-hl-order*`, `refund-hl-charges`
  - gift-voucher endpoints, `firebase-dynamic-link`

  These are not message deliveries, so the backend cannot attribute a recipient to them. **API-v2 may send its own customer communications as a side effect of these calls. This guard cannot stop that.** UAT API-v2 must run with its own provider sandbox or allowlist.
- **Desktop shell (`frontend/electron`) and web (`frontend/src`).** These contact no messaging provider; the coverage test asserts it. Desktop offline sync posts to the backend `offline-sync` routes. Those routes use `checkout/finalizer.ts`, which enqueues the guarded `core.tasks.send_sms` job (row 8). No client-side sender exists.

## Per-flow behaviour when a recipient is not listed

A suppressed send never makes the request. It logs `outbound.suppressed` and returns what a successful send returns, so the flow continues.

| Flow | Suppressed result | Effect on the flow |
|---|---|---|
| Staff login OTP (email/SMS) | Resolves as sent | The login challenge proceeds, but **the code never arrives**. To log in, allowlist the staff member's phone or email, or use the existing `LOGIN_FIXED_OTP_*` for test users |
| Staff login OTP resend (WhatsApp) | `true` (Gupshup "success") | No WhatsApp-failure Slack alert follows |
| Login security / WhatsApp-failure Slack | Resolves | Alert dropped |
| Customer registration OTP (SMS, WhatsApp fallback) | Resolves; both deliveries recorded as `sent` | **The code never arrives.** The "Self Verify (Without OTP)" fallback (S36) still works, as legacy. Registering a real test customer needs a listed phone |
| Customer OTP (`omnichannel-sendotp`) | `200 {mobile: true, email: true}`; challenge `SENT` | **The code never arrives.** Verification against API-v2 fails as a wrong code. Benefits that need a verified customer work only for a fully listed customer |
| PG-discount manager mail | `true` | The manager never gets the code. Allowlist the manager's email to test approval |
| Gift-card batch mail | `true` | The collection completes. The archive is still uploaded to S3, and the collection message records the address, as legacy does |
| Order SMS job | Job completes | No SMS |
| WhatsApp invoice | `'sent'` | No WhatsApp |
| Return / exchange mail | Resolves | No mail |
| Exchange / express / hyperlocal / settings / report Slack | Resolves; reports `true` / HTTP 200 | Message dropped |
| Out-for-delivery mail, hyperlocal new-order mail | Resolves; HTTP 200 | No mail |
| OneDirect ticket (`create-od-ticket`) | HTTP 200, empty body | No ticket is created. The later `hyperlocal_fd_log` lookup finds no ticket id (null), and the Slack message carries no ticket |

**OTP flows that must deliver.** The flows a user must read work end to end only when the recipient is listed:
- staff login OTP;
- customer OTP;
- registration OTP;
- the PG-discount manager code.

That is the intended UAT setup.

## Tests

| File | Coverage |
|---|---|
| `tests/outbound/allowlist-channels.test.ts` | 20 adapters × {disabled, allowed, suppressed}, across sms, whatsapp, email, slack, api-v2 and onedirect. **Disabled:** any recipient is sent to, with no event. **Allowed:** requests are byte-identical to the disabled run. **Suppressed:** no request, one event with the expected channel, module and flow, the success result, and no recipient, webhook or body in the log |
| `tests/outbound/allowlist-config.test.ts` | Default off and empty placeholders; validation with all lists empty; production allowed; invalid entries rejected without echo; normalisation and case folding; webhook digests; one startup warning with sizes only; trace and user IDs; fail-closed for unresolved recipients and partial lists |
| `tests/outbound/allowlist-coverage.test.ts` | **Static bypass check.** Any `src` module that names a provider host, credential or messaging endpoint and makes a `fetch`, or a gateway call to a messaging endpoint, must be in the guarded manifest or the exempt list. Each guarded file must import the guard, call it the expected number of times and name each of its flows. The test also asserts that `frontend/electron` and `frontend/src` contain no provider hosts, and that offline sync goes through the finalizer that enqueues the guarded order SMS |

**Checks run:** backend `tsc --noEmit`, `eslint src tests tools` and full non-MySQL `vitest run` all pass: 162 files passed, 62 skipped; 821 tests passed, 455 skipped. Before this change: 159 files, 751 tests. The frontend was not touched, so its checks were not run.

**Three-client rule.** This change is backend-only and applies identically to web, macOS and Windows. Verified here:
- the backend unit tests above;
- the static test showing that neither the web nor the desktop source contacts a provider;
- offline sync uses the backend order finalizer and its guarded order-SMS job.

Per-client UAT evidence (Playwright, macOS and Windows desktop suites against a guarded UAT backend) is still to be collected in the validation phase. No client is claimed verified by this work.

## Security-decision candidate (for the primary agent to record; `security-decisions.md` not edited)

| # | Area | Legacy behaviour | Rewrite decision | Decided by | Status |
|---|---|---|---|---|---|
| S60 (proposed) | UAT outbound allowlist | No equivalent. A non-production environment with real credentials can message every contact in its database | Optional `OUTBOUND_ALLOWLIST_*`, off by default and allowed in every environment. When on, every SMS, WhatsApp, email, Slack, OneDirect and API-v2/mailr messaging call goes only to listed phones, emails and webhook digests. Order and customer messages require **every** contact on record to be listed. An unresolvable recipient is suppressed (fail closed). A suppressed send is logged as `outbound.suppressed` with IDs only, and returns the success shape. Webhooks are held only as SHA-256. Startup logs list sizes only. Messages that API-v2 sends as side effects of transactional calls are outside the backend's reach and need an allowlist on API-v2's side | Agent (W25) | Implemented; pending user review |
