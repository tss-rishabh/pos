# W12 report: strict request validation (E2) and trace propagation (E3)

Branch `w12/validation-tracing`, from integration head `43613a75`. Implementation and tests are
committed in small commits. Six sub-workers had exclusive file sets for the route conversion,
and W12 integrated and committed their work.

## 1. Route coverage

`tests/route-validation.test.ts` builds the real app with stubbed database pools and records every
route through a Fastify `onRoute` hook (`registeredRoutes`, `src/domain/route-validation.ts`). It
fails when a route lacks validation for an input it accepts.

| Rule | Enforcement |
|---|---|
| `params` | Required when the URL has `:param`/`*`. Must be a strict object whose keys equal the URL parameters exactly |
| `querystring` | Required on every route. Strict object; `noQuery` when the route takes no query |
| `body` | Required on POST/PUT/PATCH/DELETE. `noBody` (null or `{}`) when the route reads none |
| `headers` | Required on every route. Must declare every header the handler reads (`request.headers['x-…']` / `.name`, found by scanning the handler source) |
| Depth | Every object reachable from params/query/body must be strict. No `any`/`unknown` may be reachable, including through arrays, records, unions, pipes and intersections |

**Result: 335/335 registered routes (HEAD/OPTIONS excluded) pass. 334 are fully strict and 1 is a
documented exception.** This covers webhooks and service endpoints: courier/notify webhooks,
API-v2 `auto-hl-order`/`webhook-cancelled-order`, scheduled-report service routes, offline sync,
public application-link routes, and health checks.

Mechanics:
- `routeSchema({...})` returns `{ schema, validatorCompiler }`, so a route also validates in a
  bare Fastify test app. `registerRouteValidation(app)` sets the same compiler app-wide.
- The validator returns the original value, so handler behaviour does not change. Handlers keep
  parsing with the same hoisted schema constants, which keeps transforms and defaults where they
  were.
- Validation runs in Fastify's validation phase: after `onRequest` (origin check, trace),
  **before** the session `preHandler`. An unauthenticated request with an invalid shape therefore
  gets 400, not 401. The response never echoes values (§2).

## 2. Exceptions

| Route / part | Reason |
|---|---|
| All `headers` schemas are loose (`z.looseObject`) | Browsers, Electron and proxies add transport headers (user agent, cookies, fetch metadata, forwarding). Only the headers a route consumes are declared and validated |
| `GET /user_to_app` query strips unknown keys | Customer QR codes are already printed and are opened by third-party scanners that can append parameters. Legacy `UserToApp` (`core/views.py:3182`) reads only `store_id`. `store_id` itself is strictly validated |
| Legacy-fulfillment `auto-hl-order`, `webhook-cancelled-order` body | Declared as a strict `record<string,string>` of the form fields. The handlers keep their legacy passthrough parse, because legacy reads named `request.POST` keys and ignores the rest |
| Fulfillment raw-string webhooks | The body is declared as `z.string().max(256000).nullable()`, which is exactly what the raw content parser produces. The handler parses the JSON as before |

### Behaviour changes from strictness (no client affected)
- GET routes that used to ignore their query string now reject unknown keys. The frontend and
  Electron callers were checked and send none.
- Query keys declared so existing clients keep working: `v` (64-hex cache revision) on
  `GET /admin/stores/:storeId/image/content`, `GET /admin/operators/:operatorId/profile/images/:kind`
  and `GET /api/v1/operators/current/profile/images/:kind`. The last one rejected `v` before this
  change, so declaring it also fixes a latent bug.
- Slack OAuth callback: accepts only `code`, `state` and `error`. Bad input now gets a JSON 400
  instead of the popup page.
- Offline sync: a malformed `X-Operator-Id` now gets 400 `INVALID_REQUEST` instead of 409.
- Fastify keeps validated headers separately, so writing to `request.headers` after validation has
  no effect. No source code does this. One websocket test fixture now writes to `request.raw.headers`.

## 3. Error mapping (S4)

The error handler is in `src/observability/errors.ts` (`mapError`), wired in `src/app.ts`. Every
error uses the envelope `{ error: { code, message, requestId, fields? } }`, and `requestId` also
appears in the `X-Request-Id` response header.

| Source | Status | Code | Message |
|---|---|---|---|
| ZodError (declared schema or handler parse) | 400 | `INVALID_REQUEST` | "Some request fields are missing or invalid." `fields[]` holds `{path, code, message}`: messages come from a fixed table, record keys are replaced by `*`, and no value or unknown key name is included. Messages from our own `refine` checks are authored text and are kept |
| `AppError` | its status | its code | its message (module-authored) |
| MySQL `ER_DUP_ENTRY` | 409 | `DUPLICATE_RECORD` | clear retry text |
| `ER_LOCK_DEADLOCK` | 409 | `CONCURRENT_UPDATE` | |
| `ER_LOCK_WAIT_TIMEOUT` | 423 | `RESOURCE_LOCKED` | |
| `ER_NO_REFERENCED_ROW_2` / `ER_ROW_IS_REFERENCED_2` | 409 | `REFERENCED_RECORD_MISSING` / `RECORD_IN_USE` | |
| `ER_CON_COUNT_ERROR`, `PROTOCOL_CONNECTION_LOST`, `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET` | 503 | `DEPENDENCY_UNAVAILABLE` | |
| Fastify 4xx (malformed JSON 400, 401, 403, 404, 405, 406, 409, 413, 414, 415, 423, 429, 431) | same | `INVALID_REQUEST`, `NOT_FOUND`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `RATE_LIMITED`, … | per-status text |
| Unknown route | 404 | `NOT_FOUND` | Custom not-found handler. Fastify's default echoes the method and URL, including query values |
| Anything else | 500 | `INTERNAL_ERROR` | "The request could not be completed." |

