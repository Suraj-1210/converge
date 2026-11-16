-- Event creatives, partner sharing and the partner dashboard banner
-- (16 Nov 2026, Suraj's decisions; rules in src/server/event-sharing.ts).
--
-- New columns on event:
--   creative_url      the poster (JPG/PNG/PDF, public upload folder event-creatives)
--   registration_url  optional external registration form ("Register students")
--   audience          1 = all approved partners, 2 = selected partners (the
--                     invite list in event_registration). Existing rows: 1,
--                     which is who could see them before (every published event
--                     was listed to every partner).
--   share_partners    1 = email + bell the audience when the event is published
--                     (and anyone added later). Existing rows get 0, so editing an
--                     old event never emails every partner; tick it to share.
--   ics_sequence      calendar invite SEQUENCE, bumped when the date, time,
--                     place or link changes (the "updated" email).
--
-- event_share: one row per (event, partner user) that was sent the
-- announcement. The unique key is what makes "never twice" hold, even for two
-- saves at once: a save inserts with INSERT IGNORE and notifies only the rows
-- carrying its own share_batch token.
--
-- partner_banner: the rotating slides on the partner dashboard. EVENT slides
-- follow their event (published, not yet past, the event's audience); INFO
-- slides go to every partner and open a pop-up. The rotation interval lives
-- in system_config ('partner_banner.rotate_seconds').
--
-- Additive and idempotent (information_schema guards); a re-run is a no-op.

SET @todo := (SELECT COUNT(*) = 0 FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'event' AND COLUMN_NAME = 'creative_url');
SET @sql := IF(@todo,
  'ALTER TABLE `event`
     ADD COLUMN `creative_url` VARCHAR(500) NULL DEFAULT NULL AFTER `agenda`,
     ADD COLUMN `registration_url` VARCHAR(500) NULL DEFAULT NULL AFTER `creative_url`,
     ADD COLUMN `audience` TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER `registration_url`,
     ADD COLUMN `share_partners` TINYINT NOT NULL DEFAULT 1 AFTER `audience`,
     ADD COLUMN `ics_sequence` SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER `share_partners`',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- Events that exist before this migration aren't shared automatically.
SET @sql := IF(@todo, 'UPDATE `event` SET `share_partners` = 0', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `event_share` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `event_id`        INT NOT NULL,
  `user_id`         INT NOT NULL,
  `share_batch`     CHAR(16) NOT NULL,
  `notified_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `email_sent_at`   TIMESTAMP NULL DEFAULT NULL,
  `updated_sent_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_event_share_event_user` (`event_id` ASC, `user_id` ASC) VISIBLE,
  INDEX `idx_event_share_batch` (`share_batch` ASC) VISIBLE,
  INDEX `fk_event_share_user_idx` (`user_id` ASC) VISIBLE,
  CONSTRAINT `fk_event_share_event`
    FOREIGN KEY (`event_id`) REFERENCES `event` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_event_share_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `partner_banner` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `kind`          TINYINT UNSIGNED NOT NULL,
  `event_id`      INT NULL DEFAULT NULL,
  `title`         VARCHAR(150) NULL DEFAULT NULL,
  `summary`       VARCHAR(300) NULL DEFAULT NULL,
  `details`       TEXT NULL DEFAULT NULL,
  `link_url`      VARCHAR(500) NULL DEFAULT NULL,
  `link_label`    VARCHAR(60) NULL DEFAULT NULL,
  `image_url`     VARCHAR(500) NULL DEFAULT NULL,
  `display_from`  DATE NULL DEFAULT NULL,
  `display_to`    DATE NULL DEFAULT NULL,
  `sort_order`    INT NOT NULL DEFAULT 0,
  `is_active`     TINYINT NOT NULL DEFAULT 1,
  `created_by_cp_user_id` INT NULL DEFAULT NULL,
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_partner_banner_event_idx` (`event_id` ASC) VISIBLE,
  CONSTRAINT `fk_partner_banner_event`
    FOREIGN KEY (`event_id`) REFERENCES `event` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;
