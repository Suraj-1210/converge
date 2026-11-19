-- Shortlist rejection reason (19 Nov 2026). When Collegepond rejects a
-- partner-proposed university it picks a reason from the same list as an
-- application moved to Rejected (RejectionReason: Low Academic Profile ...
-- Other), so we can see where students had no real chance. reject_reason
-- keeps the note ("Other" needs one).
--
-- Additive and idempotent.

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shortlist' AND COLUMN_NAME = 'reject_reason_code');
SET @sql := IF(@add,
  'ALTER TABLE `shortlist` ADD COLUMN `reject_reason_code` TINYINT UNSIGNED NULL DEFAULT NULL AFTER `reject_reason`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
