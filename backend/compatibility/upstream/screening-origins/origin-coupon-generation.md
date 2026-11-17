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
