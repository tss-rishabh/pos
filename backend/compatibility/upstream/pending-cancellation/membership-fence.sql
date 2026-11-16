-- Review-only source-table fence. Not an automatic rewrite migration.
-- Prerequisites: native users.email utf8mb3_general_ci full index and
-- user_eav(entity,attribute) full primary/unique prefix; strict SQL mode.
DELIMITER $$
CREATE TRIGGER pos_rewrite_mem_eav_insert AFTER INSERT ON user_eav FOR EACH ROW
BEGIN
  DECLARE owner_id BIGINT DEFAULT NULL;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET owner_id = NULL;
  IF NEW.attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY') THEN
    SELECT id INTO owner_id FROM users
      WHERE email = CONVERT(NEW.entity USING utf8mb3) COLLATE utf8mb3_general_ci
      ORDER BY id LIMIT 2 FOR UPDATE;
    IF owner_id IS NOT NULL THEN
      IF owner_id < 1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Membership identity requires review'; END IF;
      INSERT INTO pos_rewrite_membership_versions(customer_id,revision) VALUES(owner_id,1)
        ON DUPLICATE KEY UPDATE revision=revision+1;
    END IF;
  END IF;
END$$
CREATE TRIGGER pos_rewrite_mem_eav_update AFTER UPDATE ON user_eav FOR EACH ROW
BEGIN
  DECLARE old_owner BIGINT DEFAULT NULL;
  DECLARE new_owner BIGINT DEFAULT NULL;
  DECLARE missing_owner INT DEFAULT 0;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET missing_owner = 1;
  IF (OLD.attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY') OR NEW.attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY')) AND
     (NOT (BINARY OLD.entity <=> BINARY NEW.entity) OR NOT (OLD.attribute <=> NEW.attribute) OR
      NOT (BINARY OLD.value <=> BINARY NEW.value) OR NOT (OLD.is_active <=> NEW.is_active) OR
      NOT (OLD.created_at <=> NEW.created_at) OR NOT (OLD.updated_at <=> NEW.updated_at)) THEN
    IF OLD.attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY') THEN
      SELECT id INTO old_owner FROM users
        WHERE email = CONVERT(OLD.entity USING utf8mb3) COLLATE utf8mb3_general_ci
        ORDER BY id LIMIT 2 FOR UPDATE;
    END IF;
    IF NEW.attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY') THEN
      SELECT id INTO new_owner FROM users
        WHERE email = CONVERT(NEW.entity USING utf8mb3) COLLATE utf8mb3_general_ci
        ORDER BY id LIMIT 2 FOR UPDATE;
    END IF;
    IF old_owner IS NOT NULL THEN
      IF old_owner < 1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Membership identity requires review'; END IF;
      INSERT INTO pos_rewrite_membership_versions(customer_id,revision) VALUES(old_owner,1)
        ON DUPLICATE KEY UPDATE revision=revision+1;
    END IF;
    IF new_owner IS NOT NULL AND NOT (new_owner <=> old_owner) THEN
      IF new_owner < 1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Membership identity requires review'; END IF;
      INSERT INTO pos_rewrite_membership_versions(customer_id,revision) VALUES(new_owner,1)
        ON DUPLICATE KEY UPDATE revision=revision+1;
    END IF;
  END IF;
END$$
CREATE TRIGGER pos_rewrite_mem_eav_delete AFTER DELETE ON user_eav FOR EACH ROW
BEGIN
  DECLARE owner_id BIGINT DEFAULT NULL;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET owner_id = NULL;
  IF OLD.attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY') THEN
    SELECT id INTO owner_id FROM users
      WHERE email = CONVERT(OLD.entity USING utf8mb3) COLLATE utf8mb3_general_ci
      ORDER BY id LIMIT 2 FOR UPDATE;
    IF owner_id IS NOT NULL THEN
      IF owner_id < 1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Membership identity requires review'; END IF;
      INSERT INTO pos_rewrite_membership_versions(customer_id,revision) VALUES(owner_id,1)
        ON DUPLICATE KEY UPDATE revision=revision+1;
    END IF;
  END IF;
END$$
CREATE TRIGGER pos_rewrite_mem_user_email AFTER UPDATE ON users FOR EACH ROW
BEGIN
  IF NOT (BINARY OLD.email <=> BINARY NEW.email) THEN
    INSERT INTO pos_rewrite_membership_versions(customer_id,revision) VALUES(NEW.id,1)
      ON DUPLICATE KEY UPDATE revision=revision+1;
  END IF;
END$$
DELIMITER ;
