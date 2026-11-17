# Genuine-origin coupon publication

Apply the additive `origin-coupon-generation-migration.sql` through the reviewed migration workflow. This queue stores authenticated encrypted demands, deduplicated by generic customer/coupon/configuration/day plus exact mutation-head witness. Admission is a leaf database operation; it performs no source capture or warehouse write.

The history receiver supplies `originCouponDemandJournal(db, { journalKey, originKey })` as `originCouponHistory(..., { demand, ...readerDependencies })`. An incomplete publication can enqueue the genuine PREPARED source command. Commands, source order dispatch, CSV operations and Node checkout capabilities are never synthesized.

The existing generic coupon publisher worker composes `originCouponPublishingRuntime(env, { db, journalKey, sourceKey, publicationKey, publisher, enabled })` and awaits its `drain(signal)` before the generic publisher's ordinary immutable-job drain. `publisher` is the already composed genuine generic publisher. Readonly capture may repeat after a claim expires; its native generation journal creation and demand bind share one transaction. The existing generic publisher owns all materialization/publication jobs and original-job unknown recovery.

Configuration is explicit:

- `POS_SCREENING_ORIGIN_COUPON_DEMAND_CONTRACT=pos-screening-origin-coupon-demands-v1`
- `POS_SCREENING_ORIGIN_COUPON_CONTROLS_URL=https://<source>/internal/screening-origins/coupons/controls/`
- `POS_SCREENING_ORIGIN_COUPON_CONTROLS_KEY`: distinct printable 32–4096 byte key, also installed on the source controls route.

The GET-only controls route accepts one exact coupon ID and returns current controls signed by the existing generic source key. It has no customer, historical query, financial adapter, SDK writer or constructor I/O. The worker refuses changed generic heads/configuration/day. The source takes the three shared Redis controls in one MGET before SQL and retains the signed bounded snapshot through execution.

Manual coupons whose pinned source branch needs only current controls receive no history document. Their receipts explicitly say `historyRequirement: current-controls` and `history: null`; unexpected historical queries fail closed. Historical branches retain `bigquery` evidence. Source selection and evidence expire before native validation and outer commit. Safe exception cleanup requires the exact owned savepoint rollback, unchanged PREPARED ledger, absent native effects, cleared session owner and clean ORM state before removing the commit guard.

No migration, provider call or production action is performed by adding these files. Validation is deferred until the complete implementation is ready, as requested.

## Genuine cart preview

`originCouponPreviewHistory` and `registerOriginCouponPreviewBridge` serve the separate private `/internal/screening-origins/coupon-preview` route. The strict request carries a server-issued shared preview and its proof, coupon selection and exact witness. The transport adds `issuedAt` and `expiresAt` (at most 30 seconds and bounded by preview expiry), authenticated with purpose `coupon-preview-request`. The returned `pos-screening-origin-coupon-preview-v1` document is signed with purpose `coupon-preview`. The reader uses only the existing bounded readonly generation runner and generic publication proof. Missing publications enqueue the preview itself through the same encrypted generic-scope demand queue.

The source owner enters `coupon_preview_scope(coupons, session, preview, preview_proof, kind, namespace, snapshot, documents, cart_meta=...)` inside its owned rollback transaction after genuine source authentication/current namespace CAS. `NeedCouponPreview` unwinds the transaction and carries the strict four-field `.request`; the owner calls its separate preview provider outside SQL, caches the document under `digest(originKey, 'coupon-preview-request', request)`, and retries the same signed preview. Coupon selection time is frozen at `preview.issuedAt` for stable retry identity. The scope never manufactures an order command, claim, source write or head-owner exemption. Original coupon helpers replay only qualified facts; birthday cache changes remain local to the preview. Current-only branches need no history document. The owner must roll back all original preview SQL effects and recheck the authenticated namespace before returning the cart result.

## Native metadata boundary

All three Node native coupon capture ports (`couponGenerationSource`, `couponHistorySourceCapture`, and `couponWarehouseSourceControls`) require explicit `headMetadata` options before capture. They use the shared `readNativeHeadMetadata` approved definer descriptor and full privilege audit, then qualify all ten normalized coupon trigger hashes against the existing writer manifest. They no longer read `information_schema.TRIGGERS` as an application/publisher principal or require application TRIGGER privileges. Native identity, mutation heads, comparison controls, facts and snapshot behavior remain qualified independently.

The runnable generic publisher configuration returns `sourceOptions.headMetadata` from `readNativeHeadMetadataOptions(env)` when new work is enabled. Its existing factory already accepts `sourceOptions`; the runnable composition must forward `installation.sourceOptions` explicitly. Recovery alone does not demand new-work metadata configuration. These metadata reads remain local SQL; no Python or HTTP call occurs inside capture transactions.
