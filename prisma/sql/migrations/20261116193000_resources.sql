-- Resources library (16 Nov 2026). Suraj: "We have a Resources tab in the
-- partner module but nothing on the Admin side. How do we populate the same?"
--
--   resource_category      Settings -> Resource Categories master (name,
--                          order, active). In use = deactivate, not delete.
--   resource               one library entry: a file (versioned) or a link,
--                          with category, optional university / country tag,
--                          audience, publish / expiry dates, pinned,
--                          important, notify-partners.
--   resource_version       every file uploaded for a resource. Partners get
--                          the highest version_no; restoring an old version
--                          adds a new row pointing at the same file.
--   resource_download      every download / preview / link-open by a partner
--                          (resource, version, user, at).
--   resource_notification  who has had the bell / the email for a resource,
--                          so a re-save never resends (one row per resource
--                          per recipient, claimed per channel).
--
-- New tables only; additive and idempotent (CREATE TABLE IF NOT EXISTS, the
-- seed only into an empty table). A re-run is a no-op.

CREATE TABLE IF NOT EXISTS `resource_category` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(100) NOT NULL,
  `sort_order` INT          NOT NULL DEFAULT 0,
  `is_active`  TINYINT      NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_resource_category_name` (`name` ASC) VISIBLE
) ENGINE = InnoDB;

-- The agreed list, only into an empty table (a re-run after a Super Admin
-- renamed one must not bring the old name back).
SET @todo := (SELECT COUNT(*) = 0 FROM `resource_category`);
SET @sql := IF(@todo,
  'INSERT IGNORE INTO `resource_category` (`name`, `sort_order`, `is_active`) VALUES
     (''Training'',              10, 1),
     (''Brochures'',             20, 1),
     (''Counsellor Handbooks'',  30, 1),
     (''Marketing Creatives'',   40, 1),
     (''Forms & Templates'',     50, 1),
     (''Policies'',              60, 1)',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `resource` (
  `id`                    INT              NOT NULL AUTO_INCREMENT,
  `title`                 VARCHAR(200)     NOT NULL,
  `description`           VARCHAR(2000)    NULL DEFAULT NULL,
  `category_id`           INT              NOT NULL,
  `university_id`         INT              NULL DEFAULT NULL,
  `country`               VARCHAR(2)       NULL DEFAULT NULL,
  -- 0 = all partners, 1 = agency owners and independents, 2 = agency counsellors
  `audience`              TINYINT UNSIGNED NOT NULL DEFAULT 0,
  -- 0 = file (resource_version), 1 = link (link_url)
  `kind`                  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `link_url`              VARCHAR(1000)    NULL DEFAULT NULL,
  -- Visible from publish_on through expires_on (inclusive), India time.
  `publish_on`            DATE             NOT NULL,
  `expires_on`            DATE             NULL DEFAULT NULL,
  `is_pinned`             TINYINT          NOT NULL DEFAULT 0,
  `is_important`          TINYINT          NOT NULL DEFAULT 0,
  `notify_partners`       TINYINT          NOT NULL DEFAULT 0,
  -- When it first went live (the resource.published event); NULL until then.
  `announced_at`          TIMESTAMP        NULL DEFAULT NULL,
  `archived_at`           TIMESTAMP        NULL DEFAULT NULL,
  `created_by_cp_user_id` INT              NOT NULL,
  `updated_by_cp_user_id` INT              NULL DEFAULT NULL,
  `created_at`            TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_resource_category_idx` (`category_id` ASC) VISIBLE,
  INDEX `fk_resource_university_idx` (`university_id` ASC) VISIBLE,
  INDEX `idx_resource_live` (`archived_at` ASC, `publish_on` ASC) VISIBLE,
  INDEX `fk_resource_created_by_idx` (`created_by_cp_user_id` ASC) VISIBLE,
  INDEX `fk_resource_updated_by_idx` (`updated_by_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_resource_category`
    FOREIGN KEY (`category_id`) REFERENCES `resource_category` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_resource_university`
    FOREIGN KEY (`university_id`) REFERENCES `university` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_resource_created_by`
    FOREIGN KEY (`created_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_resource_updated_by`
    FOREIGN KEY (`updated_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `resource_version` (
  `id`                     INT          NOT NULL AUTO_INCREMENT,
  `resource_id`            INT          NOT NULL,
  `version_no`             INT          NOT NULL,
  `file_url`               VARCHAR(500) NOT NULL,
  `file_name`              VARCHAR(255) NOT NULL,
  `mime_type`              VARCHAR(120) NOT NULL,
  `size_bytes`             INT UNSIGNED NOT NULL,
  `restored_from_id`       INT          NULL DEFAULT NULL,
  `uploaded_by_cp_user_id` INT          NOT NULL,
  `created_at`             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_resource_version_no` (`resource_id` ASC, `version_no` ASC) VISIBLE,
  INDEX `fk_resource_version_uploaded_by_idx` (`uploaded_by_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_resource_version_resource`
    FOREIGN KEY (`resource_id`) REFERENCES `resource` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_resource_version_uploaded_by`
    FOREIGN KEY (`uploaded_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `resource_download` (
  `id`          INT              NOT NULL AUTO_INCREMENT,
  `resource_id` INT              NOT NULL,
  `version_id`  INT              NULL DEFAULT NULL,
  `user_id`     INT              NOT NULL,
  -- 0 = download, 1 = in-browser preview, 2 = link opened
  `action`      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`  TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_resource_download_resource_user` (`resource_id` ASC, `user_id` ASC) VISIBLE,
  INDEX `fk_resource_download_version_idx` (`version_id` ASC) VISIBLE,
  INDEX `fk_resource_download_user_idx` (`user_id` ASC) VISIBLE,
  CONSTRAINT `fk_resource_download_resource`
    FOREIGN KEY (`resource_id`) REFERENCES `resource` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_resource_download_version`
    FOREIGN KEY (`version_id`) REFERENCES `resource_version` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_resource_download_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `resource_notification` (
  `resource_id` INT       NOT NULL,
  `user_id`     INT       NOT NULL,
  `bell_at`     TIMESTAMP NULL DEFAULT NULL,
  `bell_batch`  CHAR(36)  NULL DEFAULT NULL,
  `email_at`    TIMESTAMP NULL DEFAULT NULL,
  `email_batch` CHAR(36)  NULL DEFAULT NULL,
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`resource_id`, `user_id`),
  INDEX `idx_resource_notification_bell_batch` (`bell_batch` ASC) VISIBLE,
  INDEX `idx_resource_notification_email_batch` (`email_batch` ASC) VISIBLE,
  INDEX `fk_resource_notification_user_idx` (`user_id` ASC) VISIBLE,
  CONSTRAINT `fk_resource_notification_resource`
    FOREIGN KEY (`resource_id`) REFERENCES `resource` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_resource_notification_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;
