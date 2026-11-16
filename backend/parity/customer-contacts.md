# Add missing customer contact

Source baselines: POS `78d5b63d6a149a6bf2c748fa1d191799c59ecb8a` and API-v2 `2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. `compatibility/customer-contacts/source-manifest.json` pins the source files. No source sibling or deployed service was modified.

## Scope and behavior

The source POS Add Mobile control is hidden when `users.telephone` is truthy. Add Email handles the `temp.id` membership placeholder. Its raw handlers (`order/views.py:3369`, `:3385`) accept an arbitrary customer ID without proof or checkout binding. The replacement adds only missing contacts to the current operator-owned checkout/customer. It requires proof of a reachable existing real contact and then of the new contact. It does not provide arbitrary account contact replacement or cashier-only recovery of an unreachable account.

The pinned API-v2 account flows establish current-phone proof, new-contact OTP, expiry/attempt/send limits and current-contact binding. Phone defaults remain configurable at six sends/day, three attempts/code and 600 seconds for current-phone proof; email uses five sends/day, five attempts/code and 600 seconds. The new purpose-bound codes are six cryptographically random digits for both stages. Source current-phone codes were four digits. Budgets survive cancelled/replaced requests, use the business date and separate proof stages, and preserve the 30-second resend wait.

Current writer authorization checks the active operator, current auth epoch, store/franchise assignment, actual server check-in, active counter/store and the same persisted checkout/customer. Mutations require an editable sale without an unresolved registration. Proofs bind a current contact fingerprint, monotonic contact revision and operator authentication version. Queued OTPs recheck that authorization before dispatch. Indexed target-conflict reads retain next-key protection under verified REPEATABLE READ/SERIALIZABLE isolation. Physical email/phone indexes are nonunique: cooperating registration/contact mutexes cannot repair independent legacy writers that perform stale or blind contact updates. That coexistence remains a release dependency.

Email commits recheck `users` and `user_eav` conflicts and active employee coupons, update `users.email/is_email_verified`, and atomically carry source membership/Juspay/voucher/welcome/eligible refund references. Shared placeholder email clones membership rows with the source copy audit; shared voucher/welcome references stay on the old address. The source's 55-character welcome boundary and first nondeleted Juspay-record/taken-address behavior remain explicit. Unsupported legacy membership expiry representations fail for review rather than being guessed.

The account update, source `user_detail_logs` audit, contact revision, checkout invalidation, command receipt and sealed source-effect obligation commit in one transaction. The source audit denotes the verified customer (`user_type=2`, `added_by=customerId`); cashier provenance remains in the rewrite proof/outbox. The transaction preserves customer IDs, balances, cart/gift data, salespeople, NPS preferences, settlement note and signed cash history. It clears only the quote, previous customer verification/OTP (including its private contact binding) and registration pointer, reopens the sale and increments its version. The customer must be verified again before account benefits are used. The source telephone helper committed its audit separately; the atomic replacement is a safety correction, not a response-identical query optimization.

`contact-revisions-migration.sql` adds a perpetual per-customer UINT64 revision. Helpers in `revisions.ts` require the existing MUser lock, use a current locking read even under an older repeatable-read snapshot and preserve exact bigint values. Untouched customers start at zero; each committed contact operation increments once, while replay and rollback do not. The row is never reset on contact restoration or archive/reactivation. Checkout/return proof consumers bind this revision plus a native contact digest through their shared authority reader; integration tests belong to the financial module. Already collected cash and immutable committed financial proofs remain retained.

## Routes and frontend

The following resources sit below `/api/v1/stores/:storeId/checkout-sessions/:checkoutId`:

| Method | Resource | Behavior |
| --- | --- | --- |
| GET | `/customer-contacts` | Current capabilities/fingerprint and owned active proof |
| POST | `/customer-contact-challenges` | Queue existing-contact proof |
| GET | `/customer-contact-challenges/:challengeId` | Read current owned proof/delivery state |
| POST | `.../:challengeId/verifications` | Verify the current proof stage |
| POST | `.../:challengeId/resends` | Queue a new bounded code and invalidate the old code |
| POST | `.../:challengeId/commits` | Atomically save the verified missing contact |
| POST | `.../:challengeId/cancellations` | Cancel an uncommitted proof |
| POST | `.../:challengeId/synchronization-retries` | Requeue the same saved effect, without another account write |
| GET | `.../:challengeId/operations/:operationId` | Recover an immutable operation receipt |

Private inputs/codes stay in POST bodies; GET URLs contain only IDs. Responses are private/no-store. All nine routes carry static module/resource/action trace metadata. No body, contact, code, token, provider payload or raw exception enters application logs.

`CustomerContactPanel` keeps private state keyed by operator/store/checkout/customer, remains mounted through busy/version changes and supports GET receipt recovery. A confirmed write refreshes the sale; a failed UI refresh cannot repeat the account update. Captured actor and component abort signals reject late continuations. This account-security operation requires a connection; offline cash functionality is unaffected. Private form values/codes are not persisted in browser storage.

## Delivery and executable evidence

Node uses bounded AES-GCM storage with owner AAD, an explicit 256 KiB bound and MEDIUMTEXT for a full 1,000-refund obligation. OTP delivery persists SENDING before I/O; unknown delivery is never automatically resent, but a legitimately received code can still prove ownership. Saved account effects use an exact idempotent HTTP contract and bounded retry; unreconciled results remain quarantined. Expiry cancels only pending proofs/codes and never deletes a committed account obligation or financial identity.

The separate private bridge durably accepts the exact Node commit/outbox proof into SQLAlchemy receipts/jobs. It records `auth_user:{customerId}` invalidation, payment/Juspay refresh, CleverTap/Netcore profile, MoEngage attributes, support flags and source-selected failed-refund notices. Cache deletion precedes other effects. Provider/broker uncertainty is retained without automatic republishing of task/mail obligations. An accepted bridge receipt proves durable obligations, not completed external CRM work. No real message, broker task, upload or remote DB write was sent in these checks.

Current focused evidence:

- Six real MySQL reference tests include differential execution of pinned Python reference helpers against the same rollback-only source-shaped fixtures, including shared/nonshared membership, Juspay fallback, large IDs, full rollback and the response-preserving refund-index candidate.
- Four native reservation tests cover pending/uncertain/missing owners, expiry and concurrent contact/registration fencing.
- Fourteen native service/worker cases cover both proof stages, add-only validation, durable wrong attempts, auth epoch/franchise guards, atomic rollback, 20 concurrent commits/workers, OTP crash uncertainty, archived stores, bounded expiry, retained saved obligations and rejection of an old proof after contact restoration. One connects the actual committed Node effect to the Python bridge on the same physical MySQL fixture; 20 duplicate accepts/workers produce one receipt and one set of publications.
- Two native revision cases prove current reads after an older repeatable-read snapshot, untouched revision zero and exact increments beyond 2^53. Service cases also assert one increment under replay/concurrency and no increment after rollback.
- Two cipher tests cover a full 1,000-refund payload, owner/key/tag mismatch and bounds.
- Twenty-one Python bridge/privacy/readiness tests pass; the nine actual source-consumer/privacy cases also pass under pinned source Celery 5.3.6/Requests 2.31.0/Python 3.10, as well as the bridge's current pinned environment. An actual Requests Response retains its cached JSON after bounded stream closure; purpose-only task results cannot expose source return values to Celery success diagnostics.
- Seven real Chromium workflows cover email/phone proof, lost create/commit responses, busy GET recovery, durable wrong-attempt refresh, operator switching and offline blocking. Strict backend/frontend configs and lint are checked separately.

These are scoped component proofs, not full deployed parity certification. See `compatibility/customer-contacts/README.md` for the concrete source privacy patch, artifact/worker readiness proof and production dependencies. Live writer/provider configuration, the accepted patched source worker and coexistence fencing still require acceptance; the feature and workers remain disabled by default.