- Driver codes are found on the error or its `cause` chain (drizzle wraps them).
- SQL text, parameters, `sqlMessage` and provider bodies are never returned or logged. The log
  carries only the code (for example `ER_PARSE_ERROR`) as `errorCode`.
- 5xx responses are logged at error level. Every response's completion event carries its
  `errorCode`.

## 4. Trace fields and propagation

`src/observability/context.ts` keeps an AsyncLocalStorage context of
`{ traceId, requestId, userId, module, resource }`. `traceId` always equals `requestId`.

- **Inbound:** `genReqId: requestIdFor` reuses `X-Request-Id` only when it is a UUID; otherwise it
  generates one. The ID is returned in the `X-Request-Id` header and in every error body, and CORS
  exposes the header.
- **Logs:** `src/observability/logger.ts` (`applicationLogger`, used by `app.ts` and the job worker)
  adds the following to every line through a mixin: `traceId`, `requestId`, `module`, `resource`,
  `userId`, `eventInstanceId` (fresh UUID), and a default `eventId` of `<module>.<resource>.log`.
  - Registered resource events (`events.ts` `requestEvent`, auth/job/fulfillment event helpers)
    pass their own `eventId`, which takes priority.
  - When an event names its own `requestId`, `traceId` follows it.
  - Every service method logs through `app.log` and its children, so every method's lines carry
    the trace. There is no `console.*` in `src`.
- **Jobs:** verified. `redisJobProducer` records `requestId`/`userId` from the context at enqueue,
  and `jobWorker` restores them with `withRequestTrace`. The worker now uses the shared logger, so
  handler lines carry the originating trace, and worker lifecycle lines fall back to the run ID.
- **Outbound HTTP:** `tracedFetch` adds `X-Request-Id` (unless already set) inside a request or job
  context. It is the default or injected fetch for the following:
  - API-v2: checkout gateway, `upstream.ts`, customer lookup, customer OTP, cancellations,
    returns/exchanges gateway, order pushes, `omnichannel-sms`, global vouchers,
    legacy-fulfillment gateway, ecommerce `syncproduct`, application-link dynamic link
  - mailr/MJML (returns, fulfillment effects, invoice WhatsApp)
  - internal services: invoice renderer, sync-repo order status, product sync (app, worker and
    admin jobs), inventory sync, customer insight/benefits

  The following are **not sent the header**, because whether they accept it is unverified; they
  are correlated through trace-stamped logs only:
  - Gupshup SMS/WhatsApp and Netcore email (`auth/delivery.ts`, discount mail, gift-card mail)
  - Slack (webhooks, OAuth)
  - Freshdesk
  - payment providers (Paytm, Pine Labs)
  - BigQuery and S3 (SDK clients)
- **Database errors:** no module logs SQL. A failure reaches the error handler and is logged with
  the request trace and the driver code only.
- **Frontend:** `src/api/client.ts` sends a fresh UUID per logical request.
  `request(..., { requestId })` or an explicit header reuses an ID, and draft replays reuse the
  mutation ID across retries. The admin form submitter and the public application-link calls also
  send it.
- **Electron:**
  - The preload creates a UUID `requestId` per IPC call. `dispatchIpc` adopts it as `traceId`
    when it is a valid UUID.
  - Sync, heartbeat and catalog calls send `X-Request-Id` (`runtime.ts`, `net.request`).
  - Log lines now also carry `requestId`, `resource` (the channel), `eventInstanceId` and
    `userId: null`.

## 5. Redaction rules

pino `redact` with `remove: true` (`redactPaths`) applies at the top level and at one and two
levels of nesting. It covers:
- **Credentials:** password variants, `otp`, `totp`, `secret`, `token`, `accessToken`,
  `refreshToken`, `apiKey`/`appkey`, `serviceKey`, `authorization`, `cookie(s)`, `set-cookie`,
  `x-api-key`, `jwt`, `signature`, `credentials`
- **Personal data:** `phone`, `telephone`, `mobile`, `contact`, `email`, first/last/customer
  name, `address`, `pincode`, `gstin`
- **Raw inputs and SQL:** `body`, `payload`, `query`, `querystring`, `params`, `headers`, `url`,
  `sql`, `sqlMessage`, `parameters`, `values`, `response`, `request`, `cause`, `stack`, `config`

