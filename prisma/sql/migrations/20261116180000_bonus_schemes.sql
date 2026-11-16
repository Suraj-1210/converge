-- Bonus schemes (16 Nov 2026, Suraj item 7 "Partner Bonus – Additional
-- Commission Entry"). Two kinds of bonus, kept apart:
--
--   kind 1 = UNIVERSITY VOLUME BONUS (income). The university or vendor pays
--            Collegepond extra per student once a contract's intake reaches a
--            slab (e.g. UCD 5–10 students · €500 each). Works on direct AND
--            third-party vendor contracts. 100% Collegepond income: no
--            partner share, and the full amount is billed (no CP share %).
--            Billed on its own vendor invoice, then Record Payment →
--            Collections like any other receivable.
--   kind 2 = PARTNER INCENTIVE (CP-funded). Collegepond pays the partner extra
--            per student. Never on a university invoice. 100% to the partner,
--            claimable once the student's first base instalment is collected
--            and approved.
--
--   bonus_scheme       one row per scheme, never overwritten: a scheme that
--                      has been applied can't be edited (only closed /
--                      deactivated); Finance duplicates it to change terms.
--   bonus_scheme_slab  volume slabs: min–max students, flat amount per student
--                      in the scheme currency (no % bonuses).
--   commission_bonus   the snapshot stamped on a commission: scheme, slab, the
--                      count that reached it, the calculated amount and the
--                      amount used (with Finance's reason when edited). One
--                      per commission per kind. Its money moves through the
--                      commission_tranche it points to.
--   commission_tranche.kind  0 = base instalment, 1 = volume bonus,
--                      2 = partner incentive. Vendor-side code bills kinds 0
--                      and 1; partner-side code pays kinds 0 and 2.
--   commission.bonus_intake  "YYYY-MM", the intake the student was counted
--                      in at approval (volume bonus counts restart per intake).
--   commission.calculated_commission_amount / commission_amount_reason
--                      the base the rate gave when Finance edited it at
--                      approval, and why. NULL = not edited.
--
-- commission_bonus_tier (Commission Rates › Volume Bonus Tiers, direct
-- contracts only) was never read by any calculation. Its rows are copied into
-- one INACTIVE university scheme per contract so Finance can set the dates /
-- retroactive rule and switch it on. The old table is left as it was.
--
-- Additive: the version still serving during a deploy never reads the new
-- tables or columns, and every existing tranche gets kind 0.

CREATE TABLE IF NOT EXISTS `bonus_scheme` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `kind`                  TINYINT UNSIGNED NOT NULL,
  `name`                  VARCHAR(150) NOT NULL,
  `currency`              CHAR(3) NOT NULL,
  -- Volume bonus: the commission approval date. Partner incentive: the date
  -- the student's application was submitted. NULL = open-ended.
  `active_from`           DATE NULL DEFAULT NULL,
  `active_to`             DATE NULL DEFAULT NULL,
  -- Volume bonus: the university contract (direct or vendor) it belongs to.
  `contract_id`           INT NULL DEFAULT NULL,
  -- Scope; NULL = any.
  `country`               VARCHAR(100) NULL DEFAULT NULL,
  `university_id`         INT NULL DEFAULT NULL,
  `intake_month`          TINYINT UNSIGNED NULL DEFAULT NULL,
  `intake_year`           SMALLINT UNSIGNED NULL DEFAULT NULL,
  -- Volume bonus only: 1 = once the threshold is reached every student
  -- counted in that intake earns it; 0 = only students from the threshold on.
  `retroactive`           TINYINT NOT NULL DEFAULT 0,
  `is_active`             TINYINT NOT NULL DEFAULT 1,
  `notes`                 VARCHAR(500) NULL DEFAULT NULL,
  -- Copied from commission_bonus_tier by this migration.
  `imported_from_tiers`   TINYINT NOT NULL DEFAULT 0,
  `created_by_cp_user_id` INT NULL DEFAULT NULL,
  `created_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_bonus_scheme_kind` (`kind` ASC, `is_active` ASC) VISIBLE,
  INDEX `fk_bonus_scheme_contract_idx` (`contract_id` ASC) VISIBLE,
  INDEX `fk_bonus_scheme_university_idx` (`university_id` ASC) VISIBLE,
  CONSTRAINT `fk_bonus_scheme_contract`
    FOREIGN KEY (`contract_id`) REFERENCES `commission_contract` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_bonus_scheme_university`
    FOREIGN KEY (`university_id`) REFERENCES `university` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `bonus_scheme_slab` (
  `id`                 INT NOT NULL AUTO_INCREMENT,
  `scheme_id`          INT NOT NULL,
  `min_students`       SMALLINT UNSIGNED NOT NULL,
  `max_students`       SMALLINT UNSIGNED NULL DEFAULT NULL,
  `amount_per_student` DECIMAL(12,2) NOT NULL,
  `created_at`         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_bonus_scheme_slab_scheme_idx` (`scheme_id` ASC) VISIBLE,
  CONSTRAINT `fk_bonus_scheme_slab_scheme`
    FOREIGN KEY (`scheme_id`) REFERENCES `bonus_scheme` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `commission_bonus` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `commission_id`         INT NOT NULL,
  `kind`                  TINYINT UNSIGNED NOT NULL,
  `scheme_id`             INT NULL DEFAULT NULL,
  -- Snapshots, so the record reads the same if the scheme is later closed.
  `scheme_name`           VARCHAR(150) NULL DEFAULT NULL,
  `slab_min`              SMALLINT UNSIGNED NULL DEFAULT NULL,
  `slab_max`              SMALLINT UNSIGNED NULL DEFAULT NULL,
  -- The count (including this student) that reached the slab.
  `student_count`         SMALLINT UNSIGNED NULL DEFAULT NULL,
  `intake`                CHAR(7) NULL DEFAULT NULL,
  -- What the scheme gave; NULL when Finance added one no scheme matched.
  `calculated_amount`     DECIMAL(12,2) NULL DEFAULT NULL,
  `amount`                DECIMAL(12,2) NOT NULL,
  `currency`              CHAR(3) NOT NULL,
  `commission_tranche_id` INT NULL DEFAULT NULL,
  `is_manual`             TINYINT NOT NULL DEFAULT 0,
  `edit_reason`           VARCHAR(500) NULL DEFAULT NULL,
  -- 'approval' (stamped at Approve commission) or 'retroactive' (a volume
  -- bonus added when a later student reached the threshold).
  `via`                   VARCHAR(20) NOT NULL DEFAULT 'approval',
  `created_by_cp_user_id` INT NULL DEFAULT NULL,
  `created_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_commission_bonus_kind` (`commission_id` ASC, `kind` ASC) VISIBLE,
  UNIQUE INDEX `uq_commission_bonus_tranche` (`commission_tranche_id` ASC) VISIBLE,
  INDEX `fk_commission_bonus_scheme_idx` (`scheme_id` ASC) VISIBLE,
  CONSTRAINT `fk_commission_bonus_commission`
    FOREIGN KEY (`commission_id`) REFERENCES `commission` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_commission_bonus_scheme`
    FOREIGN KEY (`scheme_id`) REFERENCES `bonus_scheme` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_commission_bonus_tranche`
    FOREIGN KEY (`commission_tranche_id`) REFERENCES `commission_tranche` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commission_tranche' AND COLUMN_NAME = 'kind');
SET @sql := IF(@todo,
  'ALTER TABLE `commission_tranche`
     ADD COLUMN `kind` TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER `seq`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commission' AND COLUMN_NAME = 'bonus_intake');
SET @sql := IF(@todo,
  'ALTER TABLE `commission`
     ADD COLUMN `bonus_intake` CHAR(7) NULL DEFAULT NULL AFTER `approved_at`,
     ADD COLUMN `calculated_commission_amount` DECIMAL(12,2) NULL DEFAULT NULL AFTER `bonus_intake`,
     ADD COLUMN `commission_amount_reason` VARCHAR(500) NULL DEFAULT NULL AFTER `calculated_commission_amount`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- One inactive volume-bonus scheme per contract that has bonus tiers.
INSERT INTO `bonus_scheme`
  (`kind`, `name`, `currency`, `contract_id`, `university_id`, `retroactive`, `is_active`, `imported_from_tiers`, `notes`)
SELECT 1,
       LEFT(CONCAT(u.`name`, IF(v.`name` IS NULL, '', CONCAT(' via ', v.`name`)), ' volume bonus'), 150),
       COALESCE((SELECT t2.`currency` FROM `commission_bonus_tier` t2
                  WHERE t2.`contract_id` = c.`id` AND t2.`currency` IS NOT NULL LIMIT 1),
                c.`currency`, v.`currency`, 'INR'),
       c.`id`, c.`university_id`, 0, 0, 1,
       'Imported from Commission Rates › Volume Bonus Tiers. Check the currency, dates and retroactive rule, then activate.'
  FROM `commission_contract` c
  JOIN `university` u ON u.`id` = c.`university_id`
  LEFT JOIN `vendor` v ON v.`id` = c.`vendor_id`
 WHERE EXISTS (SELECT 1 FROM `commission_bonus_tier` t WHERE t.`contract_id` = c.`id`)
   AND NOT EXISTS (SELECT 1 FROM `bonus_scheme` s
                    WHERE s.`imported_from_tiers` = 1 AND s.`contract_id` = c.`id`);

INSERT INTO `bonus_scheme_slab` (`scheme_id`, `min_students`, `max_students`, `amount_per_student`)
SELECT s.`id`, t.`min_students`, t.`max_students`, t.`amount_per_student`
  FROM `bonus_scheme` s
  JOIN `commission_bonus_tier` t ON t.`contract_id` = s.`contract_id`
 WHERE s.`imported_from_tiers` = 1
   AND NOT EXISTS (SELECT 1 FROM `bonus_scheme_slab` x WHERE x.`scheme_id` = s.`id`)
 ORDER BY s.`id`, t.`min_students`;
