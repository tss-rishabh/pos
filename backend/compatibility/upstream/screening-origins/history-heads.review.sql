-- REVIEW ONLY. Install atomically with the dedicated locked definer/security
-- metadata function and bounded bootstrap/cutover; never app runtime DDL.
CREATE TABLE pos_rewrite_screening_origin_history_heads(
 customer_id BIGINT NOT NULL PRIMARY KEY,revision BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_history_changes(
 customer_id BIGINT NOT NULL,revision BIGINT UNSIGNED NOT NULL,order_id BIGINT NOT NULL,
 PRIMARY KEY(customer_id,revision)
) ENGINE=InnoDB;
INSERT INTO pos_rewrite_screening_origin_history_heads(customer_id,revision)
SELECT id,0 FROM users WHERE id>0 ON DUPLICATE KEY UPDATE customer_id=customer_id;
-- Include legacy orphan IDs without pretending that an absent customer can
-- authenticate. Publishers independently require the actual current user row.
INSERT INTO pos_rewrite_screening_origin_history_heads(customer_id,revision)
SELECT DISTINCT user_id,0 FROM orders WHERE user_id>0 ON DUPLICATE KEY UPDATE customer_id=customer_id;
DELIMITER $$
CREATE DEFINER='pos_origin_history_trigger'@'%' TRIGGER pos_rewrite_origin_history_user_i AFTER INSERT ON users FOR EACH ROW
BEGIN
 IF NEW.id>0 THEN
  INSERT INTO pos_rewrite_screening_origin_history_heads(customer_id,revision) VALUES(NEW.id,0)
  ON DUPLICATE KEY UPDATE customer_id=customer_id;
 END IF;
END$$
CREATE DEFINER='pos_origin_history_trigger'@'%' TRIGGER pos_rewrite_origin_history_order_i AFTER INSERT ON orders FOR EACH ROW
BEGIN
 IF NEW.user_id>0 THEN
  INSERT INTO pos_rewrite_screening_origin_history_heads(customer_id,revision) VALUES(NEW.user_id,1)
  ON DUPLICATE KEY UPDATE revision=revision+1;
  INSERT INTO pos_rewrite_screening_origin_history_changes SELECT customer_id,revision,NEW.id FROM pos_rewrite_screening_origin_history_heads WHERE customer_id=NEW.user_id;
 END IF;
END$$
CREATE DEFINER='pos_origin_history_trigger'@'%' TRIGGER pos_rewrite_origin_history_order_d AFTER DELETE ON orders FOR EACH ROW
BEGIN
 IF OLD.user_id>0 THEN
  INSERT INTO pos_rewrite_screening_origin_history_heads(customer_id,revision) VALUES(OLD.user_id,1)
  ON DUPLICATE KEY UPDATE revision=revision+1;
  INSERT INTO pos_rewrite_screening_origin_history_changes SELECT customer_id,revision,OLD.id FROM pos_rewrite_screening_origin_history_heads WHERE customer_id=OLD.user_id;
 END IF;
END$$
CREATE DEFINER='pos_origin_history_trigger'@'%' TRIGGER pos_rewrite_origin_history_order_u AFTER UPDATE ON orders FOR EACH ROW
BEGIN
 DECLARE a BIGINT; DECLARE b BIGINT;
 IF NOT(OLD.id<=>NEW.id) OR NOT(OLD.user_id<=>NEW.user_id) OR NOT(OLD.order_status<=>NEW.order_status) OR NOT(OLD.flag_id<=>NEW.flag_id) THEN
  SET a=LEAST(COALESCE(OLD.user_id,0),COALESCE(NEW.user_id,0));
  SET b=GREATEST(COALESCE(OLD.user_id,0),COALESCE(NEW.user_id,0));
  IF a>0 THEN
   INSERT INTO pos_rewrite_screening_origin_history_heads(customer_id,revision) VALUES(a,1)
   ON DUPLICATE KEY UPDATE revision=revision+1;
   INSERT INTO pos_rewrite_screening_origin_history_changes SELECT customer_id,revision,NEW.id FROM pos_rewrite_screening_origin_history_heads WHERE customer_id=a;
  END IF;
  IF b>0 AND b<>a THEN
   INSERT INTO pos_rewrite_screening_origin_history_heads(customer_id,revision) VALUES(b,1)
   ON DUPLICATE KEY UPDATE revision=revision+1;
   INSERT INTO pos_rewrite_screening_origin_history_changes SELECT customer_id,revision,NEW.id FROM pos_rewrite_screening_origin_history_heads WHERE customer_id=b;
  END IF;
 END IF;
END$$
DELIMITER ;
