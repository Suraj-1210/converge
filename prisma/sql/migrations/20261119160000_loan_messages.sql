-- Loan lead sharing, Phase 2 (19 Nov 2026): the conversation on a loan lead.
--
--   loan_referral_event.synced_at  for counsellor notes shared with the partner
--                                  (one row per note, event_id
--                                  "note:<referral>:<noteId>"): occurredAt of
--                                  the last state applied, newest wins.
--   loan_referral_message          a partner's reply on the lead, sent to the
--                                  Enrollment App (send_status like
--                                  loan_referral: 0 sending, 1 sent, 3 failed).
--   loan_referral_message_file     PDFs attached to a reply (private storage).
--
-- Additive and idempotent.

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loan_referral_event' AND COLUMN_NAME = 'synced_at');
SET @sql := IF(@add,
  'ALTER TABLE `loan_referral_event` ADD COLUMN `synced_at` TIMESTAMP(3) NULL DEFAULT NULL AFTER `occurred_at`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `loan_referral_message` (
  `id`              INT               NOT NULL AUTO_INCREMENT,
  `public_id`       CHAR(36)          NOT NULL,
  `referral_id`     INT               NOT NULL,
  `author_user_id`  INT               NULL DEFAULT NULL,
  `author_name`     VARCHAR(150)      NOT NULL,
  `body`            VARCHAR(2000)     NOT NULL DEFAULT '',
  `send_status`     TINYINT UNSIGNED  NOT NULL DEFAULT 0,
  `send_attempts`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `next_attempt_at` TIMESTAMP         NULL DEFAULT NULL,
  `last_error`      VARCHAR(500)      NULL DEFAULT NULL,
  `activity_id`     VARCHAR(64)       NULL DEFAULT NULL,
  `created_at`      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_loan_referral_message_public_id` (`public_id` ASC) VISIBLE,
  INDEX `idx_loan_referral_message_referral` (`referral_id` ASC, `created_at` ASC) VISIBLE,
  INDEX `idx_loan_referral_message_send` (`send_status` ASC, `next_attempt_at` ASC) VISIBLE,
  INDEX `idx_loan_referral_message_author` (`author_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_loan_referral_message_referral`
    FOREIGN KEY (`referral_id`) REFERENCES `loan_referral` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_loan_referral_message_author`
    FOREIGN KEY (`author_user_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_referral_message_file` (
  `id`          INT          NOT NULL AUTO_INCREMENT,
  `message_id`  INT          NOT NULL,
  `file_name`   VARCHAR(200) NOT NULL,
  `storage_ref` VARCHAR(255) NOT NULL,
  `size`        INT UNSIGNED NOT NULL,
  `sha256`      CHAR(64)     NOT NULL,
  `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_loan_referral_message_file_message` (`message_id` ASC) VISIBLE,
  CONSTRAINT `fk_loan_referral_message_file_message`
    FOREIGN KEY (`message_id`) REFERENCES `loan_referral_message` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;
