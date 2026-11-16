-- Partner Notices master (16 Nov 2026, Suraj: "On the partner side, we need
-- to identify what events trigger important notices ... I think it should be
-- in the Admin Masters"). Settings -> Partner Notices, Super Admin only.
--
--   partner_notice_trigger         per-trigger settings for the notices the
--                                  code generates (src/server/partner-notices.ts).
--                                  Keyed by the trigger's code. NO ROW = the
--                                  code's defaults (today's wording), so this
--                                  table starts empty and nothing changes for
--                                  partners until a Super Admin edits a trigger.
--   partner_manual_notice          free-text announcements with start/end dates
--   partner_manual_notice_target   optional: limit an announcement to specific
--                                  partners (an agency org XOR an independent)
--
-- Additive and idempotent (CREATE TABLE IF NOT EXISTS); a re-run is a no-op.

CREATE TABLE IF NOT EXISTS `partner_notice_trigger` (
  `code`           VARCHAR(50)       NOT NULL,
  `is_enabled`     TINYINT           NOT NULL DEFAULT 1,
  `title_template` VARCHAR(200)      NOT NULL,
  `body_template`  VARCHAR(1000)     NULL DEFAULT NULL,
  `severity`       TINYINT UNSIGNED  NOT NULL,              -- 1 info, 2 success, 3 warning, 4 action needed
  `sort_order`     INT               NOT NULL DEFAULT 0,
  `window_days`    SMALLINT UNSIGNED NULL DEFAULT NULL,     -- "in the last N days"; NULL where it doesn't apply
  `audience`       TINYINT UNSIGNED  NOT NULL,              -- 1 owner/independent, 2 agency counsellors, 3 both
  `created_at`     TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`code`)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `partner_manual_notice` (
  `id`         INT              NOT NULL AUTO_INCREMENT,
  `title`      VARCHAR(200)     NOT NULL,
  `body`       VARCHAR(2000)    NULL DEFAULT NULL,
  `link_url`   VARCHAR(500)     NULL DEFAULT NULL,       -- a portal path (/partner/...) or https:// URL
  `severity`   TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `audience`   TINYINT UNSIGNED NOT NULL DEFAULT 3,
  `starts_on`  DATE             NOT NULL,                -- IST calendar day, inclusive
  `ends_on`    DATE             NULL DEFAULT NULL,       -- IST calendar day, inclusive; NULL = no end
  `is_active`  TINYINT          NOT NULL DEFAULT 1,
  `sort_order` INT              NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_partner_manual_notice_live` (`is_active` ASC, `starts_on` ASC) VISIBLE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `partner_manual_notice_target` (
  `id`        INT NOT NULL AUTO_INCREMENT,
  `notice_id` INT NOT NULL,
  `org_id`    INT NULL DEFAULT NULL,     -- an agency (owner and its counsellors)
  `user_id`   INT NULL DEFAULT NULL,     -- an independent counsellor
  PRIMARY KEY (`id`),
  INDEX `fk_partner_manual_notice_target_notice_idx` (`notice_id` ASC) VISIBLE,
  INDEX `fk_partner_manual_notice_target_org_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_partner_manual_notice_target_user_idx` (`user_id` ASC) VISIBLE,
  CONSTRAINT `fk_partner_manual_notice_target_notice`
    FOREIGN KEY (`notice_id`) REFERENCES `partner_manual_notice` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_partner_manual_notice_target_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_partner_manual_notice_target_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
  -- Exactly one of org_id / user_id is set. Enforced by the router: MySQL
  -- refuses a CHECK on columns that CASCADE foreign keys use.
) ENGINE = InnoDB;
