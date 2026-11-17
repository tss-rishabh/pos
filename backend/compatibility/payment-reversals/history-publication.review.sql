-- REVIEW ONLY; no live DDL or warehouse writes are performed by the app/runner.
-- v1 lacks current return-intent fences and is intentionally not accepted.
-- All source/correction facts require the source publisher's common barrier;
-- independent CDC watermarks or status flags do not prove that barrier.
CREATE TABLE IF NOT EXISTS `approved-project.pos_reporting.payment_correction_publications_v2` (
 generation_id STRING NOT NULL, -- fresh qualification/control seal generation
 data_generation_id STRING NOT NULL, -- immutable source/rollup generation reused explicitly
 kind STRING NOT NULL, -- daily | cash-ledger
 store_id STRING NOT NULL,
 business_date DATE NOT NULL,
 contract STRING NOT NULL, -- pos-payment-correction-finance-publication-v2
 publication_state STRING NOT NULL, -- only COMPLETE may be read
 published_at TIMESTAMP NOT NULL,
 body STRING NOT NULL, -- strict canonical v2 body including dataReference and cashReturnControl
 proof_hash STRING NOT NULL -- purpose HMAC; never publish a signing key
)
PARTITION BY business_date
CLUSTER BY store_id,kind,generation_id;
-- Each qualified generation contains exactly one sealed row per requested
-- (kind,store,date), including explicit zero partitions. No v1/missing row/head
-- or replica/warehouse disagreement is converted to zero.
-- dataReference binds generationId/sourcePosition/cdcWatermark/publishedAt of
-- immutable base facts. Those facts can be reused only after a fresh common
-- source/control barrier proves their baselineHash and correction payload are
-- still complete. Changing/reshuffling their values requires a new data generation.
-- sourcePosition/cdcWatermark/publishedAt describe that new qualification barrier.
-- sealPaymentCorrectionAtCurrentControls binds writer heads before+after sealing.
-- DAILY heads cover each affected day; CASH-LEDGER heads cover ordered prior-day
-- prefixes, so an earlier return cannot be hidden behind a fresh closing balance.
-- Pending armed/attested/retained returns refuse publication and final reports.
-- A new transition makes affected qualification seals stale immediately, even
-- if unchanged unrelated source partitions continue using their immutable bytes.
-- Publish all required source and proof rows, verify native proof/payload checks,
-- then publish one COMPLETE common-generation control seal. Never mutate an old
-- generation or claim completion before the actual source barrier is proved.
