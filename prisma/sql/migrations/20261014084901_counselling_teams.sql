-- Counselling teams and lead auto-assignment (admin portal review, 14 Oct 2026).
--
-- counsellor_team: one row per Counsellor Lead. It holds the lead's designated
-- primary SPOC and the per-lead Auto Assign switch. A Super Admin configures
-- it under Settings -> Counselling Teams; the lead flips Auto Assign from
-- their dashboard.
-- counsellor_team_member: which counsellors report to which lead. A counsellor
-- is in at most one team (UNIQUE cp_user_id).
--
-- student.cp_auto_assigned_at: set when auto-assign picked the student's
-- cp_counsellor_id, so the UI can say "Auto-assigned". Cleared by any manual
-- assignment.
--
-- Additive only: new tables and one nullable column.

CREATE TABLE IF NOT EXISTS `counsellor_team` (
  `id`                      INT       NOT NULL AUTO_INCREMENT,
  `lead_cp_user_id`         INT       NOT NULL,
  `primary_spoc_cp_user_id` INT       NULL DEFAULT NULL,
  `auto_assign`             TINYINT   NOT NULL DEFAULT 0,
  `created_at`              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_counsellor_team_lead` (`lead_cp_user_id` ASC) VISIBLE,
  INDEX `fk_counsellor_team_spoc_idx` (`primary_spoc_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_counsellor_team_lead`
    FOREIGN KEY (`lead_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_counsellor_team_spoc`
    FOREIGN KEY (`primary_spoc_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `counsellor_team_member` (
  `id`         INT       NOT NULL AUTO_INCREMENT,
  `team_id`    INT       NOT NULL,
  `cp_user_id` INT       NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_counsellor_team_member` (`cp_user_id` ASC) VISIBLE,
  INDEX `fk_counsellor_team_member_team_idx` (`team_id` ASC) VISIBLE,
  CONSTRAINT `fk_counsellor_team_member_team`
    FOREIGN KEY (`team_id`) REFERENCES `counsellor_team` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_counsellor_team_member_user`
    FOREIGN KEY (`cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;

ALTER TABLE `student`
  ADD COLUMN `cp_auto_assigned_at` TIMESTAMP NULL DEFAULT NULL AFTER `cp_counsellor_id`;
