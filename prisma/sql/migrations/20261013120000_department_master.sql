-- Department master. Internal staff (cp_user) departments were free text picked
-- from a list hardcoded in the Users page; they are now rows a Super Admin
-- manages under Settings -> Departments, and cp_user points at one by id.
--
-- Departments are organisational only — access is still decided by cp_user.role.
--
-- Data mapping (lossless):
--   1. Seed the six standard departments (the old hardcoded five + Counselling).
--   2. Any other non-blank value already on cp_user.department is added as an
--      INACTIVE department (sort_order 1000), so nothing is dropped and the
--      leftovers show up in Settings for a Super Admin to rename, merge or keep.
--   3. cp_user.department_id is set by name. Matching uses the column collation
--      (utf8mb4_0900_ai_ci), so "finance " / "FINANCE" map to Finance.
--
-- The old cp_user.department text column is deliberately KEPT (frozen, no
-- longer written). Both apps run db-apply on container start, before the new
-- version takes traffic; keeping the column means the version still serving —
-- and any rollback to it — keeps working. Drop it in a later migration once
-- this has been live without a rollback.

CREATE TABLE IF NOT EXISTS `department` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(100) NOT NULL,
  `is_active`  TINYINT      NOT NULL DEFAULT 1,
  `sort_order` INT          NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_department_name` (`name` ASC) VISIBLE
) ENGINE = InnoDB;

INSERT IGNORE INTO `department` (`name`, `is_active`, `sort_order`) VALUES
  ('Management',           1, 10),
  ('Counselling',          1, 20),
  ('Business Development', 1, 30),
  ('Operations',           1, 40),
  ('Finance',              1, 50),
  ('Content',              1, 60);

INSERT IGNORE INTO `department` (`name`, `is_active`, `sort_order`)
  SELECT DISTINCT TRIM(`department`), 0, 1000
  FROM `cp_user`
  WHERE `department` IS NOT NULL AND TRIM(`department`) <> '';

ALTER TABLE `cp_user`
  ADD COLUMN `department_id` INT NULL DEFAULT NULL AFTER `department`,
  ADD INDEX `fk_cp_user_department_idx` (`department_id` ASC) VISIBLE,
  ADD CONSTRAINT `fk_cp_user_department`
    FOREIGN KEY (`department_id`) REFERENCES `department` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE `cp_user` u
  JOIN `department` d ON d.`name` = TRIM(u.`department`)
  SET u.`department_id` = d.`id`,
      u.`updated_at`    = u.`updated_at` -- a backfill, not an edit
  WHERE u.`department` IS NOT NULL;
