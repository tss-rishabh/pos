-- REVIEW ONLY. Separate publisher/definer installation, never runtime DDL.
-- The publisher must certify this head/log and complete order-status coverage.
-- Applications have SELECT only on heads/changes; no definer routine grant.
CREATE TABLE pos_rewrite_screening_origin_history_heads(
 customer_id BIGINT NOT NULL PRIMARY KEY,revision BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;
CREATE TABLE pos_rewrite_screening_origin_history_changes(
 customer_id BIGINT NOT NULL,revision BIGINT UNSIGNED NOT NULL,order_id BIGINT NOT NULL,
 PRIMARY KEY(customer_id,revision)
) ENGINE=InnoDB;
INSERT INTO pos_rewrite_screening_origin_history_heads(customer_id,revision)
SELECT id,0 FROM users ON DUPLICATE KEY UPDATE customer_id=customer_id;
DELIMITER $$
CREATE TRIGGER pos_rewrite_origin_history_user_i AFTER INSERT ON users FOR EACH ROW
BEGIN INSERT INTO pos_rewrite_screening_origin_history_heads(customer_id,revision) VALUES(NEW.id,0); END$$
CREATE TRIGGER pos_rewrite_origin_history_order_i AFTER INSERT ON orders FOR EACH ROW
BEGIN
 UPDATE pos_rewrite_screening_origin_history_heads SET revision=revision+1 WHERE customer_id=NEW.user_id;
 IF ROW_COUNT()<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SCREENING_ORIGIN_HISTORY_UNQUALIFIED'; END IF;
 INSERT INTO pos_rewrite_screening_origin_history_changes SELECT customer_id,revision,NEW.id FROM pos_rewrite_screening_origin_history_heads WHERE customer_id=NEW.user_id;
END$$
CREATE TRIGGER pos_rewrite_origin_history_order_d AFTER DELETE ON orders FOR EACH ROW
BEGIN
 UPDATE pos_rewrite_screening_origin_history_heads SET revision=revision+1 WHERE customer_id=OLD.user_id;
 IF ROW_COUNT()<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SCREENING_ORIGIN_HISTORY_UNQUALIFIED'; END IF;
 INSERT INTO pos_rewrite_screening_origin_history_changes SELECT customer_id,revision,OLD.id FROM pos_rewrite_screening_origin_history_heads WHERE customer_id=OLD.user_id;
END$$
CREATE TRIGGER pos_rewrite_origin_history_order_u AFTER UPDATE ON orders FOR EACH ROW
BEGIN
 DECLARE a BIGINT; DECLARE b BIGINT;
 IF NOT(OLD.id<=>NEW.id) OR NOT(OLD.user_id<=>NEW.user_id) OR NOT(OLD.order_status<=>NEW.order_status) OR NOT(OLD.flag_id<=>NEW.flag_id) THEN
  SET a=LEAST(OLD.user_id,NEW.user_id); SET b=GREATEST(OLD.user_id,NEW.user_id);
  UPDATE pos_rewrite_screening_origin_history_heads SET revision=revision+1 WHERE customer_id=a;
  IF ROW_COUNT()<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SCREENING_ORIGIN_HISTORY_UNQUALIFIED'; END IF;
  INSERT INTO pos_rewrite_screening_origin_history_changes SELECT customer_id,revision,NEW.id FROM pos_rewrite_screening_origin_history_heads WHERE customer_id=a;
  IF b<>a THEN
   UPDATE pos_rewrite_screening_origin_history_heads SET revision=revision+1 WHERE customer_id=b;
   IF ROW_COUNT()<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SCREENING_ORIGIN_HISTORY_UNQUALIFIED'; END IF;
   INSERT INTO pos_rewrite_screening_origin_history_changes SELECT customer_id,revision,NEW.id FROM pos_rewrite_screening_origin_history_heads WHERE customer_id=b;
  END IF;
 END IF;
END$$
DELIMITER ;
