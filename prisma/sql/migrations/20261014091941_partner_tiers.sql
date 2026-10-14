-- Partner Tiers master (loyalty programme). Tiers were defined in several
-- inconsistent places (MOU text, a manual user.tier, two hard-coded UI ladders,
-- the admin dashboard); they are now rows a Super Admin manages under
-- Settings -> Partner Tiers.
--
--   partner_tier           display data (name, order, badge colour, benefits) —
--                          edits apply immediately.
--   partner_tier_rule      the ladder per financial year: student range and
--                          commission share for each tier. The ladder for FY X is
--                          the rows of the latest fy <= X, so a Super Admin's
--                          range/share edits are written for the NEXT FY and
--                          never change the current year mid-way.
--   partner_tier_override  a Super Admin floor for one partner (agency owner or
--                          independent counsellor): the partner's tier is the
--                          higher of this and the computed tier. Optional end date.
--   commission.partner_tier_id
--                          the tier whose share was stamped onto the commission
--                          when Finance confirmed it (partner_share_pct already
--                          exists; it was never written, and readers treated NULL
--                          as 100%).
--
-- Data mapping (no partner's tier goes down):
--   1. Seed the five MOU tiers and the FY 2026-27 ladder from the current MOU
--      (Silver up to 10 = 70%, Gold 11-30 = 75%, Platinum 31-50 = 80%,
--      Titanium 51-75 = 85%, Diamond 76+ = 90%; 75 was in two tiers, now Titanium).
--   2. Every partner whose manual user.tier is above Silver gets a "migrated"
--      override at that tier, ending 31 Mar 2027. For an agency the highest tier
--      on any of its users goes on the owner.
--
-- user.tier is deliberately KEPT (frozen, no longer written) so the version
-- still serving during the deploy, and any rollback, keeps working.

CREATE TABLE IF NOT EXISTS `partner_tier` (
  `id`            INT          NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(50)  NOT NULL,
  `display_order` INT          NOT NULL DEFAULT 0,
  `badge_color`   CHAR(7)      NOT NULL DEFAULT '#344054',  -- #RRGGBB text colour; the badge tints it
  `icon`          VARCHAR(16)  NULL DEFAULT NULL,           -- optional emoji shown on partner screens
  `benefits`      JSON         NOT NULL,                    -- array of strings
  `is_active`     TINYINT      NOT NULL DEFAULT 1,
  `created_at`    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_partner_tier_name` (`name` ASC) VISIBLE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `partner_tier_rule` (
  `id`                 INT          NOT NULL AUTO_INCREMENT,
  `fy`                 SMALLINT     NOT NULL,                -- FY start year: 2026 = Apr 2026 - Mar 2027
  `tier_id`            INT          NOT NULL,
  `min_students`       SMALLINT UNSIGNED NOT NULL,
  `max_students`       SMALLINT UNSIGNED NULL DEFAULT NULL,  -- NULL = no upper limit (top tier)
  `share_pct`          DECIMAL(5,2) NOT NULL,                -- partner's share of the university commission
  `created_by_cp_user_id` INT       NULL DEFAULT NULL,
  `created_at`         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_partner_tier_rule_fy_tier` (`fy` ASC, `tier_id` ASC) VISIBLE,
  INDEX `fk_partner_tier_rule_tier_idx` (`tier_id` ASC) VISIBLE,
  INDEX `fk_partner_tier_rule_cp_user_idx` (`created_by_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_partner_tier_rule_tier`
    FOREIGN KEY (`tier_id`) REFERENCES `partner_tier` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_partner_tier_rule_cp_user`
    FOREIGN KEY (`created_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `partner_tier_override` (
  `id`                INT          NOT NULL AUTO_INCREMENT,
  `user_id`           INT          NOT NULL,                 -- agency owner or independent counsellor
  `tier_id`           INT          NOT NULL,
  `ends_on`           DATE         NULL DEFAULT NULL,        -- last day it applies; NULL = no end
  `reason`            VARCHAR(255) NULL DEFAULT NULL,
  `is_migrated`       TINYINT      NOT NULL DEFAULT 0,       -- 1 = carried over from the manual user.tier
  `set_by_cp_user_id` INT          NULL DEFAULT NULL,
  `set_at`            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_partner_tier_override_user` (`user_id` ASC) VISIBLE,
  INDEX `fk_partner_tier_override_tier_idx` (`tier_id` ASC) VISIBLE,
  INDEX `fk_partner_tier_override_cp_user_idx` (`set_by_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_partner_tier_override_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_partner_tier_override_tier`
    FOREIGN KEY (`tier_id`) REFERENCES `partner_tier` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_partner_tier_override_cp_user`
    FOREIGN KEY (`set_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;

ALTER TABLE `commission`
  ADD COLUMN `partner_tier_id` INT NULL DEFAULT NULL AFTER `partner_share_pct`,
  ADD INDEX `fk_commission_partner_tier_idx` (`partner_tier_id` ASC) VISIBLE,
  ADD CONSTRAINT `fk_commission_partner_tier`
    FOREIGN KEY (`partner_tier_id`) REFERENCES `partner_tier` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT IGNORE INTO `partner_tier` (`name`, `display_order`, `badge_color`, `icon`, `benefits`) VALUES
  ('Silver',   10, '#344054', CONVERT(0xf09fa588 USING utf8mb4), JSON_ARRAY('Standard Application Processing', 'Email Support')),
  ('Gold',     20, '#027A48', CONVERT(0xf09fa587 USING utf8mb4), JSON_ARRAY('Priority Application Processing', 'Dedicated Support', 'Quarterly Webinars')),
  ('Platinum', 30, '#B54708', CONVERT(0xf09f8f86 USING utf8mb4), JSON_ARRAY('Priority Processing', 'Priority access to your Relationship Manager', 'Training & Webinars', 'Early University Access')),
  ('Titanium', 40, '#6941C6', CONVERT(0xe29aa1 USING utf8mb4), JSON_ARRAY('Priority Processing', 'Priority access to your Relationship Manager', 'Exclusive Training', 'Early Access', 'Sponsored Events')),
  ('Diamond',  50, '#1570EF', CONVERT(0xf09f928e USING utf8mb4), JSON_ARRAY('Priority Application Processing', 'Priority access to your Relationship Manager', 'Exclusive Training & Webinars', 'Early Access to New Universities', 'Sponsored Events & Fam Trips'));

INSERT IGNORE INTO `partner_tier_rule` (`fy`, `tier_id`, `min_students`, `max_students`, `share_pct`)
  SELECT 2026, t.`id`, r.min_s, r.max_s, r.share
  FROM `partner_tier` t
  JOIN (
    SELECT 'Silver' AS name, 0 AS min_s, 10 AS max_s, 70.00 AS share
    UNION ALL SELECT 'Gold',     11, 30,   75.00
    UNION ALL SELECT 'Platinum', 31, 50,   80.00
    UNION ALL SELECT 'Titanium', 51, 75,   85.00
    UNION ALL SELECT 'Diamond',  76, NULL, 90.00
  ) r ON r.name = t.`name`;

-- Manual tiers above Silver become migrated overrides. Agency: the highest tier
-- on any of the org's users, placed on the owner. Independent: their own.
INSERT IGNORE INTO `partner_tier_override` (`user_id`, `tier_id`, `ends_on`, `reason`, `is_migrated`)
  SELECT m.user_id, t.`id`, '2027-03-31', 'Migrated from the manual tier', 1
  FROM (
    SELECT o.`id` AS user_id, LEAST(MAX(u.`tier`), 4) AS tier
    FROM `user` o
    JOIN `user` u ON u.`org_id` = o.`org_id` AND u.`deleted_at` IS NULL
    WHERE o.`type` = 0 AND o.`is_owner` = 1 AND o.`deleted_at` IS NULL
    GROUP BY o.`id`
    UNION ALL
    SELECT u.`id`, LEAST(u.`tier`, 4)
    FROM `user` u
    WHERE u.`type` = 2 AND u.`deleted_at` IS NULL
  ) m
  JOIN `partner_tier` t
    ON t.`name` = ELT(m.tier + 1, 'Silver', 'Gold', 'Platinum', 'Titanium', 'Diamond')
  WHERE m.tier > 0;
