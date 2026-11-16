-- Why a university rejected an application (16 Nov testing): a reason is
-- required when staff move an application to Rejected, so rejections can be
-- counted by reason. Partners see it in the email and on the application.
--
--   application.rejection_reason  code from RejectionReason (enums.ts)
--   application.rejection_note    the text for "Other" (optional otherwise)
--
-- Additive, no backfill: older rejections have no reason.

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application'
    AND COLUMN_NAME = 'rejection_reason');
SET @sql := IF(@todo,
  'ALTER TABLE `application`
     ADD COLUMN `rejection_reason` TINYINT UNSIGNED NULL DEFAULT NULL AFTER `deferred_note`,
     ADD COLUMN `rejection_note` VARCHAR(500) NULL DEFAULT NULL AFTER `rejection_reason`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
