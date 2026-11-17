-- REVIEW ONLY. No application migration, live DDL or cutover is authorized here.
-- Install every trigger, seed existing keys and qualify the installed bodies
-- before selecting the producer. Historical eligibility still reads BigQuery.
CREATE TABLE IF NOT EXISTS pos_rewrite_coupon_history_heads (
 kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 scope_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 revision BIGINT UNSIGNED NOT NULL,
 last_owner_nonce VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 owner_start_revision BIGINT UNSIGNED NULL,
 PRIMARY KEY(kind,scope_id)
) ENGINE=InnoDB;

DELIMITER $$
CREATE TRIGGER pos_rewrite_coupon_history_orders_insert AFTER INSERT ON orders
FOR EACH ROW BEGIN
IF @pos_rewrite_coupon_history_owner IS NOT NULL AND
 (OCTET_LENGTH(@pos_rewrite_coupon_history_owner)<>36 OR
  NOT REGEXP_LIKE(@pos_rewrite_coupon_history_owner,'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$','c')) THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Coupon history owner is invalid';
END IF;
INSERT INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision,last_owner_nonce,owner_start_revision)
SELECT kind,CAST(scope_id AS CHAR),1,@pos_rewrite_coupon_history_owner,
 CASE WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL ELSE 0 END
FROM (SELECT 'coupon' AS kind, NEW.coupon_used AS scope_id
UNION
SELECT 'customer' AS kind, NEW.user_id AS scope_id) AS affected
WHERE scope_id IS NOT NULL AND (kind='controls' OR scope_id>0)
ORDER BY kind,scope_id
ON DUPLICATE KEY UPDATE
 owner_start_revision=CASE
  WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL
  WHEN last_owner_nonce <=> @pos_rewrite_coupon_history_owner THEN owner_start_revision
  ELSE revision END,
 last_owner_nonce=@pos_rewrite_coupon_history_owner,
 revision=revision+1;
END$$

CREATE TRIGGER pos_rewrite_coupon_history_orders_update AFTER UPDATE ON orders
FOR EACH ROW BEGIN
IF @pos_rewrite_coupon_history_owner IS NOT NULL AND
 (OCTET_LENGTH(@pos_rewrite_coupon_history_owner)<>36 OR
  NOT REGEXP_LIKE(@pos_rewrite_coupon_history_owner,'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$','c')) THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Coupon history owner is invalid';
END IF;
INSERT INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision,last_owner_nonce,owner_start_revision)
SELECT kind,CAST(scope_id AS CHAR),1,@pos_rewrite_coupon_history_owner,
 CASE WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL ELSE 0 END
FROM (SELECT 'coupon' AS kind, OLD.coupon_used AS scope_id
UNION
SELECT 'customer' AS kind, OLD.user_id AS scope_id
UNION
SELECT 'coupon' AS kind, NEW.coupon_used AS scope_id
UNION
SELECT 'customer' AS kind, NEW.user_id AS scope_id) AS affected
WHERE scope_id IS NOT NULL AND (kind='controls' OR scope_id>0)
ORDER BY kind,scope_id
ON DUPLICATE KEY UPDATE
 owner_start_revision=CASE
  WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL
  WHEN last_owner_nonce <=> @pos_rewrite_coupon_history_owner THEN owner_start_revision
  ELSE revision END,
 last_owner_nonce=@pos_rewrite_coupon_history_owner,
 revision=revision+1;
END$$

CREATE TRIGGER pos_rewrite_coupon_history_orders_delete AFTER DELETE ON orders
FOR EACH ROW BEGIN
IF @pos_rewrite_coupon_history_owner IS NOT NULL AND
 (OCTET_LENGTH(@pos_rewrite_coupon_history_owner)<>36 OR
  NOT REGEXP_LIKE(@pos_rewrite_coupon_history_owner,'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$','c')) THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Coupon history owner is invalid';
END IF;
INSERT INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision,last_owner_nonce,owner_start_revision)
SELECT kind,CAST(scope_id AS CHAR),1,@pos_rewrite_coupon_history_owner,
 CASE WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL ELSE 0 END
FROM (SELECT 'coupon' AS kind, OLD.coupon_used AS scope_id
UNION
SELECT 'customer' AS kind, OLD.user_id AS scope_id) AS affected
WHERE scope_id IS NOT NULL AND (kind='controls' OR scope_id>0)
ORDER BY kind,scope_id
ON DUPLICATE KEY UPDATE
 owner_start_revision=CASE
  WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL
  WHEN last_owner_nonce <=> @pos_rewrite_coupon_history_owner THEN owner_start_revision
  ELSE revision END,
 last_owner_nonce=@pos_rewrite_coupon_history_owner,
 revision=revision+1;
END$$

