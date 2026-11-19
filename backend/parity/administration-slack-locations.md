# Store Slack OAuth and postal location reconstruction

Source baseline is `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`: `stores/views.py:316 SlackConnectView` / `:328 SlackCallbackView`, `helpers/slack_helpers.py` and `core/views.py:3358 GetLocationByPincodeView`. These components add six explicitly traced APIs. The subsequent activity-history slice brings the complete owned administration surface to109 declarations/20 feature groups; full legacy-route certifications remain zero.

## Slack connect (store form popup)

Legacy: `stores/views.py:310-347`, `helpers/slack_helpers.py`, `_form.html:305-345`,
`slack_callback.html`. The store form's "Connect/Reconnect Slack channel" button opens a popup;
the callback page posts `{ok, error, url, channel, nonce}` over BroadcastChannel
`tss-slack-connect`, the form fills `slack_group_url`, and the operator must click Save.

Rewrite (W8a):
- `GET /api/v1/admin/slack/connect?nonce=` (roles 1/3, current writer role) → 302 to
  `https://slack.com/oauth/v2/authorize` (client_id, scope `incoming-webhook`, redirect_uri, state).
- `GET /api/v1/admin/slack/oauth/callback` renders the popup page (inline script allowed only by
  its CSP hash) that broadcasts the result and closes on success.
- State: Redis `pos:slack_oauth:{sha256(state)}` → JSON `{userId, nonce, sessionBinding}`, EX 600,
  `SET NX`, consumed once with compare-and-delete. Legacy used a stateless Django-signed token
  `{user_id, nonce}` (max_age 600); single use and session binding are a security tightening.
- Settings: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, optional `SLACK_OAUTH_REDIRECT_URI` (default
  `WEB_ORIGIN` + callback path; must be this application's callback). `SLACK_OAUTH_ENABLED` and
  `SLACK_OAUTH_TEAM_IDS` were removed. Exchange: 10 s POST to `oauth.v2.access` (client
  credentials as HTTP Basic instead of form fields), redirects refused, 32 KiB bound.
- Nothing is written to `stores` by the connect flow. `pos_rewrite_slack_connections` is no longer
  used; `pruneSlackConnections` is a no-op kept for `src/auth/security-worker.ts`.
- `slack_group_url` in the form: any text ≤1000 characters, displayed, blank create stores `''`,
  blank edit clears to `''` (Django `TextField.formfield()` → `CharField(empty_value='')`).

| Case | Legacy text | Rewrite |
|---|---|---|
| App not configured | "Slack app is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET." | same (popup page) |
| Bad/expired/reused state | "Slack connect link expired or is invalid. Please try again." | same |
| Other user / other session | "Slack connect was started by a different user. Please try again." | same |
| Slack `error` param | "Slack connect cancelled: {error}" | same (escaped) |
| Network/JSON failure | "Could not reach Slack. Please try again." | same |
| Rejected / no webhook | "Slack connect failed: {error or 'no webhook returned'}" | same; error echoed only when it is a Slack error code `[a-z0-9_]{1,64}`, and a non-`hooks.slack.com` webhook counts as "no webhook returned" |
| Popup blocked | "Popup blocked. Allow popups for this site and try again." | same |
| Success | "Connected to {channel}. Click Save to apply." | same |
| Field too long | "Ensure this value has at most 1000 characters (it has N)." | 400 `fields.slack_group_url`, same |

## Location lookup

`location-schema.ts` contains read-only projections checked against `evidence/mysql-extra-schema.json`: `deliverable_pincodes.id` BIGINT, pincode VARCHAR32/nonunique index, Latin1 city VARCHAR20, INT zone/country references and string coordinates; zones.id is INT. It creates no legacy DDL. `POST /api/v1/locations/postal-code-lookups` accepts a bounded postal string in its body, requires an authenticated POS role and returns no-store. Active master-data lookup uses the primary reader, not report readers. The ORM query binds pincode equality, joins zone/country PKs and preserves source country/state labels and coordinate strings. It does not filter country/zone status because the source does not. Missing joins/unknown postal values return null, replacing the source empty object.

The physical pincode index is nonunique. Source `LIMIT1` has no explicit ordering; the rewrite explicitly selects lowest PK for a stable duplicate tie. An isolated native MySQL test executes the extracted source SQL with only the DB-driver `%s`→`?` placeholder adaptation, compares its chosen fixture row/DTO and exercises IDs above2^53. This demonstrates tested duplicate behavior, not a guarantee about every production source plan. Representative duplicate reconciliation remains required before full parity certification. Existing index `(pincode)` already carries the InnoDB PK and avoids adding a redundant `(pincode,id)` index.

`sourceCityTitle` preserves native Python cased-character boundaries, Latin1 case expansions, title-case exceptions and final sigma, with a small generated exception map recording Unicode version. The hash-verified source `get` method is executed across270 city vectors. The source AST is cached only within that isolated oracle process to avoid reparsing a large module for each case. The store form looks the PIN up automatically 400 ms after a 6-character value (`create.html:186-216`) and fills the read-only city/state, the disabled country name and the hidden country_id/state_id plus latitude/longitude; no data leaves the form unchanged. The lookup uses a POST body (keeps PIN codes out of access-log URLs). Validation supports bounded international postal forms as the physical VARCHAR32 contract permits; the existing store field retains its source10-character capacity.

## Executed evidence and limits

Owned backend119 checks pass, including79 real isolated MySQL workflows. Owned frontend23 checks pass, including17 headless Chromium workflows. New evidence includes native session/actor/store/version binding, exact-once callback claim/replay, after-exchange revocation/cancel fencing, expiry/prune, webhook secrecy, source authorize helper parameters, source postal SQL/DTO/title cases, same-window synthetic provider approval/return and body-only form autofill. No live Slack exchange, webhook send, production DB mutation or app configuration change occurred. Full configured Slack web/desktop acceptance, representative deployed postal duplicate comparison and complete source user-visible workflow certification remain open.
