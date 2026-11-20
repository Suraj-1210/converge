-- Loan commission (20 Nov 2026; spec "Loan Commission Flow — Converge",
-- decisions by Suraj). What Collegepond earns when a partner-referred
-- education loan is disbursed, what the partner is owed, and how it is paid.
-- Kept apart from university commission: its own lines, its own claims.
--
--   loan_lender              Finance's lender master (name as the Enrollment
--                            App sends it); pays_later_tranches = commission
--                            on tranches after the first (normally only the
--                            first tranche earns it).
--   loan_lender_rate         the lender's payout to CP, % of disbursed, dated.
--   loan_partner_rate        the partner's % of disbursed, dated. One per
--                            partner (agency org XOR independent user); no
--                            default (Suraj, 20 Nov).
--   loan_commission          one line per disbursement tranche: amount, date,
--                            stamped rates, status (LoanCommissionStatus).
--   loan_receipt             a lender payment to CP (excl. GST), recorded by
--   loan_receipt_allocation  any finance role, approved by SA / FM; split
--                            across the lines it pays.
--   loan_invoice_item        a loan line on a partner claim (invoice.kind = 1).
--   invoice.kind             0 university (default), 1 loan.
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS `loan_lender` (
  `id`                  INT          NOT NULL AUTO_INCREMENT,
  `name`                VARCHAR(150) NOT NULL,
  `pays_later_tranches` TINYINT      NOT NULL DEFAULT 0,
  `is_active`           TINYINT      NOT NULL DEFAULT 1,
  `created_at`          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_loan_lender_name` (`name` ASC) VISIBLE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_lender_rate` (
  `id`                    INT          NOT NULL AUTO_INCREMENT,
  `lender_id`             INT          NOT NULL,
  `cp_pct`                DECIMAL(6,3) NOT NULL,
  `effective_from`        DATE         NOT NULL,
  `note`                  VARCHAR(255) NULL DEFAULT NULL,
  `created_by_cp_user_id` INT          NULL DEFAULT NULL,
  `created_at`            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_loan_lender_rate_date` (`lender_id` ASC, `effective_from` ASC) VISIBLE,
  CONSTRAINT `fk_loan_lender_rate_lender`
    FOREIGN KEY (`lender_id`) REFERENCES `loan_lender` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_partner_rate` (
  `id`                    INT          NOT NULL AUTO_INCREMENT,
  `org_id`                INT          NULL DEFAULT NULL,
  `payee_user_id`         INT          NULL DEFAULT NULL,
  `pct`                   DECIMAL(6,3) NOT NULL,
  `effective_from`        DATE         NOT NULL,
  `note`                  VARCHAR(255) NULL DEFAULT NULL,
  `created_by_cp_user_id` INT          NULL DEFAULT NULL,
  `created_at`            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_loan_partner_rate_org` (`org_id` ASC, `effective_from` ASC) VISIBLE,
  INDEX `idx_loan_partner_rate_user` (`payee_user_id` ASC, `effective_from` ASC) VISIBLE,
  CONSTRAINT `chk_loan_partner_rate_payee`
    CHECK ((`org_id` IS NULL) <> (`payee_user_id` IS NULL)),
  CONSTRAINT `fk_loan_partner_rate_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_loan_partner_rate_user`
    FOREIGN KEY (`payee_user_id`) REFERENCES `user` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_receipt` (
  `id`                     INT           NOT NULL AUTO_INCREMENT,
  `lender_id`              INT           NOT NULL,
  `received_on`            DATE          NOT NULL,
  `reference`              VARCHAR(100)  NOT NULL,
  `cp_invoice_number`      VARCHAR(50)   NULL DEFAULT NULL,
  `amount`                 DECIMAL(14,2) NOT NULL,
  `gst_amount`             DECIMAL(14,2) NOT NULL DEFAULT 0,
  `tds_amount`             DECIMAL(14,2) NOT NULL DEFAULT 0,
  `status`                 TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `note`                   VARCHAR(500)  NULL DEFAULT NULL,
  `fy`                     SMALLINT      NULL DEFAULT NULL,
  `recorded_by_cp_user_id` INT           NOT NULL,
  `decided_by_cp_user_id`  INT           NULL DEFAULT NULL,
  `decided_at`             TIMESTAMP     NULL DEFAULT NULL,
  `decision_note`          VARCHAR(500)  NULL DEFAULT NULL,
  `created_at`             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_loan_receipt_lender` (`lender_id` ASC) VISIBLE,
  INDEX `idx_loan_receipt_status` (`status` ASC) VISIBLE,
  CONSTRAINT `fk_loan_receipt_lender`
    FOREIGN KEY (`lender_id`) REFERENCES `loan_lender` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_commission` (
  `id`                      INT              NOT NULL AUTO_INCREMENT,
  `referral_id`             INT              NOT NULL,
  -- The lender application it came from; NULL once that application is gone
  -- from the Enrollment App (the line stays, flagged) or for a manual credit.
  `referral_application_id` INT              NULL DEFAULT NULL,
  `app_external_id`         VARCHAR(64)      NULL DEFAULT NULL,
  `tranche_no`              TINYINT UNSIGNED NOT NULL DEFAULT 1,
  -- 0 synced from the Enrollment App, 1 tranche added by hand, 2 credit
  -- granted by a Super Admin on a duplicate referral.
  `source`                  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `lender_id`               INT              NOT NULL,
  `org_id`                  INT              NULL DEFAULT NULL,
  `payee_user_id`           INT              NULL DEFAULT NULL,
  `disbursed_amount`        DECIMAL(14,2)    NOT NULL,
  `disbursed_on`            DATE             NOT NULL,
  -- Stamped when priced (the masters on disbursed_on); NULL = not set yet.
  `lender_pct`              DECIMAL(6,3)     NULL DEFAULT NULL,
  `partner_pct`             DECIMAL(6,3)     NULL DEFAULT NULL,
  `expected_cp`             DECIMAL(14,2)    NULL DEFAULT NULL,
  `partner_amount`          DECIMAL(14,2)    NULL DEFAULT NULL,
  -- CP's lender receipt allocated to this line (excl. GST), once approved.
  `received_amount`         DECIMAL(14,2)    NULL DEFAULT NULL,
  -- LoanCommissionStatus: 0 needs rate, 1 awaiting lender payout,
  -- 2 receipt awaiting approval, 3 claimable, 4 claimed, 5 paid, 6 cancelled.
  `status`                  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  -- Something changed upstream that Finance must look at (never automatic).
  `attention`               VARCHAR(255)     NULL DEFAULT NULL,
  `attention_at`            TIMESTAMP        NULL DEFAULT NULL,
  `note`                    VARCHAR(500)     NULL DEFAULT NULL,
  `claimable_at`            TIMESTAMP        NULL DEFAULT NULL,
  `paid_at`                 TIMESTAMP        NULL DEFAULT NULL,
  `cancel_reason`           VARCHAR(500)     NULL DEFAULT NULL,
  `cancelled_by_cp_user_id` INT              NULL DEFAULT NULL,
  `cancelled_at`            TIMESTAMP        NULL DEFAULT NULL,
  `clawback_amount`         DECIMAL(14,2)    NULL DEFAULT NULL,
  `clawback_on`             DATE             NULL DEFAULT NULL,
  `clawback_reference`      VARCHAR(100)     NULL DEFAULT NULL,
  `clawback_adjustment_id`  INT              NULL DEFAULT NULL,
  `created_by_cp_user_id`   INT              NULL DEFAULT NULL,
  `created_at`              TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_loan_commission_tranche` (`referral_id` ASC, `app_external_id` ASC, `tranche_no` ASC) VISIBLE,
  INDEX `idx_loan_commission_status` (`status` ASC) VISIBLE,
  INDEX `idx_loan_commission_lender` (`lender_id` ASC, `status` ASC) VISIBLE,
  INDEX `idx_loan_commission_org` (`org_id` ASC) VISIBLE,
  INDEX `idx_loan_commission_user` (`payee_user_id` ASC) VISIBLE,
  INDEX `idx_loan_commission_app` (`referral_application_id` ASC) VISIBLE,
  INDEX `idx_loan_commission_adjustment` (`clawback_adjustment_id` ASC) VISIBLE,
  CONSTRAINT `chk_loan_commission_payee`
    CHECK ((`org_id` IS NULL) <> (`payee_user_id` IS NULL)),
  CONSTRAINT `fk_loan_commission_referral`
    FOREIGN KEY (`referral_id`) REFERENCES `loan_referral` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_loan_commission_application`
    FOREIGN KEY (`referral_application_id`) REFERENCES `loan_referral_application` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_loan_commission_lender`
    FOREIGN KEY (`lender_id`) REFERENCES `loan_lender` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_loan_commission_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_loan_commission_user`
    FOREIGN KEY (`payee_user_id`) REFERENCES `user` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_loan_commission_adjustment`
    FOREIGN KEY (`clawback_adjustment_id`) REFERENCES `adjustment` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_receipt_allocation` (
  `id`                 INT           NOT NULL AUTO_INCREMENT,
  `receipt_id`         INT           NOT NULL,
  `loan_commission_id` INT           NOT NULL,
  `amount`             DECIMAL(14,2) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_loan_receipt_allocation_line` (`loan_commission_id` ASC) VISIBLE,
  INDEX `idx_loan_receipt_allocation_receipt` (`receipt_id` ASC) VISIBLE,
  CONSTRAINT `fk_loan_receipt_allocation_receipt`
    FOREIGN KEY (`receipt_id`) REFERENCES `loan_receipt` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_loan_receipt_allocation_line`
    FOREIGN KEY (`loan_commission_id`) REFERENCES `loan_commission` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_invoice_item` (
  `id`                 INT           NOT NULL AUTO_INCREMENT,
  `invoice_id`         INT           NOT NULL,
  `loan_commission_id` INT           NOT NULL,
  `amount`             DECIMAL(12,2) NOT NULL,
  `created_at`         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_loan_invoice_item_line` (`loan_commission_id` ASC) VISIBLE,
  INDEX `idx_loan_invoice_item_invoice` (`invoice_id` ASC) VISIBLE,
  CONSTRAINT `fk_loan_invoice_item_invoice`
    FOREIGN KEY (`invoice_id`) REFERENCES `invoice` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_loan_invoice_item_line`
    FOREIGN KEY (`loan_commission_id`) REFERENCES `loan_commission` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB;

SET @add := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice' AND COLUMN_NAME = 'kind');
SET @sql := IF(@add,
  'ALTER TABLE `invoice` ADD COLUMN `kind` TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER `status`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The reason a loan clawback's pre-filled partner deduction carries.
INSERT IGNORE INTO `adjustment_reason` (`name`, `sort_order`, `is_active`)
  VALUES ('Loan commission clawback', 60, 1);
