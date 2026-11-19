-- Loan lead sharing: chat between the loan counsellor and the partner
-- (19 Nov 2026; contract section 4). loan_referral_message now holds both
-- sides of the conversation:
--
--   side         'partner' (sent from Converge) or 'staff' (the counsellor,
--                arriving from the Enrollment App as chat.message events)
--   external_id  the Enrollment chat message id for staff messages (unique:
--                a re-delivered event is stored once)
--   emailed_at   staff messages: when the "unread for 15 minutes" email went
--                to the referrer (or when it was settled without one)
--
--   loan_chat_read  per partner user and referral: read up to when.
--
-- Additive and idempotent.

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loan_referral_message' AND COLUMN_NAME = 'side');
SET @sql := IF(@add,
  'ALTER TABLE `loan_referral_message` ADD COLUMN `side` VARCHAR(10) NOT NULL DEFAULT ''partner'' AFTER `referral_id`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loan_referral_message' AND COLUMN_NAME = 'external_id');
SET @sql := IF(@add,
  'ALTER TABLE `loan_referral_message` ADD COLUMN `external_id` VARCHAR(80) NULL DEFAULT NULL AFTER `side`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loan_referral_message' AND COLUMN_NAME = 'emailed_at');
SET @sql := IF(@add,
  'ALTER TABLE `loan_referral_message` ADD COLUMN `emailed_at` TIMESTAMP NULL DEFAULT NULL AFTER `activity_id`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loan_referral_message' AND INDEX_NAME = 'uq_loan_referral_message_external');
SET @sql := IF(@add,
  'ALTER TABLE `loan_referral_message` ADD UNIQUE INDEX `uq_loan_referral_message_external` (`external_id` ASC) VISIBLE',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `loan_chat_read` (
  `referral_id` INT          NOT NULL,
  `user_id`     INT          NOT NULL,
  `read_at`     TIMESTAMP(3) NOT NULL,
  PRIMARY KEY (`referral_id`, `user_id`),
  INDEX `idx_loan_chat_read_user` (`user_id` ASC) VISIBLE,
  CONSTRAINT `fk_loan_chat_read_referral`
    FOREIGN KEY (`referral_id`) REFERENCES `loan_referral` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_loan_chat_read_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;
