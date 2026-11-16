# Checkout and return customer verification

This slice replaces the unsafe shared omnichannel OTP transport with the local purpose-bound module. It does not certify provider delivery or a deployed payments patch. No live code, message, order or payment was sent.

## Source and deliberate security changes

The source POS revision is `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`; API-v2 is `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. `controllers/AuthController.py:2335–2415` uses a four-digit code in a customer-global `omnichannel<id>` Redis key, without a fixed expiry or purpose/operator/store/order binding. SMS puts the destination, message and provider password in a GET query. Successful verification leaves the code reusable. These behaviors are intentionally not copied under the user's security requirements.

The local module uses a six-digit hashed code, fixed challenge/proof expiry, durable shared send/guess budgets, actor epoch and current store/counter authority, exact checkout or original-order purpose, and a writer-verified customer contact revision/digest. The source employee-mobile suppression remains supported. Real-email eligibility and separate approved purpose templates prevent temporary membership addresses or an unrelated login template from being treated as delivery proof. Optional delayed WhatsApp is independently configured and disabled by default. The module and its worker are owned in `src/modules/customer-otp`; its tests prove the atomic queue, channel uncertainty, encrypted delivery, fixed expiry and current authority. Both old omnichannel gateway endpoints now fail before a network request.

Contact revisions are monotonic decimal strings, including values above JavaScript's safe integer range. The native digest is shared verbatim with Go:

```sql
LOWER(SHA2(CAST(JSON_OBJECT('customer_id',users.id,'email',users.email,'telephone',users.telephone) AS CHAR CHARACTER SET utf8mb4),256))
```

Digests, raw codes and destinations never enter public checkout/return DTOs, local recovery storage or logs. Restoring an old contact value does not restore its old revision. Active status and nullable clear block/disabled flags are checked on the writer; anomalous nonzero flags cannot authorize a new benefit spend.

## HTTP and recovery

Existing checkout challenge/confirmation URLs are retained with strict JSON bodies and six-digit validation. Public challenge metadata distinguishes `pending`, `sent`, `uncertain` and `rejected`. A queued action never claims delivery. GET refresh can observe delivery, and an actually arrived code may be verified from uncertain delivery. The fixed original proof expiry is never extended by a refresh/replay.

Two new resources repair only local checkpoints from already committed OTP operation receipts:

- `POST /api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-verification/reconciliations`, `{operationId,expectedVersion}`.
- `POST /api/v1/stores/:storeId/return-verifications/:verificationId/reconciliations`, `{operationId}`.

`operationId` is the original queued request or verification UUID, not a new command. Recovery calls `readOperation` only: it cannot send another code, guess again or restart the original action. Missing commit evidence stays unresolved. A lost wrong-code response retains its original rejection even if another action later verifies that challenge. Current contact/actor revocation rejects only the matching unspent OTP action, without touching a financial action. Checkout repair serializes the original operation and version; twenty simultaneous repairs finish once, and a repeated old callback returns current state without overwriting newer cart edits. Interrupted verification keeps its operation identifier across reloads. Codes remain memory-only and are cleared before replacement requests and verification awaits.

Return lines use the return purpose and expose only the original minimal line fields, including supported cross-store/online purchases. New return acceptance calls `assertVerified` inside its existing writer transaction, rechecking current actor epoch/contact and the exact fixed proof. A rejected proof cannot dispatch a warehouse or refund action. An already accepted financial operation continues from its durable checkpoints without reinterpreting a later contact change or expired OTP.

## Ordinary order consent attestation

Migration `0017_customer_consent_proof.sql` adds `pos_rewrite_checkout_customer_consents`. It is required alongside the ordinary projection, gift-card and contact-revision migrations. `ordinary/customer-consent-migration.sql` is a byte-identical deployable copy; read-only artifact verification checks it.

Before source order creation and confirmation, the rewrite requires `UPSTREAM_POS_CUSTOMER_CONSENT_CONTRACT=pos-customer-contact-consent-v1`. Benefit/employee-coupon confirmation carries `X-POS-Customer-Consent`, independently HMAC-authenticated with the private projection key and the domain `pos-customer-contact-consent-v1\n`. Its canonical JSON binds version/contract/order/customer/original operator/store/counter/contact revision+digest/fixed expiry. IDs are decimal signed-BIGINT strings; the contact revision supports the complete unsigned-BIGINT range. This is not a customer JWT or a reusable login capability. The header is forwarded only to confirmation and removed by the private Go middleware before downstream processing/logging.

The Go transaction locks fresh customer balances/status/contacts and the employee-coupon classification. It rejects missing/mismatched/expired proof before allocations when money, points, voucher value or an employee coupon is used. After the literal source allocation callback, it compares the exact native final header hash with the pre-callback locked hash, including both coupon ID and amount. A late switch to an employee coupon, late amount or wallet mutation rolls back stock, status, outbox and proof rows. Required and cash-only/not-required attestations commit with the ordinary projection; paid status alone cannot synthesize one.

The immutable read-side proof records accepted time and original verification interval. Committed recovery does not compare today's contact, OTP clock or paying operator to that original consent. Offline cash import writes a required-zero attestation only after proving cash-only, zero-asset/nonemployee inputs. Existing signed/offline cash remains retained and countable after contact changes; it is never converted back into an unpaid draft.

## Evidence and activation

- Checkout wrapper tests prove queued/unknown delivery, lost request, missing queue evidence, lost successful/wrong verification, revocation, fixed expiry and no legacy OTP network call.
- The main isolated MySQL checkout suite covers twenty-way checkpoint repair, stale version/contact refusal, and return request/verification recovery plus proof rejection inside acceptance before external work.
- The actual `CheckoutReview` fixture in `frontend/tests/customer-otp` covers reload and original-ID recovery without resend or another guess. Return UI fixtures cover the equivalent purpose.
- Portless pinned MySQL8.4/Go1.25.4 race tests execute the extracted original wallet/stock allocator, actual patched Gin HTTP boundary, required consent, native long revisions, immutable replay, private-header canaries and late employee-coupon rollback. Node and Go independently verify the same canonical HMAC golden.
- The complete pinned payments application, `juspay` package and effects worker compile after disposable patch composition. Sibling repositories are unchanged. Generators are read-only unless explicitly invoked with `--write`.

Activate only after controlled migrations, approved purpose templates/provider sandbox qualification, deployment of the pinned private ordinary confirmation patch, and certification of shared wallet/contact writers. Blank delivery/contracts remain disabled. This evidence is not a full source-route, provider, legal invoice or production release certification.
