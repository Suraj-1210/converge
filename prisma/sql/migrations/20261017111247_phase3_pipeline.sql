-- Phase 3A: application pipeline and status (Suraj's 16 Oct test feedback,
-- decisions agreed 17 Oct 2026). Additive only — the version still serving
-- during a deploy ignores the new columns and table.
--
--   application.pending_docs
--       The documents a Collegepond counsellor named when moving the
--       application to Documents Pending: [{"key","label","receivedAt"}].
--       key is a STUDENT_DOC_TYPES key or "other" (free text in label);
--       receivedAt is set when a matching document is uploaded (or a
--       counsellor ticks it off).
--
--   student.inactive_*
--       A manual Inactive set by a Collegepond counsellor, with a reason
--       (not_responding / dropped_plans / other_provider / other + note).
--       It wins over the derived overall status until someone reactivates
--       (inactive_at back to NULL). The derived status itself is not stored.
--
--   application_partner_report
--       A partner's report of Deposit Paid (from Unconditional Offer) or a
--       visa outcome (from Visa Filed), with the supporting document filed
--       into the student's documents. It changes nothing until a Collegepond
--       counsellor confirms it (status 1) or rejects it (status 2).
--
-- No status codes change: Visa Filed is the new code 9 (application) and 46
-- (student) in src/server/db/enums.ts, so existing rows are untouched.

-- ---- application.pending_docs ---------------------------------------------
SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application'
    AND COLUMN_NAME = 'pending_docs');
SET @sql := IF(@todo,
  'ALTER TABLE `application` ADD COLUMN `pending_docs` JSON NULL DEFAULT NULL AFTER `conditional_docs`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- student.inactive_* ---------------------------------------------------
SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'student'
    AND COLUMN_NAME = 'inactive_at');
SET @sql := IF(@todo,
  'ALTER TABLE `student`
     ADD COLUMN `inactive_at`            TIMESTAMP    NULL DEFAULT NULL,
     ADD COLUMN `inactive_reason`        VARCHAR(20)  NULL DEFAULT NULL,
     ADD COLUMN `inactive_note`          VARCHAR(255) NULL DEFAULT NULL,
     ADD COLUMN `inactive_by_cp_user_id` INT          NULL DEFAULT NULL,
     ADD INDEX `fk_student_inactive_by_idx` (`inactive_by_cp_user_id` ASC),
     ADD CONSTRAINT `fk_student_inactive_by`
       FOREIGN KEY (`inactive_by_cp_user_id`) REFERENCES `cp_user` (`id`)
       ON DELETE SET NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- application_partner_report -------------------------------------------
CREATE TABLE IF NOT EXISTS `application_partner_report` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `application_id`        INT NOT NULL,
  `from_status`           TINYINT UNSIGNED NOT NULL,  -- application.status when reported
  `target_status`         TINYINT UNSIGNED NOT NULL,  -- what the partner reports
  `document_id`           INT NULL DEFAULT NULL,      -- supporting file (student document)
  `note`                  VARCHAR(500) NULL DEFAULT NULL,
  `reported_by_user_id`   INT NULL DEFAULT NULL,
  `status`                TINYINT UNSIGNED NOT NULL DEFAULT 0,  -- 0 pending, 1 confirmed, 2 rejected
  `decided_by_cp_user_id` INT NULL DEFAULT NULL,
  `decided_at`            TIMESTAMP NULL DEFAULT NULL,
  `decision_note`         VARCHAR(500) NULL DEFAULT NULL,
  `created_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_apr_application_status` (`application_id` ASC, `status` ASC) VISIBLE,
  INDEX `fk_apr_document_idx` (`document_id` ASC) VISIBLE,
  INDEX `fk_apr_user_idx` (`reported_by_user_id` ASC) VISIBLE,
  INDEX `fk_apr_cp_user_idx` (`decided_by_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_apr_application`
    FOREIGN KEY (`application_id`) REFERENCES `application` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_apr_document`
    FOREIGN KEY (`document_id`) REFERENCES `document` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_apr_user`
    FOREIGN KEY (`reported_by_user_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_apr_cp_user`
    FOREIGN KEY (`decided_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;
