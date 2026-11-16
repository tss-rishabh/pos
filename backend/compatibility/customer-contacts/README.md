# Customer contact source effects

This private compatibility service retains source side effects after a verified Node contact commit. It does not expose account edits or import the source application's startup/middleware. The source contract is pinned at API-v2 `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5` in `source-manifest.json`.

## Durable behavior

`POST /internal/pos/customer-contact-effects` requires the separate `X-Customer-Contact-Key`, exact contract header and canonical payload HMAC. URLs cannot carry query data; no cookie/SSO authority is used. The body is bound to the actual rewrite challenge, successful commit receipt, source-effect outbox and current customer contact on the configured writer. Refund notice pairs are rechecked with a bounded joined query. Duplicate IDs must have the same frozen input. Receipt plus all sealed jobs commit atomically; an acknowledgement is returned only after that commit.

Jobs invalidate the public `auth_user:{id}` cache, refresh the payment/Juspay customer with a fresh short-lived standard source JWT, publish profile/MoEngage/support work, and request the eligible failed-refund notices. Source account IDs remain unchanged. Provider responses, tokens, contact values, source exceptions and connection URLs are never logged. Task publication uses only customer IDs, separate operation/request/actor metadata and a private argument representation; JWTs are never placed on the broker.

Cache deletion must finish before other jobs. A task/mail is marked SENDING before I/O. Missing acknowledgements or expired leases remain UNCERTAIN and are not automatically republished. Deterministic Celery task IDs provide correlation, not an exactly-once execution guarantee. Ordinary provider success or broker acceptance does not prove downstream CRM completion. The [official Celery calling documentation](https://docs.celeryq.dev/en/stable/userguide/calling.html#message-sending-retry) describes publisher retries; this producer disables them explicitly.

## Concrete source privacy candidate

The pinned source has these exposure points:

| Source path | Observed behavior |
| --- | --- |
| `tasks.py:1522` `update_user_profile` | Logs the entire CleverTap response and raw exceptions; calls the Netcore helper |
| `libs/helper.py:877` | Logs MoEngage response dictionaries and raw request errors |
| `task_helper.py:449` | Logs uncontrolled Netcore exception text |
| `libs/CustomerSupportFlagging.py:388` | Logs per-customer result dictionaries and exception tracebacks |
| `utils/logger.py` / `unified_json_logger.py` | Stream/JSON handlers can receive those uncontrolled strings; masking is not proof of absence |

`patches/customer-contact-task-privacy.patch` adds one import/registration call to `tasks.py` and the new `pos_contact_task_privacy.py` helper. The three original function bodies, decorators and exports are unchanged. New names `pos.customer_contacts.clevertap_v1`, `...moengage_v1`, and `...support_v1` call their unchanged `.run` functions inside a validated single-customer purpose scope. An unpatched worker cannot execute those new names.

Within that scope the LogRecord factory prevents raw source diagnostics from reaching existing handlers, including nested helper errors and `exc_info`. Only safe structured `started`, `returned` or `failed` events are emitted, with static module/resource/event IDs, request UUID, cashier user ID, task ID and operation ID. Safe error/warning counts retain evidence of swallowed provider failures without their private diagnostics. Escaping exceptions become static errors without the source cause. `returned` means the source function returned; it does not falsely assert provider completion. The same purpose scope bounds the observed requests calls to HTTPS, no redirects, at most 3-second connect/5-second read and 64 KiB responses; other source callers retain their behavior. The inspected source paths are synchronous and contain no direct stdout/thread spawning in their reachable task/helper functions; changed source code must be re-pinned and reviewed.

The candidate manifest records base/result/helper/patch SHA256 values and a successful dry apply in a temporary copy. The current patch hash is `c64305d6bbcb65e678a3e0c9cffa98e16d949bbc77934cf841828d25722f3a5b`. No sibling repository or deployed worker was modified.

The source helper exposes a read-only Celery inspection command, `pos_contact_task_privacy`, returning only the contract, source/helper hashes and registered private names. The bridge worker requires all of: explicit acceptance of this candidate hash, the exact hash response from the configured source worker, its consumption of both isolated `pos-contact-*` queues, and the configured task contract. Probes are bounded metadata requests; they do not publish customer tasks. The default privacy flag remains false until this actual artifact is accepted. A boolean by itself cannot enable an unverified source consumer.

## Deployment artifacts and settings

`migration.sql` creates only two rewrite effect tables; install it through the root writer migration runner after the Node contacts migration. It does not modify legacy schema. `Dockerfile` pins the official Python 3.12.15 multiarch image digest and installs hash-locked requirements. It runs as UID/GID 10001. The image serves the Gunicorn factory `runtime:create_application()` on 8080; use the same image with `python runtime.py` for the separate supervised worker. `/healthz` reports configuration, not live provider acceptance.

`.env.example` enumerates the exact settings. The service, storage and standard source JWT keys are distinct responsibilities. Use verified TLS writer/Redis endpoints; the supplied reader is never a writer. Mount the MySQL CA read-only. Keep private HTTP behind an authenticated internal HTTPS route; the Node adapter rejects redirects, URL credentials, queries and non-HTTPS endpoints. Use separate isolated CRM/support queues and the exact patched worker node name. The payment URL is the source `PAYMENT_URL + customers/update`; the refund URL is the source `REFUND_FAILED_MAIL_API`. No endpoint or secret is guessed from the data-reader hostname.

Preserve the configured payload/transport keys while obligations are unresolved. Do not discard encrypted receipt/job state or automatically resend an uncertain task/mail. Review broker/provider evidence and resolve the recorded job deliberately; source delivery is not an excuse to change a saved customer or repeat a financial transaction. Live provider acceptance and coexistence with independent contact writers remain explicit release dependencies.

## Reproduce without live effects

From backend:

```
uv sync --frozen --directory compatibility/customer-contacts
uv run --project compatibility/customer-contacts python -m unittest discover -s compatibility/customer-contacts/tests
uv run --no-project --python 3.10 --with celery==5.3.6 --with requests==2.31.0 python -m unittest discover -s compatibility/customer-contacts/tests -p test_source_privacy.py
python3 tools/customer-contacts/build-source-privacy-candidate.py
CUSTOMER_CONTACT_MYSQL_TEST_URL=mysql://root@127.0.0.1/pos_rewrite_customer_contacts_test npx -y node@24.22.3 node_modules/vitest/vitest.mjs run tests/customer-contacts
```

The source AST tests first demonstrate the actual original response/error leaks using synthetic values, then prove their absence through the candidate. They also check scope rejection, context restoration, actual Celery eager execution and unchanged original task ASTs. The MySQL bridge oracle runs only on uniquely named isolated localhost schemas and uses fake external publications. Current Python dependency audit reports no known vulnerabilities; this is not a claim of deployed-provider.
