-- Partner chat and the first real TAT backend (17 Oct 2026).
--
-- Partner chat: one thread per student, between the partner side (the agency
-- owner, plus the agency counsellor assigned to the student; for an
-- independent, the independent) and the Collegepond side (the student's
-- Collegepond counsellor, their Counselling Lead, and Super Admin).
-- Participants are never stored. They follow the student's current
-- assignment, so a new assignee sees the whole history. This is separate from
-- WhatsApp (whatsapp_message / Periskope).
--
-- partner_chat_thread: one row per student, created with the first message.
--   It caches the latest message for the inboxes, and it carries the TAT
--   clock: awaiting_since is the first partner message that has no
--   Collegepond reply yet. tat_warned_at and tat_breached_at record that the
--   warning and breach alerts for the current wait went out (cleared on reply).
-- partner_chat_message: kind 'user' or 'system'. System messages (e.g. "file
--   saved to Documents") never start or stop the TAT clock. A Collegepond reply
--   that ends a wait records the wait (tat_started_at, tat_business_minutes,
--   and the assigned counsellor at the time) for TAT reporting. No deletes;
--   edits within 5 minutes, audit-logged.
-- partner_chat_attachment: files sent in chat (private storage, chat/<student>/).
--   It's uploaded first (message_id NULL), then attached by the send. It can be
--   saved into the student's documents (saved_document_id).
-- partner_chat_read: per participant read position (read receipts and unread
--   counts), plus how far the unread-message email has gone.
--
-- TAT master (Settings -> TAT Settings, Super Admin): working days and hours in
-- a timezone, holidays, and per-action targets with a warning percentage.
-- "chat_response" is the first action. Others can be added later.
--
-- Additive only: new tables and their default rows.

CREATE TABLE IF NOT EXISTS `partner_chat_thread` (
  `id`                  INT          NOT NULL AUTO_INCREMENT,
  `student_id`          INT          NOT NULL,
  `last_message_id`     INT          NULL DEFAULT NULL,
  `last_message_at`     TIMESTAMP    NULL DEFAULT NULL,
  `last_sender_side`    VARCHAR(10)  NULL DEFAULT NULL,
  `last_preview`        VARCHAR(200) NULL DEFAULT NULL,
  `awaiting_since`      TIMESTAMP    NULL DEFAULT NULL,
  `awaiting_message_id` INT          NULL DEFAULT NULL,
  `tat_warned_at`       TIMESTAMP    NULL DEFAULT NULL,
  `tat_breached_at`     TIMESTAMP    NULL DEFAULT NULL,
  `created_at`          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_partner_chat_thread_student` (`student_id` ASC) VISIBLE,
  INDEX `idx_partner_chat_thread_last` (`last_message_at` ASC) VISIBLE,
  INDEX `idx_partner_chat_thread_awaiting` (`awaiting_since` ASC) VISIBLE,
  CONSTRAINT `fk_partner_chat_thread_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `partner_chat_message` (
  `id`                        INT         NOT NULL AUTO_INCREMENT,
  `thread_id`                 INT         NOT NULL,
  `kind`                      VARCHAR(10) NOT NULL DEFAULT 'user',
  `sender_side`               VARCHAR(10) NOT NULL,
  `sender_user_id`            INT         NULL DEFAULT NULL,
  `sender_cp_user_id`         INT         NULL DEFAULT NULL,
  `impersonator_cp_user_id`   INT         NULL DEFAULT NULL,
  `body`                      TEXT        NULL,
  `edited_at`                 TIMESTAMP   NULL DEFAULT NULL,
  `tat_started_at`            TIMESTAMP   NULL DEFAULT NULL,
  `tat_business_minutes`      INT         NULL DEFAULT NULL,
  `tat_counsellor_cp_user_id` INT         NULL DEFAULT NULL,
  `created_at`                TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_partner_chat_message_thread` (`thread_id` ASC, `id` ASC) VISIBLE,
  INDEX `idx_partner_chat_message_tat` (`tat_started_at` ASC) VISIBLE,
  INDEX `fk_partner_chat_message_user_idx` (`sender_user_id` ASC) VISIBLE,
  INDEX `fk_partner_chat_message_cp_user_idx` (`sender_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_partner_chat_message_thread`
    FOREIGN KEY (`thread_id`) REFERENCES `partner_chat_thread` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_partner_chat_message_user`
    FOREIGN KEY (`sender_user_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_partner_chat_message_cp_user`
    FOREIGN KEY (`sender_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `partner_chat_attachment` (
  `id`                     INT          NOT NULL AUTO_INCREMENT,
  `thread_id`              INT          NOT NULL,
  `message_id`             INT          NULL DEFAULT NULL,
  `uploaded_side`          VARCHAR(10)  NOT NULL,
  `uploaded_by_user_id`    INT          NULL DEFAULT NULL,
  `uploaded_by_cp_user_id` INT          NULL DEFAULT NULL,
  `file_name`              VARCHAR(255) NOT NULL,
  `file_url`               VARCHAR(500) NOT NULL,
  `mime_type`              VARCHAR(100) NULL DEFAULT NULL,
  `size_bytes`             INT          NULL DEFAULT NULL,
  `saved_document_id`      INT          NULL DEFAULT NULL,
  `saved_at`               TIMESTAMP    NULL DEFAULT NULL,
  `created_at`             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_partner_chat_attachment_message` (`message_id` ASC) VISIBLE,
  INDEX `idx_partner_chat_attachment_thread` (`thread_id` ASC) VISIBLE,
  INDEX `idx_partner_chat_attachment_file` (`file_url` ASC) VISIBLE,
  INDEX `fk_partner_chat_attachment_document_idx` (`saved_document_id` ASC) VISIBLE,
  CONSTRAINT `fk_partner_chat_attachment_thread`
    FOREIGN KEY (`thread_id`) REFERENCES `partner_chat_thread` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_partner_chat_attachment_message`
    FOREIGN KEY (`message_id`) REFERENCES `partner_chat_message` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_partner_chat_attachment_document`
    FOREIGN KEY (`saved_document_id`) REFERENCES `document` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `partner_chat_read` (
  `id`                         INT         NOT NULL AUTO_INCREMENT,
  `thread_id`                  INT         NOT NULL,
  `side`                       VARCHAR(10) NOT NULL,
  `reader_id`                  INT         NOT NULL,
  `last_read_message_id`       INT         NOT NULL DEFAULT 0,
  `emailed_through_message_id` INT         NOT NULL DEFAULT 0,
  `read_at`                    TIMESTAMP   NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_partner_chat_read` (`thread_id` ASC, `side` ASC, `reader_id` ASC) VISIBLE,
  CONSTRAINT `fk_partner_chat_read_thread`
    FOREIGN KEY (`thread_id`) REFERENCES `partner_chat_thread` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `tat_setting` (
  `id`                    INT         NOT NULL,
  `timezone`              VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  `work_days`             VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5,6',
  `day_start_minute`      SMALLINT    NOT NULL DEFAULT 600,
  `day_end_minute`        SMALLINT    NOT NULL DEFAULT 1140,
  `updated_by_cp_user_id` INT         NULL DEFAULT NULL,
  `updated_at`            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `tat_holiday` (
  `id`           INT          NOT NULL AUTO_INCREMENT,
  `holiday_date` DATE         NOT NULL,
  `name`         VARCHAR(100) NOT NULL,
  `created_at`   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_tat_holiday_date` (`holiday_date` ASC) VISIBLE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `tat_action_target` (
  `id`                    INT          NOT NULL AUTO_INCREMENT,
  `action_key`            VARCHAR(50)  NOT NULL,
  `label`                 VARCHAR(100) NOT NULL,
  `threshold_minutes`     INT          NOT NULL,
  `warning_pct`           TINYINT      NOT NULL DEFAULT 80,
  `active`                TINYINT      NOT NULL DEFAULT 1,
  `updated_by_cp_user_id` INT          NULL DEFAULT NULL,
  `updated_at`            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_tat_action_target_key` (`action_key` ASC) VISIBLE
) ENGINE = InnoDB;

-- Suraj, 17 Oct 2026: Mon–Sat 10:00–19:00 IST; a chat reply within 2 business
-- hours, with the warning at 80%.
INSERT IGNORE INTO `tat_setting` (`id`, `timezone`, `work_days`, `day_start_minute`, `day_end_minute`)
VALUES (1, 'Asia/Kolkata', '1,2,3,4,5,6', 600, 1140);

INSERT IGNORE INTO `tat_action_target` (`action_key`, `label`, `threshold_minutes`, `warning_pct`, `active`)
VALUES ('chat_response', 'Chat Response', 120, 80, 1);
