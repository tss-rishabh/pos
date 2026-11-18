-- REVIEW ONLY. No DDL/deployment is performed by the application or migration runner.
-- Replace the example project/dataset with approved private reporting relations.
-- Source anchors/closes/banking/cash views must expose immutable generation_id.
-- Their source rows and rewrite correction/movement/proof rows must share the
-- publisher's verified source position. Raw independent CDC watermarks do not qualify.
CREATE TABLE IF NOT EXISTS `approved-project.pos_reporting.payment_correction_publications_v1` (
  generation_id STRING NOT NULL,
  kind STRING NOT NULL, -- daily | cash-ledger
  store_id STRING NOT NULL,
  business_date DATE NOT NULL,
  contract STRING NOT NULL, -- pos-payment-correction-finance-publication-v1
  publication_state STRING NOT NULL, -- only COMPLETE is readable
  published_at TIMESTAMP NOT NULL,
  body STRING NOT NULL, -- strict canonical private body from sealPaymentCorrectionPartition
  proof_hash STRING NOT NULL -- HMAC, never a raw financial signing key
)
PARTITION BY business_date
CLUSTER BY store_id, kind, generation_id;
-- BigQuery does not enforce relation uniqueness. The reader requires exactly
-- one valid sealed partition per requested (generation,kind,store,date), rejects
-- duplicates/missing partitions, and accepts zero only as an explicit sealed body.
-- Publish immutable source/rollup rows first, validate counts/values and native
-- proof checks, then atomically publish all COMPLETE partition rows. Never update
-- a previous generation or assert completeness before the common barrier is proved.
