-- Tranche conditions master (16 Nov 2026, Suraj: "Can we have it flow from
-- the Masters - the conditions so that we can always update it so it is not
-- hardwired"). The tranche "Condition" on Commission Rates becomes a dropdown
-- fed by Settings -> Tranche Conditions instead of free text.
--
--   tranche_condition                      the master (name, order, active)
--   commission_tranche_template.condition_id  the chosen condition (NULL = none)
--
-- commission_tranche_template.timing STAYS, as a snapshot of the condition's
-- name: saving a tranche writes the name there, and renaming a condition
-- rewrites it on every tranche that uses it, so everything that reads
-- `timing` keeps working unchanged.
--
-- Seeded with the standard conditions, plus every distinct condition already
-- typed on a tranche (trimmed, runs of spaces collapsed; the unique name is
-- case-insensitive, so "on enrollment" folds into "On Enrollment"). Existing
-- tranches are then linked by matching that text, and their timing is rewritten
-- to the master's spelling.
--
-- Additive and idempotent (information_schema guards); a re-run is a no-op.

CREATE TABLE IF NOT EXISTS `tranche_condition` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(150) NOT NULL,
  `sort_order` INT          NOT NULL DEFAULT 0,
  `is_active`  TINYINT      NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_tranche_condition_name` (`name` ASC) VISIBLE
) ENGINE = InnoDB;

-- The standard list, only into an empty table (a re-run after a Super Admin
-- renamed one must not bring the old name back).
SET @todo := (SELECT COUNT(*) = 0 FROM `tranche_condition`);
SET @sql := IF(@todo,
  'INSERT IGNORE INTO `tranche_condition` (`name`, `sort_order`, `is_active`) VALUES
     (''On Enrollment'',       10, 1),
     (''After Census Date'',   20, 1),
     (''After Semester 1'',    30, 1),
     (''After Semester 2'',    40, 1),
     (''On Completion'',       50, 1)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commission_tranche_template' AND COLUMN_NAME = 'condition_id');
SET @sql := IF(@todo,
  'ALTER TABLE `commission_tranche_template`
     ADD COLUMN `condition_id` INT NULL DEFAULT NULL AFTER `pct`,
     ADD INDEX `fk_tranche_template_condition_idx` (`condition_id` ASC) VISIBLE',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commission_tranche_template'
    AND CONSTRAINT_NAME = 'fk_tranche_template_condition');
SET @sql := IF(@todo,
  'ALTER TABLE `commission_tranche_template`
     ADD CONSTRAINT `fk_tranche_template_condition`
       FOREIGN KEY (`condition_id`) REFERENCES `tranche_condition` (`id`)
       ON DELETE RESTRICT ON UPDATE CASCADE',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Conditions already typed on tranches that aren't linked yet (after a
-- successful run every tranche with a timing is linked, so this adds nothing).
-- After the standard list, in first-seen order.
INSERT IGNORE INTO `tranche_condition` (`name`, `sort_order`, `is_active`)
  SELECT t.`norm`, 1000, 1
  FROM (
    SELECT REGEXP_REPLACE(TRIM(`timing`), '[[:space:]]+', ' ') AS `norm`, MIN(`id`) AS `first_id`
    FROM `commission_tranche_template`
    WHERE `condition_id` IS NULL AND `timing` IS NOT NULL AND TRIM(`timing`) <> ''
    GROUP BY `norm`
  ) t
  ORDER BY t.`first_id`;

-- Link each tranche to its condition, and store the master's spelling.
UPDATE `commission_tranche_template` ctt
  JOIN `tranche_condition` tc
    ON tc.`name` = REGEXP_REPLACE(TRIM(ctt.`timing`), '[[:space:]]+', ' ')
  SET ctt.`condition_id` = tc.`id`,
      ctt.`timing`       = tc.`name`
  WHERE ctt.`condition_id` IS NULL AND ctt.`timing` IS NOT NULL;
