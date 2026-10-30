-- Application follow-ups (tester doc 29 Oct 2026, decided with Suraj 30 Oct).
-- Once an application is with the university (Application Submitted /
-- Application Under Review), its counsellor schedules follow-ups, one at a
-- time and as many as needed. src/server/follow-ups.ts has the rules.
--
--   application.decision_expected_weeks
--       How long the university is expected to take to decide, counted from
--       submitted_at. NULL = not set yet (the app falls back to 1 week for a
--       Faster TAT course, otherwise 4).
--
--   application_follow_up
--       One row per follow-up. seq numbers them per application (Follow-up
--       1, 2, 3 …). A row is open until completed_at (the counsellor ticked
--       it) or closed_at (auto-closed when the application left the
--       submitted/review stages). Never deleted.
--       due_notified_at / overdue_emailed_at / overdue_reminded_on record
--       what the daily /api/cron/follow-ups run already sent, so running it
--       twice sends nothing twice; a reschedule clears them.
--       The cp_user ids are loose references (no FK), like
--       application_partner_report.decided_by_cp_user_id.
--
-- Additive only: one new nullable column and one new table. A re-run is a
-- no-op.

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application'
    AND COLUMN_NAME = 'decision_expected_weeks');
SET @sql := IF(@todo,
  'ALTER TABLE `application`
     ADD COLUMN `decision_expected_weeks` TINYINT UNSIGNED NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `application_follow_up` (
  `id`                      INT               NOT NULL AUTO_INCREMENT,
  `application_id`          INT               NOT NULL,
  `seq`                     SMALLINT UNSIGNED NOT NULL,
  `due_date`                DATE              NOT NULL,
  `completed_at`            TIMESTAMP         NULL DEFAULT NULL,
  `completed_by_cp_user_id` INT               NULL DEFAULT NULL,
  `closed_at`               TIMESTAMP         NULL DEFAULT NULL,
  `closed_reason`           VARCHAR(100)      NULL DEFAULT NULL,
  `due_notified_at`         TIMESTAMP         NULL DEFAULT NULL,
  `overdue_emailed_at`      TIMESTAMP         NULL DEFAULT NULL,
  `overdue_reminded_on`     DATE              NULL DEFAULT NULL,
  `created_by_cp_user_id`   INT               NULL DEFAULT NULL,
  `created_at`              TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_follow_up_application_seq` (`application_id` ASC, `seq` ASC) VISIBLE,
  INDEX `idx_follow_up_open_due` (`completed_at` ASC, `closed_at` ASC, `due_date` ASC) VISIBLE,
  CONSTRAINT `fk_follow_up_application`
    FOREIGN KEY (`application_id`) REFERENCES `application` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;
