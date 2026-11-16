-- Review-only source compatibility candidate; never run by the application migration runner.
-- Apply only on the confirmed writer through the explicitly approved deployment process.
-- A new courier log has no delivery exception yet. Preserve every existing row/date.
ALTER TABLE hyperlocal_order_log
  MODIFY COLUMN delivery_exception_date DATETIME NULL DEFAULT NULL;
