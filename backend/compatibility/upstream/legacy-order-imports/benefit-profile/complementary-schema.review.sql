-- REVIEW ONLY. Do not add to automatic rewrite migrations or execute with the
-- supplied reader. Both source ORM and physical schema currently reject the
-- literal FREEBIE written by the pinned is_free=True constructor.
-- Verify exact existing definition/writer consumers/online DDL first. Preserve
-- all original labels and the NULL default; do not relabel free rows REGULAR.
ALTER TABLE has_products MODIFY COLUMN type
  ENUM('REGULAR','JIT','PRE_ORDER','MTO','FREEBIE') NULL DEFAULT NULL;
