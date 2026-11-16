# Customer workspace reconstruction

Source baseline: `backend-pos-web@78d5b63d6a149a6bf2c748fa1d191799c59ecb8a`.
This is component evidence and an explicit remaining-feature map. It is not a
full source route or production-data parity certificate.

## Current profile view and edits

The current checkout can read its attached customer through
`GET /api/v1/stores/:storeId/checkout-sessions/:checkoutId/customer-profile`.
The target comes from the persisted, operator-owned checkout; no arbitrary
customer selector or contact query is accepted. Current writer locks authorize
the operator/check-in, store/counter and active customer. Profile fields use the
primary reader. The endpoint returns only the selected name, email, telephone,
gender, birthday, anniversary, customer type and GSTIN fields, with a revision
hash and checkout version. It never returns authentication secrets or wallet
records. Legacy zero/partial dates normalize to missing values.

The checkout panel loads on explicit expansion, checks the unexpired cached
operator/store session before and after the response, rejects changed
customer/version scope, aborts an old operator response, renders text through
React and hides private data offline. Profile data is not persisted in IndexedDB
or localStorage. HTTP is private/no-store and the service-worker API exclusion
remains in force. Application events use the shared module/resource/request/
operator/event IDs; profile values and raw exceptions are never logged.

`POST .../customer-profile-adjustments` accepts a UUID, checkout version,
profile revision and a strict partial change to birthday, anniversary, gender,
customer type or GSTIN. `GET .../customer-profile-adjustments/:operationId`
confirms the saved command. The customer comes from the checkout, with current
check-in/store/counter/operator/customer checks and a writer row lock. A stale
primary-reader profile cannot overwrite newer writer fields. The profile,
minimal HMAC-bound receipt and checkout version/quote invalidation commit in one
transaction. Exact retries reuse their receipt; another intent cannot reuse the
UUID. The receipt contains field names and revision hashes, with no contact or
date values. Date/gender edits preserve Django's updated_at behavior; the source
business-field-only SQL leaves that timestamp unchanged.

Real MySQL DATE validation rejects invalid/zero dates and unsupported years;
the source UI's15-character alphanumeric GSTIN rule is enforced server-side.
Non-editable/busy/pending-import checkouts cannot change profiles. Inputs cannot
change contact/login identity, wallets or customer verification. The refreshed
quote remains subject to exact discount approval terms. Editing stays unavailable
until the private fresh-customer-context contract is configured. The UI keeps
an unconfirmed command immutable in memory through offline hiding, reconciles
with GET and offers an explicit exact retry. A confirmed write with a failed
refresh only offers refresh. Normal checkout actions stay disabled meanwhile.

The source AuthHandler's Redis user snapshot requires the separate reviewed
API-v2 candidate in `compatibility/upstream/customer-context/README.md`. Both cart
mutators and validate/process/order calls use its private writer-current context;
the Node gateway verifies signed customer identity and response binding. This
does not replace the independent financial row locks/projection proofs.

Twenty-three checks in `tests/customer-profile.mysql.integration.test.ts` cover verified
physical columns, current writer authority and primary-reader results, blocked
customers, guessed checkout scope, stale principals, franchise role1 restrictions,
archived stores/inactive counters, dates and revision changes,20 concurrent exact
replays, competing edits, late rollback, the actual pinned property/business
methods, current benefits and network-time authority changes. Twenty use native isolated MySQL.
Seventeen real Chromium
workflows in `frontend/tests/customer-profile/browser.test.ts` cover escaped
hostile text, offline hiding, cached-session expiry, mismatched targets and
operator changes during a pending response, exact mutation recovery, complete
briefing rendering and scoped memory caching. MySQL fixtures are uniquely named
local databases; browser HTTP is synthetic.

## Current benefits

`GET .../customer-benefits` derives the attached customer from the same owned
checkout. A single primary-reader ORM projection joins the unique membership
and user-addons keys and counts status1 vouchers through the recipient index.
The metadata is `evidence/mysql-customer-benefit-schema.json`:4 complete tables,
defaults, collations, indexes and foreign keys, inspected read-only. No voucher
codes, authentication signatures or financial ledger rows are selected.

