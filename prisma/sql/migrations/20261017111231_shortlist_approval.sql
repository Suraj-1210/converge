-- University assignment approval (Phase 3B, decided with Suraj 17 Oct 2026).
-- A shortlist row is a proposal by one side that the other side approves or
-- rejects; Apply (creating the application) is refused until it is approved.
--
--   added_by        0 = Collegepond counsellor, 1 = partner. Explicit, so a
--                   Collegepond row whose staff account was deleted
--                   (collegepond_user_id SET NULL) no longer looks partner-made.
--   added_by_user_id  the partner user who proposed it (partner rows only).
--   approval_status 0 = pending, 1 = approved, 2 = rejected
--                   (ShortlistApproval in src/server/db/enums.ts).
--   proposed_at     reset when a rejected row is re-proposed.
--   proposal_note   optional note sent with a re-proposal.
--   decided_*       who decided (partner user or Collegepond staff) and when.
--   reject_reason   required on reject; shown to the proposing side.
--
-- Expand-only. Backfill: rows a partner added (an audit_log
-- 'student.shortlisted' entry carrying byPartnerUserId for the same student
-- and course) become added_by = 1; every row that already exists is
-- grandfathered as approved, since it was created when no approval step
-- existed. The previous app version keeps working while this runs: new rows
-- it writes default to pending, and it never reads the new columns.
--
-- The ALTER is guarded by an information_schema check and the grandfathering
-- runs only in the same pass that adds the columns, so a re-run never approves
-- rows created after the first run.

SET @fresh := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shortlist'
    AND COLUMN_NAME = 'approval_status');

SET @sql := IF(@fresh,
  'ALTER TABLE `shortlist`
     ADD COLUMN `added_by`              TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER `collegepond_user_id`,
     ADD COLUMN `added_by_user_id`      INT NULL DEFAULT NULL AFTER `added_by`,
     ADD COLUMN `approval_status`       TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER `added_by_user_id`,
     ADD COLUMN `proposed_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `approval_status`,
     ADD COLUMN `proposal_note`         VARCHAR(500) NULL DEFAULT NULL AFTER `proposed_at`,
     ADD COLUMN `decided_at`            TIMESTAMP NULL DEFAULT NULL AFTER `proposal_note`,
     ADD COLUMN `decided_by_user_id`    INT NULL DEFAULT NULL AFTER `decided_at`,
     ADD COLUMN `decided_by_cp_user_id` INT NULL DEFAULT NULL AFTER `decided_by_user_id`,
     ADD COLUMN `reject_reason`         VARCHAR(500) NULL DEFAULT NULL AFTER `decided_by_cp_user_id`,
     ADD INDEX `idx_shortlist_approval` (`approval_status` ASC) VISIBLE,
     ADD INDEX `fk_shortlist_added_by_user_idx` (`added_by_user_id` ASC) VISIBLE,
     ADD INDEX `fk_shortlist_decided_by_user_idx` (`decided_by_user_id` ASC) VISIBLE,
     ADD INDEX `fk_shortlist_decided_by_cp_user_idx` (`decided_by_cp_user_id` ASC) VISIBLE,
     ADD CONSTRAINT `fk_shortlist_added_by_user`
       FOREIGN KEY (`added_by_user_id`) REFERENCES `user` (`id`) ON DELETE SET NULL,
     ADD CONSTRAINT `fk_shortlist_decided_by_user`
       FOREIGN KEY (`decided_by_user_id`) REFERENCES `user` (`id`) ON DELETE SET NULL,
     ADD CONSTRAINT `fk_shortlist_decided_by_cp_user`
       FOREIGN KEY (`decided_by_cp_user_id`) REFERENCES `cp_user` (`id`) ON DELETE SET NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Partner-added rows, attributed from the audit trail (latest entry wins).
UPDATE `shortlist` s
  JOIN (
    SELECT a.entity_id AS student_id,
           CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.courseId')) AS UNSIGNED) AS course_id,
           MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.byPartnerUserId')) AS UNSIGNED)) AS partner_user_id
      FROM `audit_log` a
     WHERE a.action = 'student.shortlisted'
       AND a.entity_type = 'student'
       AND JSON_EXTRACT(a.metadata, '$.byPartnerUserId') IS NOT NULL
     GROUP BY a.entity_id, course_id
  ) p ON p.student_id = s.student_id AND p.course_id = s.course_id
   SET s.added_by = 1,
       s.added_by_user_id = (SELECT u.id FROM `user` u WHERE u.id = p.partner_user_id)
 WHERE @fresh AND s.collegepond_user_id IS NULL;

-- Everything that existed before the approval step is treated as approved.
UPDATE `shortlist`
   SET approval_status = 1,
       proposed_at = created_at
 WHERE @fresh;

SELECT
  SUM(added_by = 0) AS collegepond_rows,
  SUM(added_by = 1) AS partner_rows,
  SUM(approval_status = 1) AS approved_rows,
  COUNT(*) AS total_rows
FROM `shortlist`;
