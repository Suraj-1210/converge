-- Widen course.min_entry_req from VARCHAR(50) to VARCHAR(2000) so a program's
-- full entry-requirement text fits (university pages run to ~600 characters;
-- 50 cut them off mid-sentence). Widening keeps every existing value, and
-- re-running the MODIFY is a no-op.
ALTER TABLE `course`
  MODIFY COLUMN `min_entry_req` VARCHAR(2000) NULL DEFAULT NULL;