CREATE TRIGGER pos_rewrite_coupon_history_order_coupon_log_insert AFTER INSERT ON order_coupon_log
FOR EACH ROW BEGIN
IF @pos_rewrite_coupon_history_owner IS NOT NULL AND
 (OCTET_LENGTH(@pos_rewrite_coupon_history_owner)<>36 OR
  NOT REGEXP_LIKE(@pos_rewrite_coupon_history_owner,'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$','c')) THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Coupon history owner is invalid';
END IF;
INSERT INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision,last_owner_nonce,owner_start_revision)
SELECT kind,CAST(scope_id AS CHAR),1,@pos_rewrite_coupon_history_owner,
 CASE WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL ELSE 0 END
FROM (SELECT 'customer' AS kind, NEW.user_id AS scope_id) AS affected
WHERE scope_id IS NOT NULL AND (kind='controls' OR scope_id>0)
ORDER BY kind,scope_id
ON DUPLICATE KEY UPDATE
 owner_start_revision=CASE
  WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL
  WHEN last_owner_nonce <=> @pos_rewrite_coupon_history_owner THEN owner_start_revision
  ELSE revision END,
 last_owner_nonce=@pos_rewrite_coupon_history_owner,
 revision=revision+1;
END$$

CREATE TRIGGER pos_rewrite_coupon_history_order_coupon_log_update AFTER UPDATE ON order_coupon_log
FOR EACH ROW BEGIN
IF @pos_rewrite_coupon_history_owner IS NOT NULL AND
 (OCTET_LENGTH(@pos_rewrite_coupon_history_owner)<>36 OR
  NOT REGEXP_LIKE(@pos_rewrite_coupon_history_owner,'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$','c')) THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Coupon history owner is invalid';
END IF;
INSERT INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision,last_owner_nonce,owner_start_revision)
SELECT kind,CAST(scope_id AS CHAR),1,@pos_rewrite_coupon_history_owner,
 CASE WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL ELSE 0 END
FROM (SELECT 'customer' AS kind, OLD.user_id AS scope_id
UNION
SELECT 'customer' AS kind, NEW.user_id AS scope_id) AS affected
WHERE scope_id IS NOT NULL AND (kind='controls' OR scope_id>0)
ORDER BY kind,scope_id
ON DUPLICATE KEY UPDATE
 owner_start_revision=CASE
  WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL
  WHEN last_owner_nonce <=> @pos_rewrite_coupon_history_owner THEN owner_start_revision
  ELSE revision END,
 last_owner_nonce=@pos_rewrite_coupon_history_owner,
 revision=revision+1;
END$$

CREATE TRIGGER pos_rewrite_coupon_history_order_coupon_log_delete AFTER DELETE ON order_coupon_log
FOR EACH ROW BEGIN
IF @pos_rewrite_coupon_history_owner IS NOT NULL AND
 (OCTET_LENGTH(@pos_rewrite_coupon_history_owner)<>36 OR
  NOT REGEXP_LIKE(@pos_rewrite_coupon_history_owner,'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$','c')) THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Coupon history owner is invalid';
END IF;
INSERT INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision,last_owner_nonce,owner_start_revision)
SELECT kind,CAST(scope_id AS CHAR),1,@pos_rewrite_coupon_history_owner,
 CASE WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL ELSE 0 END
FROM (SELECT 'customer' AS kind, OLD.user_id AS scope_id) AS affected
WHERE scope_id IS NOT NULL AND (kind='controls' OR scope_id>0)
ORDER BY kind,scope_id
ON DUPLICATE KEY UPDATE
 owner_start_revision=CASE
  WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL
  WHEN last_owner_nonce <=> @pos_rewrite_coupon_history_owner THEN owner_start_revision
  ELSE revision END,
 last_owner_nonce=@pos_rewrite_coupon_history_owner,
 revision=revision+1;
END$$

CREATE TRIGGER pos_rewrite_coupon_history_coupons_insert AFTER INSERT ON coupons
FOR EACH ROW BEGIN
IF @pos_rewrite_coupon_history_owner IS NOT NULL AND
 (OCTET_LENGTH(@pos_rewrite_coupon_history_owner)<>36 OR
  NOT REGEXP_LIKE(@pos_rewrite_coupon_history_owner,'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$','c')) THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Coupon history owner is invalid';
END IF;
INSERT INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision,last_owner_nonce,owner_start_revision)
SELECT kind,CAST(scope_id AS CHAR),1,@pos_rewrite_coupon_history_owner,
 CASE WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL ELSE 0 END
FROM (SELECT 'controls' AS kind, 0 AS scope_id
UNION
SELECT 'coupon' AS kind, NEW.id AS scope_id) AS affected
WHERE scope_id IS NOT NULL AND (kind='controls' OR scope_id>0)
ORDER BY kind,scope_id
ON DUPLICATE KEY UPDATE
 owner_start_revision=CASE
  WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL
  WHEN last_owner_nonce <=> @pos_rewrite_coupon_history_owner THEN owner_start_revision
  ELSE revision END,
 last_owner_nonce=@pos_rewrite_coupon_history_owner,
 revision=revision+1;
