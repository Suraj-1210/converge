-- Adjustments ledger (16 Nov 2026). Suraj: "We need the ability to have an
-- overriding deduction to the bill in the event a partner commits fraud and we
-- have the payment, or the student returns and the university deducts the
-- amount from our calculation ... there can be others."
--
--   adjustment_reason      Settings -> Adjustment Reasons master
--   adjustment             append-only deductions / credits, UNIVERSITY or
--                          PARTNER side; Finance drafts, a Super Admin decides
--   adjustment_evidence    staff-only uploads
--   adjustment_allocation  where an approved adjustment was applied (a vendor
--                          invoice, or a released partner payout)
--   payout_hold            a payee whose payouts are paused
--
-- New tables only; no existing table or row is touched. CREATE TABLE IF NOT
-- EXISTS and an empty-table guard on the seed make a re-run a no-op.

-- -----------------------------------------------------
-- adjustment_reason  (Settings -> Adjustment Reasons master. Deactivate,
-- don't delete, once an adjustment uses it.)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `adjustment_reason` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(150) NOT NULL,
  `sort_order` INT          NOT NULL DEFAULT 0,
  `is_active`  TINYINT      NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_adjustment_reason_name` (`name` ASC) VISIBLE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- adjustment  (append-only ledger of deductions / credits; 16 Nov 2026)
--   side       0 UNIVERSITY (what the university / vendor owes CP)
--              1 PARTNER    (what CP owes the payee)
--   direction  0 DEDUCTION (reduces it)  1 CREDIT (increases it)
--   status     0 DRAFT  1 APPROVED  2 REJECTED  (only a Super Admin decides)
-- The original commission / invoice / payment / payout rows are never edited:
-- an approved adjustment is applied through adjustment_allocation rows.
-- PARTNER side: exactly one payee (org_id XOR payee_user_id), amounts in INR.
-- note_* = the numbered Adjustment Note sent to the partner on approval.
-- *_by_cp_user_id are loose audit refs (no FK), like partner_payout's.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `adjustment` (
  `id`                    INT           NOT NULL AUTO_INCREMENT,
  `side`                  TINYINT UNSIGNED NOT NULL,
  `direction`             TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `status`                TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `reason_id`             INT           NOT NULL,
  `amount`                DECIMAL(14,2) NOT NULL,
  `currency`              CHAR(3)       NOT NULL,
  `adjustment_date`       DATE          NOT NULL,
  `vendor_id`             INT           NULL DEFAULT NULL,
  `university_id`         INT           NULL DEFAULT NULL,
  `org_id`                INT           NULL DEFAULT NULL,
  `payee_user_id`         INT           NULL DEFAULT NULL,
  `commission_id`         INT           NULL DEFAULT NULL,
  `commission_tranche_id` INT           NULL DEFAULT NULL,
  `vendor_invoice_id`     INT           NULL DEFAULT NULL,
  `source_adjustment_id`  INT           NULL DEFAULT NULL,
  `internal_note`         VARCHAR(1000) NULL DEFAULT NULL,
  `partner_note`          VARCHAR(500)  NULL DEFAULT NULL,
  `created_by_cp_user_id` INT           NOT NULL,
  `decided_by_cp_user_id` INT           NULL DEFAULT NULL,
  `decided_at`            TIMESTAMP     NULL DEFAULT NULL,
  `decision_note`         VARCHAR(500)  NULL DEFAULT NULL,
  `note_fy`               SMALLINT      NULL DEFAULT NULL,
  `note_seq`              INT           NULL DEFAULT NULL,
  `note_number`           VARCHAR(30)   NULL DEFAULT NULL,
  `created_at`            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_adjustment_note_number` (`note_number` ASC) VISIBLE,
  UNIQUE INDEX `uq_adjustment_note_seq` (`note_fy` ASC, `note_seq` ASC) VISIBLE,
  INDEX `idx_adjustment_side_status` (`side` ASC, `status` ASC) VISIBLE,
  INDEX `fk_adjustment_reason_idx` (`reason_id` ASC) VISIBLE,
  INDEX `fk_adjustment_vendor_idx` (`vendor_id` ASC) VISIBLE,
  INDEX `fk_adjustment_university_idx` (`university_id` ASC) VISIBLE,
  INDEX `fk_adjustment_org_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_adjustment_payee_user_idx` (`payee_user_id` ASC) VISIBLE,
  INDEX `fk_adjustment_commission_idx` (`commission_id` ASC) VISIBLE,
  INDEX `fk_adjustment_tranche_idx` (`commission_tranche_id` ASC) VISIBLE,
  INDEX `fk_adjustment_vendor_invoice_idx` (`vendor_invoice_id` ASC) VISIBLE,
  INDEX `fk_adjustment_source_idx` (`source_adjustment_id` ASC) VISIBLE,
  CONSTRAINT `fk_adjustment_reason`
    FOREIGN KEY (`reason_id`) REFERENCES `adjustment_reason` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_vendor`
    FOREIGN KEY (`vendor_id`) REFERENCES `vendor` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_university`
    FOREIGN KEY (`university_id`) REFERENCES `university` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_payee_user`
    FOREIGN KEY (`payee_user_id`) REFERENCES `user` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_commission`
    FOREIGN KEY (`commission_id`) REFERENCES `commission` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_tranche`
    FOREIGN KEY (`commission_tranche_id`) REFERENCES `commission_tranche` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_vendor_invoice`
    FOREIGN KEY (`vendor_invoice_id`) REFERENCES `vendor_invoice` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_source`
    FOREIGN KEY (`source_adjustment_id`) REFERENCES `adjustment` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_adjustment_amount` CHECK (`amount` > 0),
  CONSTRAINT `chk_adjustment_partner_payee` CHECK (
    `side` <> 1 OR ((`org_id` IS NULL) <> (`payee_user_id` IS NULL)))
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- adjustment_evidence  (staff-only uploads, folder adjustment-evidence/)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `adjustment_evidence` (
  `id`                     INT          NOT NULL AUTO_INCREMENT,
  `adjustment_id`          INT          NOT NULL,
  `file_url`               VARCHAR(500) NOT NULL,
  `file_name`              VARCHAR(255) NULL DEFAULT NULL,
  `uploaded_by_cp_user_id` INT          NOT NULL,
  `created_at`             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_adjustment_evidence_adjustment_idx` (`adjustment_id` ASC) VISIBLE,
  CONSTRAINT `fk_adjustment_evidence_adjustment`
    FOREIGN KEY (`adjustment_id`) REFERENCES `adjustment` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- adjustment_allocation  (how much of an approved adjustment has been applied,
-- and where: a vendor invoice (UNIVERSITY side) or a released partner payout
-- (PARTNER side). Exactly one target. Balance = amount - SUM(allocations).)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `adjustment_allocation` (
  `id`                    INT           NOT NULL AUTO_INCREMENT,
  `adjustment_id`         INT           NOT NULL,
  `vendor_invoice_id`     INT           NULL DEFAULT NULL,
  `partner_payout_id`     INT           NULL DEFAULT NULL,
  `amount`                DECIMAL(14,2) NOT NULL,
  `created_by_cp_user_id` INT           NULL DEFAULT NULL,
  `created_at`            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_adjustment_allocation_adjustment_idx` (`adjustment_id` ASC) VISIBLE,
  INDEX `fk_adjustment_allocation_vendor_invoice_idx` (`vendor_invoice_id` ASC) VISIBLE,
  INDEX `fk_adjustment_allocation_payout_idx` (`partner_payout_id` ASC) VISIBLE,
  CONSTRAINT `fk_adjustment_allocation_adjustment`
    FOREIGN KEY (`adjustment_id`) REFERENCES `adjustment` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_allocation_vendor_invoice`
    FOREIGN KEY (`vendor_invoice_id`) REFERENCES `vendor_invoice` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_allocation_payout`
    FOREIGN KEY (`partner_payout_id`) REFERENCES `partner_payout` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_adjustment_allocation_amount` CHECK (`amount` > 0),
  CONSTRAINT `chk_adjustment_allocation_target` CHECK (
    (`vendor_invoice_id` IS NULL) <> (`partner_payout_id` IS NULL))
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- payout_hold  (a payee on payout hold: claims still come in, nothing is
-- approved for payment or released. Active = lifted_at IS NULL. Placed and
-- lifted by a Finance Manager / Super Admin; rows are kept as the history.)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `payout_hold` (
  `id`                    INT          NOT NULL AUTO_INCREMENT,
  `org_id`                INT          NULL DEFAULT NULL,
  `payee_user_id`         INT          NULL DEFAULT NULL,
  `reason`                VARCHAR(500) NOT NULL,
  `placed_by_cp_user_id`  INT          NOT NULL,
  `placed_at`             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lifted_by_cp_user_id`  INT          NULL DEFAULT NULL,
  `lifted_at`             TIMESTAMP    NULL DEFAULT NULL,
  `lift_note`             VARCHAR(500) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_payout_hold_org_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_payout_hold_payee_user_idx` (`payee_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_payout_hold_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_payout_hold_payee_user`
    FOREIGN KEY (`payee_user_id`) REFERENCES `user` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_payout_hold_payee` CHECK (
    (`org_id` IS NULL) <> (`payee_user_id` IS NULL))
) ENGINE = InnoDB;

-- The standard reasons, only into an empty table (a re-run after a Super
-- Admin renamed one must not bring the old name back).
SET @todo := (SELECT COUNT(*) = 0 FROM `adjustment_reason`);
SET @sql := IF(@todo,
  'INSERT IGNORE INTO `adjustment_reason` (`name`, `sort_order`, `is_active`) VALUES
     (''Student withdrew / university clawback'', 10, 1),
     (''Partner fraud'',                          20, 1),
     (''Overpayment'',                            30, 1),
     (''Duplicate payment'',                      40, 1),
     (''Other'',                                  50, 1)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
