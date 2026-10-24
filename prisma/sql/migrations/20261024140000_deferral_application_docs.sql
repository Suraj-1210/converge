-- Portal Testing Day 5 (21 Oct, decisions with Suraj 24 Oct 2026). Additive
-- only — the version still serving during a deploy ignores the new columns.
--
--   application.deferred_*
--       Deferring to a later intake no longer closes the application. The
--       counsellor picks the new intake (month + year) and the application
--       stays open at its stage (a visa stage goes back to Deposit Paid, as
--       the visa is filed for the new intake). deferred_from_intake is the
--       intake shown before the deferral, for the record. Older rows closed
--       as "Deferred to Next Intake" (status 24) are left as they are.
--
--   application_partner_report.deferred_intake_*
--       A partner reporting a deferral names the new intake; confirming the
--       report applies it.
--
--   document.application_id / review_*
--       Documents a partner uploads for one application after Deposit Paid
--       (deposit slip, visa documents, visa approved copy) are tied to it, and
--       a Collegepond counsellor verifies or rejects them (document.status
--       0 pending / 1 approved / 2 rejected, with a note on rejection).

-- ---- application.deferred_* -----------------------------------------------
SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application'
    AND COLUMN_NAME = 'deferred_at');
SET @sql := IF(@todo,
  'ALTER TABLE `application`
     ADD COLUMN `deferred_intake_month`  TINYINT UNSIGNED  NULL DEFAULT NULL,
     ADD COLUMN `deferred_intake_year`   SMALLINT UNSIGNED NULL DEFAULT NULL,
     ADD COLUMN `deferred_from_intake`   VARCHAR(40)       NULL DEFAULT NULL,
     ADD COLUMN `deferred_at`            TIMESTAMP         NULL DEFAULT NULL,
     ADD COLUMN `deferred_by_cp_user_id` INT               NULL DEFAULT NULL,
     ADD COLUMN `deferred_note`          VARCHAR(255)      NULL DEFAULT NULL,
     ADD INDEX `idx_application_deferred` (`deferred_at` ASC),
     ADD INDEX `fk_application_deferred_by_idx` (`deferred_by_cp_user_id` ASC),
     ADD CONSTRAINT `fk_application_deferred_by`
       FOREIGN KEY (`deferred_by_cp_user_id`) REFERENCES `cp_user` (`id`)
       ON DELETE SET NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- application_partner_report.deferred_intake_* -------------------------
SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application_partner_report'
    AND COLUMN_NAME = 'deferred_intake_month');
SET @sql := IF(@todo,
  'ALTER TABLE `application_partner_report`
     ADD COLUMN `deferred_intake_month` TINYINT UNSIGNED  NULL DEFAULT NULL,
     ADD COLUMN `deferred_intake_year`  SMALLINT UNSIGNED NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- document.application_id / review_* -----------------------------------
SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'document'
    AND COLUMN_NAME = 'application_id');
SET @sql := IF(@todo,
  'ALTER TABLE `document`
     ADD COLUMN `application_id`         INT          NULL DEFAULT NULL,
     ADD COLUMN `review_note`            VARCHAR(255) NULL DEFAULT NULL,
     ADD COLUMN `reviewed_at`            TIMESTAMP    NULL DEFAULT NULL,
     ADD COLUMN `reviewed_by_cp_user_id` INT          NULL DEFAULT NULL,
     ADD INDEX `fk_document_application_idx` (`application_id` ASC),
     ADD INDEX `fk_document_reviewed_by_idx` (`reviewed_by_cp_user_id` ASC),
     ADD CONSTRAINT `fk_document_application`
       FOREIGN KEY (`application_id`) REFERENCES `application` (`id`)
       ON DELETE SET NULL ON UPDATE CASCADE,
     ADD CONSTRAINT `fk_document_reviewed_by`
       FOREIGN KEY (`reviewed_by_cp_user_id`) REFERENCES `cp_user` (`id`)
       ON DELETE SET NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