END$$

CREATE TRIGGER pos_rewrite_coupon_history_coupons_update AFTER UPDATE ON coupons
FOR EACH ROW BEGIN
IF @pos_rewrite_coupon_history_owner IS NOT NULL AND
 (OCTET_LENGTH(@pos_rewrite_coupon_history_owner)<>36 OR
  NOT REGEXP_LIKE(@pos_rewrite_coupon_history_owner,'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$','c')) THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Coupon history owner is invalid';
END IF;
INSERT INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision,last_owner_nonce,owner_start_revision)
SELECT kind,CAST(scope_id AS CHAR),1,@pos_rewrite_coupon_history_owner,
 CASE WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL ELSE 0 END
FROM (SELECT 'controls' AS kind, 0 AS scope_id
UNION
SELECT 'coupon' AS kind, OLD.id AS scope_id
UNION
SELECT 'coupon' AS kind, NEW.id AS scope_id) AS affected
WHERE scope_id IS NOT NULL AND (kind='controls' OR scope_id>0)
ORDER BY kind,scope_id
ON DUPLICATE KEY UPDATE
 owner_start_revision=CASE
  WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL
  WHEN last_owner_nonce <=> @pos_rewrite_coupon_history_owner THEN owner_start_revision
  ELSE revision END,
 last_owner_nonce=@pos_rewrite_coupon_history_owner,
 revision=revision+1;
END$$

CREATE TRIGGER pos_rewrite_coupon_history_coupons_delete AFTER DELETE ON coupons
FOR EACH ROW BEGIN
IF @pos_rewrite_coupon_history_owner IS NOT NULL AND
 (OCTET_LENGTH(@pos_rewrite_coupon_history_owner)<>36 OR
  NOT REGEXP_LIKE(@pos_rewrite_coupon_history_owner,'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$','c')) THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Coupon history owner is invalid';
END IF;
INSERT INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision,last_owner_nonce,owner_start_revision)
SELECT kind,CAST(scope_id AS CHAR),1,@pos_rewrite_coupon_history_owner,
 CASE WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL ELSE 0 END
FROM (SELECT 'controls' AS kind, 0 AS scope_id
UNION
SELECT 'coupon' AS kind, OLD.id AS scope_id) AS affected
WHERE scope_id IS NOT NULL AND (kind='controls' OR scope_id>0)
ORDER BY kind,scope_id
ON DUPLICATE KEY UPDATE
 owner_start_revision=CASE
  WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL
  WHEN last_owner_nonce <=> @pos_rewrite_coupon_history_owner THEN owner_start_revision
  ELSE revision END,
 last_owner_nonce=@pos_rewrite_coupon_history_owner,
 revision=revision+1;
END$$

CREATE TRIGGER pos_rewrite_coupon_history_users_insert AFTER INSERT ON users
FOR EACH ROW BEGIN
IF @pos_rewrite_coupon_history_owner IS NOT NULL AND
 (OCTET_LENGTH(@pos_rewrite_coupon_history_owner)<>36 OR
  NOT REGEXP_LIKE(@pos_rewrite_coupon_history_owner,'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$','c')) THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Coupon history owner is invalid';
END IF;
INSERT INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision,last_owner_nonce,owner_start_revision)
SELECT kind,CAST(scope_id AS CHAR),1,@pos_rewrite_coupon_history_owner,
 CASE WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL ELSE 0 END
FROM (SELECT 'customer' AS kind, NEW.id AS scope_id) AS affected
WHERE scope_id IS NOT NULL AND (kind='controls' OR scope_id>0)
ORDER BY kind,scope_id
ON DUPLICATE KEY UPDATE
 owner_start_revision=CASE
  WHEN @pos_rewrite_coupon_history_owner IS NULL THEN NULL
  WHEN last_owner_nonce <=> @pos_rewrite_coupon_history_owner THEN owner_start_revision
  ELSE revision END,
 last_owner_nonce=@pos_rewrite_coupon_history_owner,
 revision=revision+1;
END$$
DELIMITER ;

INSERT IGNORE INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision) VALUES('controls','0',0);
INSERT IGNORE INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision)
 SELECT 'coupon',CAST(id AS CHAR),0 FROM coupons WHERE id>0;
INSERT IGNORE INTO pos_rewrite_coupon_history_heads(kind,scope_id,revision)
 SELECT 'customer',CAST(id AS CHAR),0 FROM users WHERE id>0;
UPDATE pos_rewrite_coupon_history_heads SET revision=revision+1 WHERE kind='controls' AND scope_id='0';
-- Seed after trigger installation. IGNORE retains any revision already
-- advanced by a concurrent mutation; it must never reset an existing head.
