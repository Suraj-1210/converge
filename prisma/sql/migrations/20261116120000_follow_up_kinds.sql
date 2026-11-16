-- Follow-up kinds (16 Nov 2026 change list, items 4B and 5; Suraj's
-- decisions). The application follow-ups from 20261030120000 gain a kind,
-- so one system covers three things (src/server/follow-ups.ts has the rules):
--
--   decision  the university's decision (every existing row)
--   deposit   created automatically 7 days before application.deposit_deadline;
--             closes by itself at Deposit Paid (the counsellor is emailed)
--   visa      the visa file, weekly from the visa documentation stage until
--             the visa is uploaded or the outcome is recorded
--
-- New columns on application_follow_up:
--   kind                 'decision' | 'deposit' | 'visa'. Existing rows: 'decision'.
--   anchor_date          deposit: the deposit deadline this follow-up was made
--                        for, so a changed deadline moves it and the same one
--                        never makes a second.
--   respond_within_days  visa: days the partner is asked to respond within.
--   remarks              visa: notes for the follow-up (carried to the next week).
--   ics_sequence         calendar invite SEQUENCE: bumped on every date change.
--   ics_sent_sequence    the SEQUENCE last emailed as an invite (NULL = none yet;
--                        existing rows get 0 so no backlog of invites goes out).
--   ics_sent_to          the address holding the invite, for the cancellation.
--
-- Numbering is per kind now: the unique key (application_id, seq) becomes
-- (application_id, kind, seq). The new index is added BEFORE the old one is
-- dropped: fk_follow_up_application needs an index led by application_id.
--
-- Additive and idempotent (information_schema guards); a re-run is a no-op.

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application_follow_up' AND COLUMN_NAME = 'kind');
SET @sql := IF(@todo,
  'ALTER TABLE `application_follow_up`
     ADD COLUMN `kind` VARCHAR(10) NOT NULL DEFAULT ''decision'' AFTER `application_id`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application_follow_up' AND COLUMN_NAME = 'anchor_date');
SET @sql := IF(@todo,
  'ALTER TABLE `application_follow_up`
     ADD COLUMN `anchor_date` DATE NULL DEFAULT NULL AFTER `due_date`,
     ADD COLUMN `respond_within_days` TINYINT UNSIGNED NULL DEFAULT NULL AFTER `anchor_date`,
     ADD COLUMN `remarks` VARCHAR(1000) NULL DEFAULT NULL AFTER `respond_within_days`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application_follow_up' AND COLUMN_NAME = 'ics_sequence');
SET @sql := IF(@todo,
  'ALTER TABLE `application_follow_up`
     ADD COLUMN `ics_sequence` SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER `overdue_reminded_on`,
     ADD COLUMN `ics_sent_sequence` SMALLINT UNSIGNED NULL DEFAULT NULL AFTER `ics_sequence`,
     ADD COLUMN `ics_sent_to` VARCHAR(255) NULL DEFAULT NULL AFTER `ics_sent_sequence`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- Follow-ups that already exist count as invited (SEQUENCE 0), so the
-- first run after this deploy doesn't email an invite for every open one;
-- a later change of date sends one.
SET @sql := IF(@todo,
  'UPDATE `application_follow_up` SET `ics_sent_sequence` = 0 WHERE `ics_sent_sequence` IS NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application_follow_up'
    AND INDEX_NAME = 'uq_follow_up_application_kind_seq');
SET @sql := IF(@todo,
  'ALTER TABLE `application_follow_up`
     ADD UNIQUE INDEX `uq_follow_up_application_kind_seq` (`application_id` ASC, `kind` ASC, `seq` ASC) VISIBLE',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) > 0 FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application_follow_up'
    AND INDEX_NAME = 'uq_follow_up_application_seq');
SET @sql := IF(@todo,
  'ALTER TABLE `application_follow_up` DROP INDEX `uq_follow_up_application_seq`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
