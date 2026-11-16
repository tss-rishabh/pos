# Private invoice and feedback correction

This is an **unapplied** compatibility artifact. Neither sibling source repository was edited. The Node invoice client fails closed unless the two explicit contracts below are configured and the returned document has a matching per-request HMAC. A configuration flag alone cannot satisfy that response check.

The input pins and exact output/file/patch hashes are in `manifest.json` (API-v2 `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`) and `postorder-manifest.json` (post-order `a941f4e84ed485c10169132a3972b8db74ab31bc`). Both remain `enabled:false`. `prepare.py` and `prepare_postorder.py` **verify without writing by default**. Only an explicit `--write` rebuilds these artifacts. The feedback browser JavaScript is compiled from `feedback-client.ts` using the target backend's pinned TypeScript package.

## Why this correction exists

The pinned `InvoiceController.PosInvoiceShop` accepts `pos_token` in a URL query and calls ordinary `AuthController.create_token` for its shopping-feedback QR. That creates a customer login JWT and writes `user_token_log` during an invoice GET. A `purpose` claim added to that JWT would not protect it: the generic customer decoder does not enforce such a claim. The pinned post-order service also logs request bodies/URLs, raw NPS and vendor errors, and loads automatic HTTP/SQL tracing from its normal entrypoint.

The correction uses **independent service, feedback and customer/session keys**. The feedback proof has no login subject or contact fields; it binds one decimal-string order ID, issuer/audience/purpose/type, key ID, issued/expiry times and random proof ID. It cannot authenticate through the original customer decoder. Issuance and verification require explicit bounded validity and retained verification keys. Rotation retains only explicitly approved old feedback keys.

## Isolated invoice worker

Apply `api-v2-invoice-security.patch` only to a disposable checkout/image at the pinned API-v2 revision. Use the checked-in `runtime/pyproject.toml` and `runtime/uv.lock` with Python 3.12. The minimal locked environment avoids the original application's writer/auth/task imports. Do **not** run its ordinary `main`, Gunicorn configuration, New Relic wrapper or telemetry preload for this worker.

```sh
uv sync --frozen --project /path/to/invoice-security/runtime
gunicorn -c pos_invoice_gunicorn_config.py
```

Supply these values from the approved secret/configuration store:

| Value | Meaning |
| --- | --- |
| `POS_INVOICE_PORT` | Explicit listener port behind the private HTTPS ingress |
| `POS_INVOICE_MYSQL_READER_URL` | Dedicated MySQL reader credentials, without URL query/fragment |
| `POS_INVOICE_MYSQL_SSL_CA` | Trusted CA file; hostname verification is required |
| `POS_INVOICE_SERVICE_KEY` | New printable ASCII service key, 32–4096 bytes |
| `POS_INVOICE_FEEDBACK_KEY` | Independent feedback signing key, 32–4096 UTF-8 bytes |
| `POS_INVOICE_FEEDBACK_KEY_ID` | Unique retained-key ID |
| `POS_INVOICE_FEEDBACK_TTL_SECONDS` | Explicit 60–2678400-second validity, no default |
| `POS_INVOICE_FEEDBACK_URL` | HTTPS standalone consumer URL, normally `/invoice-feedback`, no credentials/query/fragment |
| `POS_INVOICE_FEEDBACK_VERIFIER_CONTRACT` | `pos-feedback-proof-v1`, only after the matching consumer is qualified |

The source settings must also contain the actual `SECRET_KEY`, `SECRET_KEY_512` and old `POS_INVOICE_KEY` so the issuer can reject key reuse. Those keys do not authorize this resource. Source image/model/GST settings remain source-owned; no replacement tax formula was introduced.

`pos_invoice_factory.create_app()` checks the exact patched controller/helper bytes before import. It creates only `/internal/pos/invoices/store`; no ordinary auth/invoice routes or middleware are registered. A tiny `database.database` binding supplies the reader only, so loading the controller never constructs the original writer/Redis sessions. Its real MySQL connections set transaction read-only, retain SQL mode, use bounded connection/query timeouts and disable ORM parameter logging. Database grants must independently be read-only.

The source cache-miss `tss_settings` SELECT is retained. This process has no Redis connection or cache-write API and does not warm the shared cache. Using current database settings instead of an independently stale Redis hit is a deliberate freshness boundary; settings/template acceptance must include that difference. Existing source fallback behavior is not silently rewritten.

The Node client uses only `order_id` in the URL. A private key, two contract markers, random nonce and operator/request correlation travel in headers. Unexpected query fields, duplicate IDs, legacy `pos_token` and invalid IDs are rejected. The response HMAC binds exact UTF-8 HTML, order/kind/operator/request/nonce and both contracts before sanitization. The Node client rechecks fresh writer authorization/payment scope after the remote render; it never holds a database lock across that call.

