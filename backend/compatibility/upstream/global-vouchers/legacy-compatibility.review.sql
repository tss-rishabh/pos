-- REVIEW ONLY. Never included in automatic rewrite migrations.
-- Preflight physical metadata, reader/consumer compatibility and rollout acceptance.
ALTER TABLE coupons MODIFY end_date DATETIME NULL;
ALTER TABLE gift_vouchers MODIFY start_date DATETIME NULL, MODIFY end_date DATETIME NULL;
ALTER TABLE gift_voucher_history MODIFY platform enum('ORDER_PLACED','ORDER_CANCELLED','ORDER_REFUND','ORDER_MONEY','ORDER_RETURN','PAYMENT_FAILED','PRODUCT_RETURN','COURIER_COMPENSATION','DEFECTIVE_PRODUCT','PRODUCT_MISSING','PRODUCT_OUT_OF_STOCK','MISC_COMPENSATION','GV_ADD') CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NULL;