The email predicates stay bound parameters. Joining users.email directly to
the latin1 membership column would change its collation semantics. A native
accented-email case proves the distinct source comparison. Vouchers retain the
source's status-only rule, including an expired but still active voucher.
Membership activity remains independent of its parsed expiry; all3 source date
formats, fractional seconds and non-padded components are replayed. Wallet
display uses the source minimum-one guard followed by decimal truncation.

The app flag uses the unique user_addons.user_id mapping. App cashback preserves
TEN_PER_SWITCH, the last app campaign's status and the storefront-user exclusion.
CMS reads contain no customer data, use a5-second timeout and a bounded body,
coalesce concurrent requests and cache successful results30 seconds. A failed
provider lookup displays unavailable rather than promising eligibility. Pricing
and benefit application retain their independent writer/upstream validation.

Writer locks are released before CMS I/O and current operator/store/counter,
customer/contact/platform and checkout version are rechecked before publishing.
The panel reads on expansion, rejects stale targets, hides offline and persists
no customer benefits in browser storage. The5 source-helper/provider checks
execute28 vectors from the actual pinned methods;4 further native cases and4
Chromium cases cover scope, collation, no mutation and late-response handling.

## Customer briefing

`GET .../customer-insights` uses only the attached customer. It releases all SQL
locks before calling the provider, then rechecks current access, checkout version,
customer and contact fingerprint before publishing. The provider lookup preserves
the source's contact-first rule and never combines its service ID with a contact.
The response wrapper binds the POS customer separately from the provider's ID.
Flat/success envelopes, explicit-false errors and every displayed source field
are handled: occasion/segment/membership, visits, spend/tenure, usual/recent sizes,
recommendations, product thumbnails, per-size or aggregate stock and action notes.
JSON/arrays/text/numbers are bounded and images use exact approved HTTPS origins.
Raw provider errors never reach logs or the browser. Four gateway checks exercise
these contracts and reject missing proof/oversized/invalid/provider failures.

The optional panel uses a3-minute operator/store/checkout/customer/version-scoped
memory cache, hover/focus prefetch, session checks, escaped React text and no
browser persistence. Provider failure affects the panel only; it cannot stop a
sale. Private fields are hidden offline. It is disabled until its private
provider explicitly attests `pos-customer-insights-bigquery-private-v1` and its
deployment is accepted: all historical reads must use verified BigQuery data,
and ingress/application logs must omit contact-bearing GET URLs. A response
marker alone does not establish that deployment proof. The new read-only raw
BigQuery account supplies metadata for further validation; it does not certify
an unknown provider's pipeline. No historical MySQL fallback is present.

## Source surfaces and remaining work

| Source surface                                                  | Actual behavior to preserve or review                                                                                                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users/views.py:AjaxUserDetailsView`                            | Current membership/app eligibility implemented in scoped benefits; ordinary customer registration/lookup/attach/verification is separately owned by checkout                                               |
| `users/views.py:AjaxUserUpdateView`                             | Implemented scoped customer_type/GSTIN edits; parsed source name/email/telephone inputs are unused                                                                                                         |
| `users/views.py:AjaxUpdateEndUserDataView`                      | Implemented scoped birthday, anniversary and gender edits                                                                                                                                                  |
| `order/views.py:AjaxUpdateUserMobile` and `AjaxUpdateUserEmail` | Separate active contact updates in order routes59–60; uniqueness, identity proof and checkout/verification invalidation need explicit safe integration                                                     |
| `users/views.py:AjaxCustomerInsightView`                        | Best-effort private briefing-service proxy, contact-first lookup (service user IDs can differ), store allowlist, success-envelope unwrapping and nonblocking failure                                       |
| `order/templates/order/create_order.html:8199`                  | Scoped3-minute briefing cache/prefetch; customer/occasion/segment, visits/spend/tenure, usual/recent sizes, recommendations, per-size store/online stock, operational action notes and escaped images/text |
| `users/views.py:AjaxUserbehaviourView`                          | Current customer facts plus lifetime/month/order/return/NPS/voucher/membership aggregates and last-five orders; historical reads require verified BigQuery publication with no historical MySQL fallback   |

The profile view/edits and full insights panel are wired with component evidence.
Provider deployment/data acceptance, contact changes and customer-behavior
history remain in progress. No unsafe source contact
write, source SQL interpolation, PII console print, guessed service/warehouse
mapping or historical MySQL fallback has been enabled by this slice.
