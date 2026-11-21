-- Loan documents: "Additional documents" (21 Nov 2026; contract 5c). Besides
-- the loan team's list, a partner may upload any number of other documents,
-- each with their own label, for case-specific requests from the counsellor.
-- Such an upload has item_key 'additional' (no loan_doc_item row) and its
-- label here; list uploads leave label NULL.
--
-- Additive only: one nullable column.

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loan_doc_upload' AND COLUMN_NAME = 'label');
SET @sql := IF(@add,
  'ALTER TABLE `loan_doc_upload` ADD COLUMN `label` VARCHAR(160) NULL DEFAULT NULL AFTER `item_key`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