The serializers reduce `req` to `{}`, `res` to `{statusCode}` and `err` to a fixed generic object.
Request logging by Fastify stays disabled.

Tests:
- `tests/observability/log-redaction.test.ts`:
  - logs a login request carrying an email, phone, password, OTP, bearer token and cookie in the
    body, query and headers, plus a SQL failure, and asserts none of them appear in the logs;
  - asserts every line carries `traceId === requestId ===` the inbound UUID, plus `module`,
    `resource`, `eventId`, `eventInstanceId` and `userId`;
  - logs sensitive keys directly and checks they are removed while the active trace is stamped;
  - checks that a forged `X-Request-Id` is replaced;
  - checks that `tracedFetch` sends the header only inside a context.
- The existing `logging.test.ts` and `observability/request-privacy.test.ts` still pass.

## 6. Frontend / Electron changes
- `frontend/src/api/client.ts`:
  - adds `X-Request-Id`, the `requestId` option, `newRequestId`, `serverRequestId` and
    `errorRequestId`;
  - `ApiError.requestId` is taken from the body, else the `X-Request-Id` response header, else the
    ID that was sent.
- `frontend/src/components/common.tsx`: `ErrorState` renders `RequestReference`, which shows
  "Reference `<uuid>`" (selectable) for API errors. `CheckoutReview` already showed it.
- `frontend/src/offline/sync.ts`: draft replays use the mutation ID as the request ID (one-line
  call-site change).
- `frontend/src/pages/administration/api.ts` and `application-links/api.ts`: these use `fetch`
  directly, so they now send the ID and surface the server ID.
- `frontend/electron/offline/runtime.ts`: log fields as listed in §4.
- IPC validation was verified and needed no change:
  - Every channel is registered only through `registerOfflineIpc`. `dispatchIpc` validates the
    strict envelope `{requestId: uuid, payload}` and then the channel's schema in
    `ipcRequestSchemas` (strict objects).
  - Untrusted senders are refused.
  - `main.cjs` registers no `ipcMain` handlers.
  - `preload.cjs` allow-lists the channels.
- Test: `frontend/tests/request-id.test.ts`.

## 7. Shared-file edits and outside-ownership fixes
- `src/app.ts`:
  - registers validation and the logger;
  - uses `genReqId`;
  - adds the error and not-found handlers;
  - CORS exposes `X-Request-Id`;
  - declares schemas on its own routes;
  - injects `tracedFetch` into product sync.
- `src/jobs/worker-main.ts` and `src/jobs/handlers.ts`: shared logger and `tracedFetch` only.
  `contract.ts` is untouched.
- Adapter default-fetch swaps: the files listed in §4.
- `tools/administration/model-accounts/fixture.ts`: removed an unused import that already failed
  `eslint .` at `43613a75`.
- Test updates:
  - **Expectations now include `traceId`:** `observability-context.test.ts` and
    `jobs/queue.redis.test.ts`.
  - **Setup only, `registerRouteValidation(app)` in bare-app setups:** checkout routes,
    checkout-performance, motivational quotes, and 10 MySQL-gated suites. These are now redundant
    with `routeSchema`'s per-route compiler, but harmless.
  - **Inputs changed so validation passes and the original assertion is still reached:**
    `operational-reports/security.test.ts`.
  - **Fixture:** `fulfillment/security.test.ts` now writes to `raw.headers`.
  - No assertion was weakened.

## 8. Results
- Backend:
  - `tsc --noEmit` passes and `eslint .` is clean.
  - `vitest`: 156 files passed, 45 skipped (MySQL-gated). 668 tests passed, 386 skipped.
  - `route-validation`: 335/335.
- Frontend:
  - `tsc --noEmit` (app and electron) passes and `eslint .` is clean.
  - `vitest`: 57 files passed, 15 skipped. 294 tests passed.
  - Offline billing: 48 tests passed.

## 9. Leftovers and candidate security decisions
- About 42 inline error renderings in page files outside W12 ownership still show
  `error.message` without the reference. `ErrorState` and checkout review show it. These pages can
  adopt `<RequestReference error={…} />`.
- The MySQL-gated suites were not run in this phase. Sub-workers added only setup lines to them.
- BigQuery receives no trace. Query job `labels` could carry `request_id`, which needs a warehouse
  change (W11 area).
- `frontend/src/pages/checkout/client.ts` `lookupCustomers` sends `{ query, counterId }`. The
  backend rejected this before W12 too, and the call looks unused; flagged for the checkout owner.
- **Candidate decisions for `security-decisions.md`:** these are for the primary agent to number;
  W12 did not edit that file.
  - (a) Validation precedes authentication, so the schema shape is visible to unauthenticated
    callers and no values are echoed.
  - (b) An inbound `X-Request-Id` is honoured only when it is a UUID.
  - (c) The default 404 body no longer echoes the URL.
  - (d) MySQL driver errors are mapped to 409/423/503 with no SQL text.
  - (e) `X-Request-Id` is withheld from third-party providers.
