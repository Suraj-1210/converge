-- Tab on/off switches per user type and per user (decided with Suraj, 27 Oct
-- 2026). A Super Admin picks which portal tabs each user type sees and saves
-- that as the type's default; a single user can then be overridden.
--
-- Effective access, per tab = the user's override ?? their type's saved
-- default ?? the built-in default in code (ADMIN_SECTION_ROLES in
-- src/lib/admin-sections.ts, PARTNER_TAB_TYPES in src/lib/partner-tabs.ts).
-- Resolved at read time (src/server/tab-access.ts), so a user added later
-- picks up their type's default with nothing copied.
--
-- cp_tab_default: one row per (portal, user type, tab) that a Super Admin
--   saved differently from the built-in default. portal 'admin' → user_type is
--   the AdminRole code; portal 'partner' → it is the partner user.type.
-- cp_tab_override: one row per (user, tab) that differs from their type's
--   default. Exactly one of cp_user_id (staff) / user_id (partner) is set.
--
-- Additive only: two new tables. A re-run is a no-op.

CREATE TABLE IF NOT EXISTS `cp_tab_default` (
  `id`                    INT                 NOT NULL AUTO_INCREMENT,
  `portal`                VARCHAR(10)         NOT NULL,
  `user_type`             TINYINT(3) UNSIGNED NOT NULL,
  `tab`                   VARCHAR(40)         NOT NULL,
  `enabled`               TINYINT(1)          NOT NULL,
  `updated_by_cp_user_id` INT                 NULL DEFAULT NULL,
  `created_at`            TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_cp_tab_default` (`portal` ASC, `user_type` ASC, `tab` ASC) VISIBLE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `cp_tab_override` (
  `id`                    INT         NOT NULL AUTO_INCREMENT,
  `cp_user_id`            INT         NULL DEFAULT NULL,
  `user_id`               INT         NULL DEFAULT NULL,
  `tab`                   VARCHAR(40) NOT NULL,
  `enabled`               TINYINT(1)  NOT NULL,
  `updated_by_cp_user_id` INT         NULL DEFAULT NULL,
  `created_at`            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_cp_tab_override_cp_user` (`cp_user_id` ASC, `tab` ASC) VISIBLE,
  UNIQUE INDEX `uq_cp_tab_override_user` (`user_id` ASC, `tab` ASC) VISIBLE,
  CONSTRAINT `fk_cp_tab_override_cp_user`
    FOREIGN KEY (`cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_cp_tab_override_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;
