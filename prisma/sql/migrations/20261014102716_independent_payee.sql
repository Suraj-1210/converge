-- Commission for independent counsellors. An independent has no organization
-- (chk_user_partner_org), so the money rows that hung off an org get a payee
-- instead: the agency (org_id) or the independent counsellor (payee_user_id),
-- never both, enforced by a CHECK on each table.
--
--   application           org_id NULL-able: an independent's student is
--                         theirs via student.created_by_user_id, as scoping
--                         already does. No payee column here.
--   commission            org_id NULL-able + payee_user_id, stamped once at
--   invoice               billing confirmation / claim / bank-details save.
--   partner_bank_account  partner_payout and reconciliation follow the invoice.
--
-- Expand-only. Every existing row has org_id set and gets payee_user_id NULL,
-- so it satisfies the CHECK, and the previous app version keeps working while
-- this runs (it always writes org_id).
--
-- MySQL refuses a CHECK on a column used by a cascading foreign key, so the
-- org keys on commission / invoice / partner_bank_account move to RESTRICT
-- (as fk_user_org did in 20261013140000). Nothing in the app deletes or
-- re-keys organizations; scripts/reset-data.mjs deletes children first. The
-- keys get new names because MySQL can't drop and re-add one name in a single
-- statement.
--
-- Each table changes in ONE ALTER (atomic in MySQL 8), guarded by an
-- information_schema check, so a re-run after a partial failure skips the
-- tables already done instead of stopping on "duplicate column".

-- ---- application ---------------------------------------------------------
SET @todo := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'application'
    AND COLUMN_NAME = 'org_id' AND IS_NULLABLE = 'NO');
SET @sql := IF(@todo > 0,
  'ALTER TABLE `application` MODIFY `org_id` INT NULL DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- commission ----------------------------------------------------------
SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'commission'
    AND COLUMN_NAME = 'payee_user_id');
SET @sql := IF(@todo,
  'ALTER TABLE `commission`
     MODIFY `org_id` INT NULL DEFAULT NULL,
     ADD COLUMN `payee_user_id` INT NULL DEFAULT NULL AFTER `org_id`,
     ADD INDEX `fk_commission_payee_user_idx` (`payee_user_id` ASC),
     DROP FOREIGN KEY `fk_commission_organization`,
     ADD CONSTRAINT `fk_commission_org`
       FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
       ON DELETE RESTRICT ON UPDATE RESTRICT,
     ADD CONSTRAINT `fk_commission_payee_user`
       FOREIGN KEY (`payee_user_id`) REFERENCES `user` (`id`)
       ON DELETE RESTRICT ON UPDATE RESTRICT,
     ADD CONSTRAINT `chk_commission_payee`
       CHECK ((`org_id` IS NULL) <> (`payee_user_id` IS NULL))',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- invoice -------------------------------------------------------------
SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoice'
    AND COLUMN_NAME = 'payee_user_id');
SET @sql := IF(@todo,
  'ALTER TABLE `invoice`
     MODIFY `org_id` INT NULL DEFAULT NULL,
     ADD COLUMN `payee_user_id` INT NULL DEFAULT NULL AFTER `org_id`,
     ADD INDEX `fk_invoice_payee_user_idx` (`payee_user_id` ASC),
     DROP FOREIGN KEY `fk_invoice_organization`,
     ADD CONSTRAINT `fk_invoice_org`
       FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
       ON DELETE RESTRICT ON UPDATE RESTRICT,
     ADD CONSTRAINT `fk_invoice_payee_user`
       FOREIGN KEY (`payee_user_id`) REFERENCES `user` (`id`)
       ON DELETE RESTRICT ON UPDATE RESTRICT,
     ADD CONSTRAINT `chk_invoice_payee`
       CHECK ((`org_id` IS NULL) <> (`payee_user_id` IS NULL))',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---- partner_bank_account --------------------------------------------------
-- Was ON DELETE CASCADE: deleting an org no longer silently deletes its
-- payout account (nothing deletes orgs; see above).
SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'partner_bank_account'
    AND COLUMN_NAME = 'payee_user_id');
SET @sql := IF(@todo,
  'ALTER TABLE `partner_bank_account`
     MODIFY `org_id` INT NULL DEFAULT NULL,
     ADD COLUMN `payee_user_id` INT NULL DEFAULT NULL AFTER `org_id`,
     ADD INDEX `fk_partner_bank_account_payee_user_idx` (`payee_user_id` ASC),
     DROP FOREIGN KEY `fk_partner_bank_account_org`,
     ADD CONSTRAINT `fk_bank_account_org`
       FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
       ON DELETE RESTRICT ON UPDATE RESTRICT,
     ADD CONSTRAINT `fk_bank_account_payee_user`
       FOREIGN KEY (`payee_user_id`) REFERENCES `user` (`id`)
       ON DELETE RESTRICT ON UPDATE RESTRICT,
     ADD CONSTRAINT `chk_bank_account_payee`
       CHECK ((`org_id` IS NULL) <> (`payee_user_id` IS NULL))',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
