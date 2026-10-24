-- Out of office, the staff notification feed, and partner chat reply-time
-- rules (Portal Testing Day 5, decided by Suraj 24 Oct 2026).
--
-- cp_out_of_office: one row per Collegepond counsellor (or lead): the From and
--   To dates (inclusive, in the TAT timezone) and the alternate who covers
--   them. "Out" is worked out from the dates, so it ends by itself after the
--   To date. While out, the alternate gets the counsellor's partner chats,
--   their chat reply TAT and their new auto-assigned students
--   (src/server/out-of-office.ts). Set by the counsellor, their Counselling
--   Lead or a Super Admin. Changes are audit-logged.
-- cp_notification: the persistent in-app feed for Collegepond staff (the
--   staff counterpart of `notification`, which is for partner users). It backs
--   the admin Notifications page's history. The admin bell still also shows
--   the live, derived signals.
-- partner_chat_message.no_reply_needed_*: a Collegepond user marked a partner
--   message "No reply needed", which takes it off the reply clock.
-- tat_setting.chat_ack_*: short acknowledgements ("thanks", "ok", 👍 …) that
--   don't start the reply clock. NULL phrases = the built-in default list.
--
-- Additive only: two new tables and nullable/defaulted columns. Guarded by
-- information_schema checks so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS `cp_out_of_office` (
  `id`                   INT       NOT NULL AUTO_INCREMENT,
  `cp_user_id`           INT       NOT NULL,
  `from_date`            DATE      NOT NULL,
  `to_date`              DATE      NOT NULL,
  `alternate_cp_user_id` INT       NOT NULL,
  `set_by_cp_user_id`    INT       NULL DEFAULT NULL,
  `created_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_cp_out_of_office_user` (`cp_user_id` ASC) VISIBLE,
  INDEX `fk_cp_out_of_office_alternate_idx` (`alternate_cp_user_id` ASC) VISIBLE,
  INDEX `idx_cp_out_of_office_dates` (`from_date` ASC, `to_date` ASC) VISIBLE,
  CONSTRAINT `fk_cp_out_of_office_user`
    FOREIGN KEY (`cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_cp_out_of_office_alternate`
    FOREIGN KEY (`alternate_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `cp_notification` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `cp_user_id` INT          NOT NULL,
  `type`       VARCHAR(50)  NOT NULL,
  `title`      VARCHAR(255) NOT NULL,
  `body`       VARCHAR(500) NULL DEFAULT NULL,
  `link`       VARCHAR(255) NULL DEFAULT NULL,
  `tone`       VARCHAR(10)  NOT NULL DEFAULT 'blue',
  `read_at`    TIMESTAMP    NULL DEFAULT NULL,
  `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_cp_notification_user_created` (`cp_user_id` ASC, `created_at` ASC) VISIBLE,
  INDEX `idx_cp_notification_user_read` (`cp_user_id` ASC, `read_at` ASC) VISIBLE,
  CONSTRAINT `fk_cp_notification_user`
    FOREIGN KEY (`cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'partner_chat_message'
    AND COLUMN_NAME = 'no_reply_needed_at');
SET @sql := IF(@add,
  'ALTER TABLE `partner_chat_message`
     ADD COLUMN `no_reply_needed_at`            TIMESTAMP NULL DEFAULT NULL AFTER `tat_counsellor_cp_user_id`,
     ADD COLUMN `no_reply_needed_by_cp_user_id` INT       NULL DEFAULT NULL AFTER `no_reply_needed_at`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tat_setting'
    AND COLUMN_NAME = 'chat_ack_phrases');
SET @sql := IF(@add,
  'ALTER TABLE `tat_setting`
     ADD COLUMN `chat_ack_phrases`    VARCHAR(1000) NULL DEFAULT NULL AFTER `day_end_minute`,
     ADD COLUMN `chat_ack_max_length` SMALLINT      NOT NULL DEFAULT 40 AFTER `chat_ack_phrases`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
