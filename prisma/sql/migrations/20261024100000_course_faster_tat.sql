-- Faster TAT becomes a value instead of a yes/no flag (Portal Testing Day 5):
-- 1 = Same day, 2 = 1–3 days, 3 = Within 7 days, NULL = standard. Codes live
-- in src/lib/faster-tat.ts.
--
-- Additive. has_faster_tat stays and the app keeps it in step (1 whenever
-- faster_tat is set) until B2B confirms it can be dropped. Courses already
-- flagged map to "Within 7 days", the weakest claim the old flag supports.
ALTER TABLE `course`
  ADD COLUMN `faster_tat` TINYINT UNSIGNED NULL DEFAULT NULL AFTER `has_faster_tat`;

UPDATE `course` SET `faster_tat` = 3 WHERE `has_faster_tat` = 1 AND `faster_tat` IS NULL;
