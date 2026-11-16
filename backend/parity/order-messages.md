# Source-derived order SMS

The local adapter replaces API-v2 `AuthController.OmniChannelSms` rather than invoking its unsafe transport. It is disabled by default. No live SMS, recipient or provider credential was used in verification.

Source API-v2 is pinned at `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. The original handler (`controllers/AuthController.py:2424–2488`) concatenates first+last names, selects NPS using `check_for_sms:2504`, creates a normal customer login token for an NPS URL query, calls a third-party shortener, logs provider parameters and issues a GET containing destination/message/password. The replacement retains the literal normal/NPS message text and source `order_addons.is_nps_notification_checked` selection. It deliberately replaces login-token creation, query credentials, raw logs and the capability-sharing shortener under the user's security requirements. Multiple addon rows or anomalous flags require review instead of choosing an unstable row.

`localOrderMessageDelivery` runs inside the existing internal financial worker; it exposes no public HTTP or arbitrary-destination API. While the durable outbox row is locked, it verifies exact order/store/counter/customer, writer-paid status4 and the native ordinary stock/wallet/consent/refund projection. It reads the original customer's current name/telephone and NPS selection, builds a transient message, then publishes the first `processing` claim. No database transaction is held across network delivery. Unpaid SMS remains pending; an order-creation acknowledgment cannot trigger a payment-confirmed notification.

The shared HTTPS form transport sends only POST bodies to the fixed Gupshup gateway, rejects redirects, bounds response/time and requires a recognized provider acceptance acknowledgment. Credentials, telephone, message and feedback proof never enter a URL query or log. `delivered` means provider acceptance, not certified handset arrival. Failed/unknown acknowledgments remain frozen; a crash or late outcome-write failure leaves `processing`, which is never automatically reclaimed. The transient prepared command also refuses a second send. Source producer/engagement deliveries remain separate resources with their original correlation.

Feedback links use the reviewed `pos-feedback-proof-v1` verifier and an independent signing key. The proof contains only version, issuer/audience/purpose/type, exact decimal order ID, bounded issue/expiry times and random ID. It has no customer subject/contact and cannot be verified with configured customer/session keys. Only the URL fragment carries it; the existing isolated feedback receiver removes that fragment before network access. No customer token or `user_token_log` is created. The public receiver/consumer deployment and its approved key rotation remain activation prerequisites; a flag alone does not prove that deployment.

Configure local delivery explicitly:

```
ORDER_SMS_DELIVERY_MODE=local
ORDER_SMS_DELIVERY_CONTRACT=pos-order-sms-security-v1
POS_INVOICE_FEEDBACK_VERIFIER_CONTRACT=pos-feedback-proof-v1
POS_INVOICE_FEEDBACK_KEY_ID=<approved-current-key-id>
POS_INVOICE_FEEDBACK_KEY=<distinct-feedback-signing-secret>
POS_INVOICE_FEEDBACK_URL=<approved-https-feedback-receiver-with-no-query-or-fragment>
POS_INVOICE_FEEDBACK_TTL_SECONDS=<approved-60-through-2678400-seconds>
GUPSHUP_SMS_USER_ID=<provider-secret>
GUPSHUP_SMS_PASSWORD=<provider-secret>
```

Both configured customer JWT keys are required for key-reuse checks. Feedback signing also rejects equality with configured private invoice/projection/message keys. `DEMO_MODE` prevents actual local delivery. Leave delivery mode disabled until provider/form/template acceptance and the purpose-only receiver are certified. The separately gated private-HTTP adapter is retained as an explicit alternative; selecting both adapters is a configuration error. The old `omnichannel-sms` URL is never silently used as a fallback.

Migration `src/modules/checkout/order-messages/migration.sql` adds the ordered pending-work index. The exact query/index and response-equivalence limits are in root `improve-query.md`; no legacy DDL or SQL-mode change is used.

Evidence:

- `tools/checkout/legacy_order_sms_oracle.py` executes the literal pinned handler/check helper with inert SQL/signer/HTTP fakes. Thirty name/flag/shortener vectors match the TypeScript text exactly. Default test execution is read-only.
- `tests/checkout/order-messages.test.ts` verifies source text, exact long order IDs, purpose-only fragment proofs, bounded TTL, independent keys and disabled/invalid configuration before HTTP.
- The isolated main MySQL checkout suite proves unpaid rows remain unclaimed, missing/tampered native proof prevents dispatch, concurrent workers send each eligible message once, NPS uses the strict verifier, credentials stay in POST bodies, provider uncertainty and a late local acknowledgment-write failure freeze without another send, and the index is present/eligible in the local plan.

This is concrete production code with mock/local evidence. Provider certification, actual delivery, approved messaging templates, public feedback consumer atomicity and the overall source-feature release gate are not claimed complete.
