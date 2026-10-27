-- MOI (Medium of Instruction) per course (Suraj, 27 Oct: "MOI is course
-- specific"): whether the course accepts an MOI letter, i.e. English-medium
-- prior education, in place of an English test score.
--
--   course.moi_accepted   1 = accepted, 0 = not accepted, NULL = unknown
--
-- Same tri-state TINYINT(1) shape as is_stem. Additive only, no backfill:
-- every existing course starts as unknown.

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'course'
    AND COLUMN_NAME = 'moi_accepted');
SET @sql := IF(@todo,
  'ALTER TABLE `course`
     ADD COLUMN `moi_accepted` TINYINT(1) NULL DEFAULT NULL AFTER `faster_tat`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
