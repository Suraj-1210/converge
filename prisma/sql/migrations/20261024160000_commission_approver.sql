-- Commission approval (money-flow fixes, 24 Oct 2026). Additive only — the
-- version still serving during a deploy ignores the new columns.
--
--   commission.approved_by_cp_user_id / approved_at
--       Who approved the commission in University Billing › Confirmed
--       Students ("Approve commission", Super Admin / Finance Manager) and
--       when. A loose reference to cp_user, like
--       partner_payout.ops_approved_by_cp_user_id (no FK).
--
-- Backfill: every approval so far wrote an audit_log row
-- 'commission.share_stamped' with metadata.via = 'confirm_billing' and the
-- approver in metadata.byCpUserId. Rows confirmed before that audit existed
-- stay NULL (shown as "not recorded").

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commission'
    AND COLUMN_NAME = 'approved_by_cp_user_id');
SET @sql := IF(@todo,
  'ALTER TABLE `commission`
     ADD COLUMN `approved_by_cp_user_id` INT       NULL DEFAULT NULL,
     ADD COLUMN `approved_at`            TIMESTAMP NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `commission` c
JOIN (
  SELECT a.entity_id AS commission_id,
         CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.byCpUserId')) AS UNSIGNED) AS cp_user_id,
         a.created_at
  FROM `audit_log` a
  JOIN (
    SELECT entity_id, MIN(id) AS id
    FROM `audit_log`
    WHERE action = 'commission.share_stamped'
      AND entity_type = 'commission'
      AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.via')) = 'confirm_billing'
    GROUP BY entity_id
  ) first_stamp ON first_stamp.id = a.id
) s ON s.commission_id = c.id
SET c.approved_by_cp_user_id = s.cp_user_id,
    c.approved_at = s.created_at
WHERE c.approved_by_cp_user_id IS NULL;
