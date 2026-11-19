-- Loan documents from the partner (19 Nov 2026; contract section 5).
--
--   loan_doc_item    the lead's document list as the Enrollment App last sent
--                    it (docs.checklist): one row per item, replaced whole;
--                    loan_referral.checklist_synced_at = when (newest wins).
--   loan_doc_upload  one partner upload for one item (files, or the student's
--                    Converge profile document), its delivery to the
--                    Enrollment App (send_status like loan_referral) and the
--                    counsellor's review ('received' | 'accepted' | 'reupload').
--   loan_doc_file    the files of an upload (PDF / JPG / PNG, private storage).
--
-- Additive and idempotent.

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loan_referral' AND COLUMN_NAME = 'checklist_synced_at');
SET @sql := IF(@add,
  'ALTER TABLE `loan_referral` ADD COLUMN `checklist_synced_at` TIMESTAMP(3) NULL DEFAULT NULL AFTER `lead_synced_at`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `loan_doc_item` (
  `referral_id`       INT              NOT NULL,
  `item_key`          VARCHAR(80)      NOT NULL,
  `label`             VARCHAR(200)     NOT NULL,
  `grp`               VARCHAR(20)      NOT NULL,
  `required`          TINYINT          NOT NULL DEFAULT 0,
  `converge_doc_type` VARCHAR(50)      NULL DEFAULT NULL,
  `sort`              SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`referral_id`, `item_key`),
  CONSTRAINT `fk_loan_doc_item_referral`
    FOREIGN KEY (`referral_id`) REFERENCES `loan_referral` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_doc_upload` (
  `id`              INT               NOT NULL AUTO_INCREMENT,
  `public_id`       CHAR(36)          NOT NULL,
  `referral_id`     INT               NOT NULL,
  `item_key`        VARCHAR(80)       NOT NULL,
  `author_user_id`  INT               NULL DEFAULT NULL,
  `author_name`     VARCHAR(150)      NOT NULL,
  `source`          VARCHAR(20)       NOT NULL DEFAULT 'upload',
  `send_status`     TINYINT UNSIGNED  NOT NULL DEFAULT 0,
  `send_attempts`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `next_attempt_at` TIMESTAMP         NULL DEFAULT NULL,
  `last_error`      VARCHAR(500)      NULL DEFAULT NULL,
  `review_status`   VARCHAR(10)       NOT NULL DEFAULT 'received',
  `review_reason`   VARCHAR(500)      NULL DEFAULT NULL,
  `reviewed_by`     VARCHAR(150)      NULL DEFAULT NULL,
  `reviewed_at`     TIMESTAMP(3)      NULL DEFAULT NULL,
  `created_at`      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_loan_doc_upload_public_id` (`public_id` ASC) VISIBLE,
  INDEX `idx_loan_doc_upload_referral` (`referral_id` ASC, `item_key` ASC) VISIBLE,
  INDEX `idx_loan_doc_upload_send` (`send_status` ASC, `next_attempt_at` ASC) VISIBLE,
  INDEX `idx_loan_doc_upload_author` (`author_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_loan_doc_upload_referral`
    FOREIGN KEY (`referral_id`) REFERENCES `loan_referral` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_loan_doc_upload_author`
    FOREIGN KEY (`author_user_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_doc_file` (
  `id`           INT          NOT NULL AUTO_INCREMENT,
  `upload_id`    INT          NOT NULL,
  `file_name`    VARCHAR(200) NOT NULL,
  `storage_ref`  VARCHAR(255) NOT NULL,
  `content_type` VARCHAR(40)  NOT NULL,
  `size`         INT UNSIGNED NOT NULL,
  `sha256`       CHAR(64)     NOT NULL,
  `created_at`   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_loan_doc_file_upload` (`upload_id` ASC) VISIBLE,
  CONSTRAINT `fk_loan_doc_file_upload`
    FOREIGN KEY (`upload_id`) REFERENCES `loan_doc_upload` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;
