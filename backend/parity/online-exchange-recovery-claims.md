# Immutable exchange recovery claim outcomes

The previous recovery UI could lose a committed claim response, renew customer verification, then reconstruct the old POST with a different verification UUID. The command hash correctly rejected that changed body, but the UI cleared the pending reference on409 without first reading its original outcome.

The recovery claim now writes `pos_rewrite_exchange_recovery_claims` atomically with the metadata-only claim/adoption transaction. This immutable receipt binds command UUID, actor/store/order/HP line, original counter/proof, request hash/revision and resulting operation UUID. It stores no customer profile, comment, provider payload, OTP or credentials. Later handoffs update the operation's current authority without overwriting earlier command receipts.

`GET /api/v1/stores/:storeId/orders/:orderId/line-items/:lineId/exchange-recovery-claims/:claimId` takes the current counter and current customer-verification UUID. It obtains the normal writer/current-actor/store/check-in/order/HP locks and verifies the original order customer before reading a minimal recorded/not-recorded outcome. An actor cannot use another actor's receipt as an outcome oracle. A receipt's original proof may expire: a new valid purpose-bound proof can read it, while missing/expired proof, cleared check-in or revoked actor refuses. Returned operation binding is checked against the current native order/customer/line. The outcome read invokes no provider, return, refund or stock operation.

The UI retains the original command counter/proof and command identifiers across renewal, keeps unknown outcomes on409, offers explicit verification renewal, and uses GET for “Check original recovery claim”. It clears a pending command only after an authoritative outcome read or its successful original POST response. A fresh authority claim remains explicit; a status read does not silently issue a new POST. Pre-receipt legacy state is not given fabricated historical acknowledgements; existing active operation/revision checks still prevent a fresh financial operation from replacing it.

## Deployment and changes

Apply `src/modules/checkout/return-workflow/recovery-claims-migration.sql` through the ordinary controlled writer migration flow, registered immediately after0004_returns. No live migration was executed here. The API writes/reads only this rewrite-owned receipt table; it does not modify source credit/stock history during a claim-status read. Existing original financial counter and current retry actor rules remain unchanged.

Production implementation was authored in `50e2129`, then merged with Root `e9c6558` in isolated merge `ad06427`. This follow-up adds the migration to the focused native fixture, preserves exact changed-body denial as `IDEMPOTENCY_CONFLICT`, and verifies the integrated code. Frozen r9 or earlier CI is not relabelled as validating this later feature.

## Focused validation

- Backend/frontend TypeScript strict passed; changed-file ESLint passed.
- Frontend entry/selection20 and new transport/persistence3 cases passed. The new client cases verify original command identity survives proof renewal, outcome lookup is GET with current operator/proof and no request body, a changed operator aborts before network, and unexpected response fields are refused. These are explicit client/storage transport carriers, not a full routed-App proof.
- Four selected native cases passed;68 unrelated cases skipped;2.65s. Existing single-event/group/counter-zero/replay cases remain green. The new case uses the **actual** checkInService and native active actors/assignments/counter plus native customer proofs. It covers not-recorded, recorded, missing proof, expired proof, renewed proof, a different authorized operator's later handoff, earlier receipt retention, cleared check-in and native operator revocation. It confirms no additional provider dispatch or credit note. The old fixture's provider/OTP delivery remains an explicit synthetic carrier; no live-provider or full-App admission follows.
- Actual production Vite build passed with explicit `NODE_ENV=production`.

The first combined attempt failed only because a synthetic HP ID overlapped the preceding duplicate-line fixture. The new isolated test order was changed from9223 to9240; no deadline, count or business assertion was weakened. Retained failed log `/tmp/pos-recovery-receipts-native-20261118.log`; affected-case diagnostic `/tmp/pos-recovery-receipts-native-newcase-20261118.log`; final four-case log `/tmp/pos-recovery-receipts-native-final-20261118.log`; final client log `/tmp/pos-recovery-receipts-client-final-20261118.log`; build log `/tmp/pos-recovery-receipts-build-20261118.log`. Exact current input/log digests are in the adjacent evidence receipt.

Owned fixture `909d0b3ce0e15d3aea39f174dcd1e1c4913797221ee8cec7eb41741f8fd98942`, label `pos.owner=recovery-receipts-20261118`, pinned image `mysql@sha256:ccb8f749bb5e59f9f8f03bf7282c7ef27a93a1814a24f0a8a926fb4e19b7fb97`,2CPU/2GiB/tmpfs. Exact ID/label verified, `docker rm -fv` completed and exact-ID lookup was absent. No active owned DB/browser jobs remain.

## Pending boundaries

The approved new-exchange-only Product type8 guard, remaining mixed/unassigned legacy restoration provenance, actual Google SDK synthetic publication transport, and whole online template/provider/App parity are separate unfinished work. This bounded integration changes none of those scopes and does not certify the whole source workflow or production deployment.
