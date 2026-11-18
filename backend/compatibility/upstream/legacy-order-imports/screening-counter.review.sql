-- Review-only. Independent publisher/baseline and all cooperating writer cutover required.
-- Never apply automatically or with the supplied read-only credentials.
DELIMITER $$
CREATE TABLE pos_rewrite_screening_counter_heads(customer_id BIGINT NOT NULL PRIMARY KEY,revision BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB$$
CREATE TABLE pos_rewrite_screening_counters(customer_id BIGINT NOT NULL PRIMARY KEY,sku BIGINT NOT NULL,bought BIGINT UNSIGNED NOT NULL,revision BIGINT UNSIGNED NOT NULL,baseline JSON NOT NULL,baseline_hash VARCHAR(64) NOT NULL) ENGINE=InnoDB$$
CREATE TABLE pos_rewrite_screening_contributions(marker_id INT NOT NULL PRIMARY KEY,customer_id BIGINT NOT NULL,order_id BIGINT NOT NULL,line_id BIGINT NOT NULL,included TINYINT NOT NULL,CHECK(included IN(0,1)),KEY ix_screening_contribution_customer(customer_id,marker_id),KEY ix_screening_contribution_order(order_id,marker_id),KEY ix_screening_contribution_line(line_id,marker_id)) ENGINE=InnoDB$$
CREATE PROCEDURE pos_screening_sync_marker(IN target_marker INT,IN old_exists TINYINT,IN old_customer BIGINT,IN old_order BIGINT,IN old_line BIGINT) SQL SECURITY DEFINER BEGIN
DECLARE previous_customer BIGINT DEFAULT NULL;
DECLARE previous_order BIGINT DEFAULT NULL;
DECLARE previous_line BIGINT DEFAULT NULL;
DECLARE previous_included TINYINT DEFAULT 0;
DECLARE current_customer BIGINT DEFAULT NULL;
DECLARE current_order BIGINT DEFAULT NULL;
DECLARE current_line BIGINT DEFAULT NULL;
DECLARE current_included TINYINT DEFAULT 0;
DECLARE first_customer BIGINT DEFAULT NULL;
DECLARE second_customer BIGINT DEFAULT NULL;
DECLARE current_revision BIGINT UNSIGNED;
DECLARE available BIGINT UNSIGNED;
DECLARE found_previous TINYINT DEFAULT 1;
DECLARE found_current TINYINT DEFAULT 1;
DECLARE ready_count INT;
DECLARE transaction_metadata JSON;
SET transaction_metadata=pos_rewrite_origin_transaction_metadata();
IF JSON_LENGTH(transaction_metadata)<>1
 OR NOT(JSON_UNQUOTE(JSON_EXTRACT(transaction_metadata,'$[0].state')) <=> 'ACTIVE')
 OR NOT(JSON_UNQUOTE(JSON_EXTRACT(transaction_metadata,'$[0].isolation')) <=> 'READ COMMITTED') THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening counter writer requires current reads';
END IF;
BEGIN
 DECLARE CONTINUE HANDLER FOR NOT FOUND SET found_previous=0;
 SELECT customer_id,order_id,line_id,included INTO previous_customer,previous_order,previous_line,previous_included
 FROM pos_rewrite_screening_contributions WHERE marker_id=target_marker;
END;
BEGIN
 DECLARE CONTINUE HANDLER FOR NOT FOUND SET found_current=0;
 SELECT s.user_id,s.order_id,s.has_product_id,IF(hp.prod_id=390238 AND o.order_status NOT IN(0,17),1,0)
 INTO current_customer,current_order,current_line,current_included
 FROM spiderman_screening_orders s LEFT JOIN orders o ON o.id=s.order_id
 LEFT JOIN has_products hp ON hp.id=s.has_product_id WHERE s.id=target_marker;
END;
IF old_exists=0 AND found_previous=1 THEN
 SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening contribution identity is invalid';
END IF;
IF old_exists=1 AND old_customer>0 THEN
 SELECT COUNT(*) INTO ready_count FROM pos_rewrite_screening_counters WHERE customer_id=old_customer;
 IF ready_count=1 AND (found_previous=0 OR previous_customer<>old_customer OR previous_order<>old_order OR previous_line<>old_line) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening contribution reconciliation required';
 END IF;
END IF;
SET first_customer=IF(old_exists=1 AND old_customer>0,old_customer,NULL);
IF found_current=1 AND current_customer>0 THEN
 IF first_customer IS NULL THEN SET first_customer=current_customer;
 ELSEIF first_customer<>current_customer THEN
  SET second_customer=GREATEST(first_customer,current_customer);
  SET first_customer=LEAST(first_customer,current_customer);
 END IF;
END IF;
WHILE first_customer IS NOT NULL DO
 IF NOT (IS_USED_LOCK(CONCAT('pos-screening:',LEFT(SHA2(DATABASE(),256),16),':u:',first_customer))<=>CONNECTION_ID()) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening counter writer entry required';
 END IF;
 IF old_exists=1 AND old_customer=first_customer AND (
  NOT(IS_USED_LOCK(CONCAT('pos-screening:',LEFT(SHA2(DATABASE(),256),16),':o:',old_order))<=>CONNECTION_ID()) OR
  NOT(IS_USED_LOCK(CONCAT('pos-screening:',LEFT(SHA2(DATABASE(),256),16),':p:',old_line))<=>CONNECTION_ID())) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening counter parent entry required';
 END IF;
 IF found_current=1 AND current_customer=first_customer AND (
  NOT(IS_USED_LOCK(CONCAT('pos-screening:',LEFT(SHA2(DATABASE(),256),16),':o:',current_order))<=>CONNECTION_ID()) OR
  NOT(IS_USED_LOCK(CONCAT('pos-screening:',LEFT(SHA2(DATABASE(),256),16),':p:',current_line))<=>CONNECTION_ID())) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening counter parent entry required';
 END IF;
 INSERT INTO pos_rewrite_screening_counter_heads(customer_id,revision) VALUES(first_customer,1)
 ON DUPLICATE KEY UPDATE revision=revision+1;
 SELECT revision INTO current_revision FROM pos_rewrite_screening_counter_heads WHERE customer_id=first_customer;
 SELECT COUNT(*) INTO ready_count FROM pos_rewrite_screening_counters WHERE customer_id=first_customer;
 IF ready_count=1 THEN
  SET available=NULL;
  BEGIN
   DECLARE CONTINUE HANDLER FOR NOT FOUND SET available=NULL;
   SELECT bought INTO available FROM pos_rewrite_screening_counters WHERE customer_id=first_customer AND revision=current_revision-1 FOR UPDATE;
  END;
  IF available IS NULL OR (found_previous=1 AND previous_customer=first_customer AND previous_included>available) THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening counter revision is invalid';
  END IF;
  UPDATE pos_rewrite_screening_counters SET
   bought=available-IF(found_previous=1 AND previous_customer=first_customer,previous_included,0)+IF(found_current=1 AND current_customer=first_customer,current_included,0),
   revision=current_revision WHERE customer_id=first_customer;
 END IF;
 SET first_customer=second_customer;SET second_customer=NULL;
END WHILE;
DELETE FROM pos_rewrite_screening_contributions WHERE marker_id=target_marker;
IF found_current=1 AND current_customer>0 AND EXISTS(SELECT 1 FROM pos_rewrite_screening_counters WHERE customer_id=current_customer) THEN
 INSERT INTO pos_rewrite_screening_contributions(marker_id,customer_id,order_id,line_id,included)
 VALUES(target_marker,current_customer,current_order,current_line,current_included);
END IF;
END$$
CREATE TRIGGER pos_screening_orders_insert AFTER INSERT ON orders FOR EACH ROW BEGIN
DECLARE finished INT DEFAULT 0;
DECLARE visited INT DEFAULT 0;
DECLARE marker INT;DECLARE customer BIGINT;DECLARE parent BIGINT;DECLARE line BIGINT;
DECLARE affected CURSOR FOR SELECT id,user_id,order_id,has_product_id FROM spiderman_screening_orders WHERE order_id=NEW.id ORDER BY user_id,id LIMIT 10001;
DECLARE CONTINUE HANDLER FOR NOT FOUND SET finished=1;
IF TRUE THEN
 OPEN affected;
 scan_markers: LOOP
  FETCH affected INTO marker,customer,parent,line;
  IF finished=1 THEN LEAVE scan_markers;END IF;
  SET visited=visited+1;
  IF visited>10000 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening counter parent is too large';END IF;
  CALL pos_screening_sync_marker(marker,1,customer,parent,line);
 END LOOP;
 CLOSE affected;
END IF;
END$$
CREATE TRIGGER pos_screening_has_products_insert AFTER INSERT ON has_products FOR EACH ROW BEGIN
DECLARE finished INT DEFAULT 0;
DECLARE visited INT DEFAULT 0;
DECLARE marker INT;DECLARE customer BIGINT;DECLARE parent BIGINT;DECLARE line BIGINT;
DECLARE affected CURSOR FOR SELECT id,user_id,order_id,has_product_id FROM spiderman_screening_orders WHERE has_product_id=NEW.id ORDER BY user_id,id LIMIT 10001;
DECLARE CONTINUE HANDLER FOR NOT FOUND SET finished=1;
IF TRUE THEN
 OPEN affected;
 scan_markers: LOOP
  FETCH affected INTO marker,customer,parent,line;
  IF finished=1 THEN LEAVE scan_markers;END IF;
  SET visited=visited+1;
  IF visited>10000 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening counter parent is too large';END IF;
  CALL pos_screening_sync_marker(marker,1,customer,parent,line);
 END LOOP;
 CLOSE affected;
END IF;
END$$
CREATE TRIGGER pos_screening_markers_insert AFTER INSERT ON spiderman_screening_orders FOR EACH ROW BEGIN
CALL pos_screening_sync_marker(NEW.id,0,NULL,NULL,NULL);
END$$
CREATE TRIGGER pos_screening_orders_update AFTER UPDATE ON orders FOR EACH ROW BEGIN
DECLARE finished INT DEFAULT 0;
DECLARE visited INT DEFAULT 0;
DECLARE marker INT;DECLARE customer BIGINT;DECLARE parent BIGINT;DECLARE line BIGINT;
DECLARE affected CURSOR FOR SELECT id,user_id,order_id,has_product_id FROM spiderman_screening_orders WHERE order_id=OLD.id OR order_id=NEW.id ORDER BY user_id,id LIMIT 10001;
DECLARE CONTINUE HANDLER FOR NOT FOUND SET finished=1;
IF NOT(OLD.id<=>NEW.id) OR IF(OLD.order_status NOT IN(0,17),1,0)<>IF(NEW.order_status NOT IN(0,17),1,0) THEN
 OPEN affected;
 scan_markers: LOOP
  FETCH affected INTO marker,customer,parent,line;
  IF finished=1 THEN LEAVE scan_markers;END IF;
  SET visited=visited+1;
  IF visited>10000 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening counter parent is too large';END IF;
  CALL pos_screening_sync_marker(marker,1,customer,parent,line);
 END LOOP;
 CLOSE affected;
END IF;
END$$
CREATE TRIGGER pos_screening_has_products_update AFTER UPDATE ON has_products FOR EACH ROW BEGIN
DECLARE finished INT DEFAULT 0;
DECLARE visited INT DEFAULT 0;
DECLARE marker INT;DECLARE customer BIGINT;DECLARE parent BIGINT;DECLARE line BIGINT;
DECLARE affected CURSOR FOR SELECT id,user_id,order_id,has_product_id FROM spiderman_screening_orders WHERE has_product_id=OLD.id OR has_product_id=NEW.id ORDER BY user_id,id LIMIT 10001;
DECLARE CONTINUE HANDLER FOR NOT FOUND SET finished=1;
IF NOT(OLD.id<=>NEW.id) OR IF(OLD.prod_id=390238,1,0)<>IF(NEW.prod_id=390238,1,0) THEN
 OPEN affected;
 scan_markers: LOOP
  FETCH affected INTO marker,customer,parent,line;
  IF finished=1 THEN LEAVE scan_markers;END IF;
  SET visited=visited+1;
  IF visited>10000 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening counter parent is too large';END IF;
  CALL pos_screening_sync_marker(marker,1,customer,parent,line);
 END LOOP;
 CLOSE affected;
END IF;
END$$
CREATE TRIGGER pos_screening_markers_update AFTER UPDATE ON spiderman_screening_orders FOR EACH ROW BEGIN
IF NOT(OLD.id<=>NEW.id) THEN
 CALL pos_screening_sync_marker(OLD.id,1,OLD.user_id,OLD.order_id,OLD.has_product_id);
 CALL pos_screening_sync_marker(NEW.id,0,NULL,NULL,NULL);
ELSEIF NOT(OLD.user_id<=>NEW.user_id) OR NOT(OLD.order_id<=>NEW.order_id) OR NOT(OLD.has_product_id<=>NEW.has_product_id) THEN
 CALL pos_screening_sync_marker(NEW.id,1,OLD.user_id,OLD.order_id,OLD.has_product_id);
END IF;
END$$
CREATE TRIGGER pos_screening_orders_delete AFTER DELETE ON orders FOR EACH ROW BEGIN
DECLARE finished INT DEFAULT 0;
DECLARE visited INT DEFAULT 0;
DECLARE marker INT;DECLARE customer BIGINT;DECLARE parent BIGINT;DECLARE line BIGINT;
DECLARE affected CURSOR FOR SELECT id,user_id,order_id,has_product_id FROM spiderman_screening_orders WHERE order_id=OLD.id ORDER BY user_id,id LIMIT 10001;
DECLARE CONTINUE HANDLER FOR NOT FOUND SET finished=1;
IF TRUE THEN
 OPEN affected;
 scan_markers: LOOP
  FETCH affected INTO marker,customer,parent,line;
  IF finished=1 THEN LEAVE scan_markers;END IF;
  SET visited=visited+1;
  IF visited>10000 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening counter parent is too large';END IF;
  CALL pos_screening_sync_marker(marker,1,customer,parent,line);
 END LOOP;
 CLOSE affected;
END IF;
END$$
CREATE TRIGGER pos_screening_has_products_delete AFTER DELETE ON has_products FOR EACH ROW BEGIN
DECLARE finished INT DEFAULT 0;
DECLARE visited INT DEFAULT 0;
DECLARE marker INT;DECLARE customer BIGINT;DECLARE parent BIGINT;DECLARE line BIGINT;
DECLARE affected CURSOR FOR SELECT id,user_id,order_id,has_product_id FROM spiderman_screening_orders WHERE has_product_id=OLD.id ORDER BY user_id,id LIMIT 10001;
DECLARE CONTINUE HANDLER FOR NOT FOUND SET finished=1;
IF TRUE THEN
 OPEN affected;
 scan_markers: LOOP
  FETCH affected INTO marker,customer,parent,line;
  IF finished=1 THEN LEAVE scan_markers;END IF;
  SET visited=visited+1;
  IF visited>10000 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Screening counter parent is too large';END IF;
  CALL pos_screening_sync_marker(marker,1,customer,parent,line);
 END LOOP;
 CLOSE affected;
END IF;
END$$
CREATE TRIGGER pos_screening_markers_delete AFTER DELETE ON spiderman_screening_orders FOR EACH ROW BEGIN
CALL pos_screening_sync_marker(OLD.id,1,OLD.user_id,OLD.order_id,OLD.has_product_id);
END$$
DELIMITER ;
