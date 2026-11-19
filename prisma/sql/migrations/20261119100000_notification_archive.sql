-- Clearing notifications (19 Nov 2026). Suraj: "we have mark all read but no
-- way to clear the notifications. We should also be able to track archived
-- notifications."
--
-- `archived_at` on both feeds (partner `notification`, staff
-- `cp_notification`): set when the person clears an item from the bell (or
-- Clear all). Cleared items leave the bell but stay on the Notifications page
-- ("See older notifications"), searchable, and can be restored. Nothing is
-- deleted.
--
-- Additive and idempotent: each column / index is added only if missing.

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification' AND COLUMN_NAME = 'archived_at');
SET @sql := IF(@add,
  'ALTER TABLE `notification`
     ADD COLUMN `archived_at` TIMESTAMP NULL DEFAULT NULL AFTER `read_at`,
     ADD INDEX `idx_notification_user_archived` (`user_id` ASC, `archived_at` ASC, `created_at` ASC)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cp_notification' AND COLUMN_NAME = 'archived_at');
SET @sql := IF(@add,
  'ALTER TABLE `cp_notification`
     ADD COLUMN `archived_at` TIMESTAMP NULL DEFAULT NULL AFTER `read_at`,
     ADD INDEX `idx_cp_notification_user_archived` (`cp_user_id` ASC, `archived_at` ASC, `created_at` ASC)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
