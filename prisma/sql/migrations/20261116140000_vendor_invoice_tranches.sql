-- Vendor invoices by instalment (16 Nov 2026, Finance: ASU's USD 3,000 is
-- paid in two instalments and must be invoiced one instalment at a time).
--
--   vendor_invoice_item_tranche (vendor_invoice_item_id, commission_tranche_id)
--       The instalments (commission_tranche rows) a vendor invoice line
--       bills. One line per student per invoice, as before: its expected
--       amount and variance cover the instalments linked here. UNIQUE on
--       commission_tranche_id = an instalment can be invoiced only once.
--       A line with NO rows here is a whole-commission line (every line made
--       before this, and commissions with no tranche rows): it bills every
--       tranche of the commission.
--
--   vendor_invoice_item: UNIQUE (commission_id) -> plain INDEX
--       A commission can now sit on several invoices, one per instalment.
--       "Only one whole-commission line per commission, and never a whole
--       line next to instalment lines" is enforced in createVendorInvoice
--       under a row lock on the commission.
--
-- Additive for the version still serving during a deploy: it never reads the
-- new table, and dropping the unique index changes nothing it relies on. The
-- plain index is added first because the FK on commission_id needs an index.

CREATE TABLE IF NOT EXISTS `vendor_invoice_item_tranche` (
  `id`                     INT NOT NULL AUTO_INCREMENT,
  `vendor_invoice_item_id` INT NOT NULL,
  `commission_tranche_id`  INT NOT NULL,
  `created_at`             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_vendor_invoice_item_tranche_tranche` (`commission_tranche_id` ASC) VISIBLE,
  INDEX `fk_vendor_invoice_item_tranche_item_idx` (`vendor_invoice_item_id` ASC) VISIBLE,
  CONSTRAINT `fk_vendor_invoice_item_tranche_item`
    FOREIGN KEY (`vendor_invoice_item_id`) REFERENCES `vendor_invoice_item` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_vendor_invoice_item_tranche_tranche`
    FOREIGN KEY (`commission_tranche_id`) REFERENCES `commission_tranche` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB;

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vendor_invoice_item'
    AND INDEX_NAME = 'fk_vendor_invoice_item_commission_idx');
SET @sql := IF(@todo,
  'ALTER TABLE `vendor_invoice_item`
     ADD INDEX `fk_vendor_invoice_item_commission_idx` (`commission_id` ASC)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @todo := (SELECT COUNT(*) > 0 FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vendor_invoice_item'
    AND INDEX_NAME = 'uq_vendor_invoice_item_commission');
SET @sql := IF(@todo,
  'ALTER TABLE `vendor_invoice_item`
     DROP INDEX `uq_vendor_invoice_item_commission`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
