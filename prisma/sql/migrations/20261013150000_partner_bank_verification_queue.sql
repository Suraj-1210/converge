-- Partner bank-detail verification queue. Finance now checks bank details as
-- soon as a partner saves them (Admin → Bank Verifications), not only when a
-- payout is waiting, and can reject them with a reason the partner sees.
--
--   submitted_at   when the partner last saved the details. The queue is
--                  ordered by it (oldest first), and a verify/reject only
--                  applies if it is unchanged since finance loaded the row,
--                  so nobody approves details they haven't seen.
--   rejected_*     finance rejected the details. The account stays unverified
--                  (is_verified = 0) until the partner saves new ones, which
--                  clears these columns.
--
-- Status is derived: verified (is_verified = 1), rejected (rejected_at set),
-- otherwise pending. Payouts still require is_verified = 1.
ALTER TABLE `partner_bank_account`
  ADD COLUMN `submitted_at`           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `proof_file_name`,
  ADD COLUMN `rejected_at`            TIMESTAMP    NULL DEFAULT NULL AFTER `verification_note`,
  ADD COLUMN `rejected_by_cp_user_id` INT          NULL DEFAULT NULL AFTER `rejected_at`,
  ADD COLUMN `rejection_reason`       VARCHAR(500) NULL DEFAULT NULL AFTER `rejected_by_cp_user_id`,
  ADD INDEX `idx_partner_bank_account_queue` (`is_verified` ASC, `rejected_at` ASC, `submitted_at` ASC);

-- Existing rows: the last save is the best estimate of when they were
-- submitted. Setting updated_at to itself stops ON UPDATE from bumping it.
UPDATE `partner_bank_account`
SET `submitted_at` = `updated_at`,
    `updated_at`   = `updated_at`;
