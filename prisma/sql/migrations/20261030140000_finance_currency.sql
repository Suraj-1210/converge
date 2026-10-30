-- Finance currency + collection approval (30 Oct 2026, testers' 29 Oct
-- finance spec). Additive only — the version still serving during a deploy
-- ignores every new column.
--
--   vendor.currency, commission_contract.currency
--       The agreement's currency. Flat amounts (flat rates, fixed tranche
--       amounts, bonus tiers) are in it. NULL on rows made before this =
--       "the course's currency", which is how flat amounts were applied.
--
--   commission.tuition_currency
--       The course currency the tuition was stamped in. A FLAT deal whose
--       contract currency differs is stamped in the contract currency
--       (commission.currency), so the tuition needs its own. NULL = same as
--       commission.currency (every row before this).
--
--   commission_tranche.vendor_payment_id
--       The recorded collection that covers the tranche. A loose reference
--       (no FK), like the *_by_cp_user_id columns.
--
--   vendor_payment.amount_expected / approved_by_cp_user_id / approved_at
--       What the covered tranches were invoiced at (invoice currency), and
--       who approved the collection (Commission Ledger > Collections) and
--       when. Until approved, the covered tranches are "Collected, awaiting
--       approval" (commission_tranche.status 5) and not claimable.
--
--   partner_bank_account.payout_currency, invoice.payout_currency
--       The currency a partner is paid in: INR for a domestic account; an
--       international account picks it. The invoice keeps a snapshot.
--       Invoice amounts stay in INR.
--
--   partner_payout.currency / amount_foreign / exchange_rate
--       Set at release for a foreign-currency payout: what was remitted and
--       at what rate. amount_inr stays the INR equivalent.
--
-- Backfill: payments recorded before this were claimable straight away, so
-- they count as approved by whoever recorded them, when they recorded them.

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vendor'
    AND COLUMN_NAME = 'currency');
SET @sql := IF(@todo,
  'ALTER TABLE `vendor`
     ADD COLUMN `currency` CHAR(3) NULL DEFAULT NULL AFTER `address`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commission_contract'
    AND COLUMN_NAME = 'currency');
SET @sql := IF(@todo,
  'ALTER TABLE `commission_contract`
     ADD COLUMN `currency` CHAR(3) NULL DEFAULT NULL AFTER `cp_share_pct`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commission'
    AND COLUMN_NAME = 'tuition_currency');
SET @sql := IF(@todo,
  'ALTER TABLE `commission`
     ADD COLUMN `tuition_currency` CHAR(3) NULL DEFAULT NULL AFTER `currency`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commission_tranche'
    AND COLUMN_NAME = 'vendor_payment_id');
SET @sql := IF(@todo,
  'ALTER TABLE `commission_tranche`
     ADD COLUMN `vendor_payment_id` INT NULL DEFAULT NULL AFTER `amount_inr`,
     ADD INDEX `idx_commission_tranche_vendor_payment` (`vendor_payment_id` ASC)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vendor_payment'
    AND COLUMN_NAME = 'approved_at');
SET @sql := IF(@todo,
  'ALTER TABLE `vendor_payment`
     ADD COLUMN `amount_expected`        DECIMAL(14,2) NULL DEFAULT NULL AFTER `amount_foreign`,
     ADD COLUMN `approved_by_cp_user_id` INT           NULL DEFAULT NULL AFTER `created_by_cp_user_id`,
     ADD COLUMN `approved_at`            TIMESTAMP     NULL DEFAULT NULL AFTER `approved_by_cp_user_id`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Only rows no tranche points at yet: every payment recorded before this.
UPDATE `vendor_payment` p
SET p.approved_at = p.created_at,
    p.approved_by_cp_user_id = p.created_by_cp_user_id
WHERE p.approved_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `commission_tranche` t WHERE t.vendor_payment_id = p.id
  );

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'partner_bank_account'
    AND COLUMN_NAME = 'payout_currency');
SET @sql := IF(@todo,
  'ALTER TABLE `partner_bank_account`
     ADD COLUMN `payout_currency` CHAR(3) NULL DEFAULT NULL AFTER `region`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice'
    AND COLUMN_NAME = 'payout_currency');
SET @sql := IF(@todo,
  'ALTER TABLE `invoice`
     ADD COLUMN `payout_currency` CHAR(3) NULL DEFAULT NULL AFTER `currency`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'partner_payout'
    AND COLUMN_NAME = 'currency');
SET @sql := IF(@todo,
  'ALTER TABLE `partner_payout`
     ADD COLUMN `currency`       CHAR(3)       NULL DEFAULT NULL AFTER `amount_inr`,
     ADD COLUMN `amount_foreign` DECIMAL(14,2) NULL DEFAULT NULL AFTER `currency`,
     ADD COLUMN `exchange_rate`  DECIMAL(12,4) NULL DEFAULT NULL AFTER `amount_foreign`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
