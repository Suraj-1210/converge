-- Partner bank details: domestic vs international accounts, a mandatory proof
-- document (cancelled cheque / bank letter) that finance checks by hand, and
-- who verified the account and how. Payouts are released only to a verified
-- account. Existing rows become "domestic" and keep their verification state.
ALTER TABLE `partner_bank_account`
  ADD COLUMN `region`                 TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER `org_id`,  -- 0 Domestic (IFSC), 1 International (SWIFT)
  ADD COLUMN `iban`                   VARCHAR(34)  NULL DEFAULT NULL AFTER `swift`,
  ADD COLUMN `bank_country`           CHAR(2)      NULL DEFAULT NULL AFTER `branch`,
  ADD COLUMN `bank_address`           VARCHAR(255) NULL DEFAULT NULL AFTER `bank_country`,
  ADD COLUMN `proof_url`              VARCHAR(500) NULL DEFAULT NULL AFTER `pan_enc`,       -- cancelled cheque (domestic) / bank letter (international)
  ADD COLUMN `proof_file_name`        VARCHAR(255) NULL DEFAULT NULL AFTER `proof_url`,
  ADD COLUMN `verified_by_cp_user_id` INT          NULL DEFAULT NULL AFTER `verified_at`,
  ADD COLUMN `verification_note`      VARCHAR(500) NULL DEFAULT NULL AFTER `verified_by_cp_user_id`;