The worker's source error logger and dedicated Gunicorn logger discard raw arguments, exceptions, headers, bodies, URLs and access logs. Their events contain only static module/resource/event identifiers plus request/operator correlation. Anonymous feedback holders never become an operator ID. This scoped correction does **not** certify the ordinary API-v2/post-order process or unrelated workers.

## Isolated feedback consumer

Apply `post-order-feedback-security.patch` to an isolated image at the pinned post-order revision, using its immutable lockfile and Node 24 LTS. Start `node pos_feedback_main.ts`; do not use the original instrumentation/main/start command. The entrypoint refuses instrumentation preloads. Terminate HTTPS in the reviewed ingress; do not enable request-body/header/query/SQL-parameter capture there.

Required values:

- `POS_INVOICE_FEEDBACK_KEYS_JSON`: 1–8 retained `{id,key}` objects. No duplicate IDs/key bytes or reuse of configured `SECRET_KEY`, `SECRET_KEY_512` or legacy `NPS_SECRET_KEY` is allowed.
- `POS_INVOICE_FEEDBACK_MAX_TTL_SECONDS`: explicit maximum accepted validity, matching the approved issuer policy.
- `POS_FEEDBACK_WEB_ORIGINS`: 1–8 distinct HTTPS origins without paths or credentials.
- `POS_FEEDBACK_PORT`, plus the source's scoped database, NPS URL/template and approved vendor configuration.

The factory exposes the source `/api/v1/post-order/nps/new-feedback` GET/POST behind the strict verifier, its preflight and static result pages, and `/invoice-feedback` with same-origin JS/CSS. It does not expose the legacy order-only `/nps/` or `/nps/pos` mutations. There is no fallback to legacy/customer auth. Only the original source survey handlers/schemas are used; they receive the exact string order ID. Source NPS/vendor/database-connection logs are replaced with closed events. Default Fastify logging and the original global error handler/tracing are absent. Input bytes, timeouts, cross-origin access and process-local request rates are bounded.

The browser consumes the proof only from the fragment, removes it before any API request, keeps it only in memory, omits cookies/referrers, validates returned data and renders option text without HTML. It cannot follow an arbitrary redirect. New QR fragments reset the form; a pending/unknown submission remains bound to its original receipt. Unknown POST results permit GET status checks only. A source GET indicating an existing score does **not** prove that every comment/option from an interrupted multi-write POST committed, and the UI says so.

## Verification and limits

From the target backend:

```sh
python3 compatibility/upstream/invoice-security/prepare.py
python3 compatibility/upstream/invoice-security/prepare_postorder.py
python3 -m unittest discover -s compatibility/upstream/invoice-security -p test_security.py
npm test -- tests/checkout/invoice-security.test.ts tests/checkout/invoice-feedback.test.ts
CHECKOUT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_checkout_test npm test -- tests/checkout/invoice-reader.mysql.integration.test.ts tests/checkout/mysql.integration.test.ts
npx tsc --noEmit -p tools/checkout/invoice-security.tsconfig.json
```

The source handler test deliberately stubs tax/template dependencies. The native reader check additionally starts the whole actual pinned controller/models under the locked Falcon/SQLAlchemy environment with explicit synthetic settings, proves private/header/ID fencing and missing writer/Redis bindings, and rejects an actual INSERT without changing SQL mode. It is not a full legal invoice render fixture. The runtime dependency audit on 2026-11-16 reported no known vulnerabilities for the exported lock on the tested host; repeat the audit/build on the deployment platform.

`frontend/e2e/checkout/invoice-feedback.spec.ts` exercises the compiled standalone consumer in Chromium under its production CSP. Existing protected invoice-preview tests still apply. Production activation remains blocked on exact deployment/provider qualification, complete authoritative GST/IRN/QR/template fixtures, current source settings acceptance, full NPS transaction/idempotency/database-encoding evidence, reviewed ingress/telemetry behavior, and the old public NPS service's routing policy. No live feedback/SMS or database write was performed against a supplied service.

## Separate order-SMS finding

`AuthController.OmniChannelSms` is a different issuer: it creates ordinary customer JWTs for NPS, logs provider parameters, and sends telephone/message/provider credentials in GET query parameters. It is not fixed by the invoice patch. The Node outbox now retains SMS jobs pending unless a distinct `pos-order-sms-security-v1` private contract/key and exact `/internal/pos/order-messages` path are configured. A recognized response must bind the original event/order/operator/request/nonce/body by HMAC and acknowledge the feedback contract. Unknown or unproved delivery freezes without automatic resend. The private SMS provider correction is a separate pending artifact; do not set its activation flag for the old endpoint or claim this gate implements delivery.
