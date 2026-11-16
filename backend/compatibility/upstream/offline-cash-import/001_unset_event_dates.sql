-- pos-offline-cash-order-schema-v1, reviewed compatibility candidate only.
-- Apply on the confirmed writer through the deployment migration process.
-- Existing rows are not rewritten. Indexes, money and order timestamps are retained.
-- A newly placed unshipped/unreturned order has no corresponding event date.
ALTER TABLE orders
  MODIFY COLUMN ship_date DATETIME NULL DEFAULT NULL,
  MODIFY COLUMN ret_ex_request_date DATETIME NULL DEFAULT NULL;
