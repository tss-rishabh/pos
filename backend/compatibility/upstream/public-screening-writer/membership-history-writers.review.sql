-- REVIEW ONLY. Qualify all source writers and the exact operational writer origin.
-- Install under a coordinated writer cutover. Runtime never applies this DDL.
CREATE TABLE IF NOT EXISTS pos_rewrite_membership_history_heads (
 customer_id BIGINT NOT NULL PRIMARY KEY,
 revision BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;
-- Backfill all existing identities before publishing any complete generation.
-- New identities and every delivered-history mutation are tracked by triggers.
INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision)
SELECT id,0 FROM users ON DUPLICATE KEY UPDATE customer_id=customer_id;

DELIMITER $$
CREATE TRIGGER pos_rewrite_member_history_order_i AFTER INSERT ON orders FOR EACH ROW
BEGIN IF NEW.order_status=3 THEN INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(NEW.user_id,1) ON DUPLICATE KEY UPDATE revision=revision+1; END IF; END$$
DELIMITER ;

DELIMITER $$
CREATE TRIGGER pos_rewrite_member_history_order_d AFTER DELETE ON orders FOR EACH ROW
BEGIN IF OLD.order_status=3 THEN INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(OLD.user_id,1) ON DUPLICATE KEY UPDATE revision=revision+1; END IF; END$$
DELIMITER ;

DELIMITER $$
CREATE TRIGGER pos_rewrite_member_history_order_u AFTER UPDATE ON orders FOR EACH ROW
BEGIN DECLARE a BIGINT DEFAULT NULL; DECLARE b BIGINT DEFAULT NULL;
IF OLD.order_status=3 THEN SET a=OLD.user_id; END IF;
IF NEW.order_status=3 THEN SET b=NEW.user_id; END IF;
IF a IS NOT NULL AND b IS NOT NULL AND a<>b THEN
 IF a<b THEN INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(a,1) ON DUPLICATE KEY UPDATE revision=revision+1; INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(b,1) ON DUPLICATE KEY UPDATE revision=revision+1; ELSE INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(b,1) ON DUPLICATE KEY UPDATE revision=revision+1; INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(a,1) ON DUPLICATE KEY UPDATE revision=revision+1; END IF;
ELSEIF a IS NOT NULL THEN INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(a,1) ON DUPLICATE KEY UPDATE revision=revision+1;
ELSEIF b IS NOT NULL THEN INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(b,1) ON DUPLICATE KEY UPDATE revision=revision+1; END IF; END$$
DELIMITER ;

DELIMITER $$
CREATE TRIGGER pos_rewrite_member_history_hp_i AFTER INSERT ON has_products FOR EACH ROW
BEGIN DECLARE a BIGINT DEFAULT NULL;
SELECT user_id INTO a FROM orders WHERE id=NEW.order_id AND order_status=3 FOR SHARE;
IF a IS NOT NULL THEN INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(a,1) ON DUPLICATE KEY UPDATE revision=revision+1; END IF; END$$
DELIMITER ;

DELIMITER $$
CREATE TRIGGER pos_rewrite_member_history_hp_d AFTER DELETE ON has_products FOR EACH ROW
BEGIN DECLARE a BIGINT DEFAULT NULL;
SELECT user_id INTO a FROM orders WHERE id=OLD.order_id AND order_status=3 FOR SHARE;
IF a IS NOT NULL THEN INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(a,1) ON DUPLICATE KEY UPDATE revision=revision+1; END IF; END$$
DELIMITER ;

DELIMITER $$
CREATE TRIGGER pos_rewrite_member_history_hp_u AFTER UPDATE ON has_products FOR EACH ROW
BEGIN DECLARE a BIGINT DEFAULT NULL; DECLARE b BIGINT DEFAULT NULL;
SELECT user_id INTO a FROM orders WHERE id=OLD.order_id AND order_status=3 FOR SHARE;
SELECT user_id INTO b FROM orders WHERE id=NEW.order_id AND order_status=3 FOR SHARE;
IF a IS NOT NULL AND b IS NOT NULL AND a<>b THEN
 IF a<b THEN INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(a,1) ON DUPLICATE KEY UPDATE revision=revision+1; INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(b,1) ON DUPLICATE KEY UPDATE revision=revision+1; ELSE INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(b,1) ON DUPLICATE KEY UPDATE revision=revision+1; INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(a,1) ON DUPLICATE KEY UPDATE revision=revision+1; END IF;
ELSEIF a IS NOT NULL THEN INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(a,1) ON DUPLICATE KEY UPDATE revision=revision+1;
ELSEIF b IS NOT NULL THEN INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(b,1) ON DUPLICATE KEY UPDATE revision=revision+1; END IF; END$$
DELIMITER ;

DELIMITER $$
CREATE TRIGGER pos_rewrite_member_history_user_i AFTER INSERT ON users FOR EACH ROW
BEGIN INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision) VALUES(NEW.id,0) ON DUPLICATE KEY UPDATE customer_id=customer_id; END$$
DELIMITER ;
