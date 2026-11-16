-- Original entity identity remains a keyed digest, never a retained email.
-- Old abstract proofs remain NULL and cannot qualify as activated v2 evidence.
ALTER TABLE pos_rewrite_cancellation_membership_provenance
  ADD COLUMN entity_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL;
