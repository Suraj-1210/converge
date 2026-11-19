-- Counsellor tasks, shortlist follow-ups and shortlisting TAT (19 Nov 2026,
-- items 7-10; PDF "Converge - Follow-up Workflow & Task Management").
--
--   cp_task                    one counsellor task (TSK-0001 = id). Manual
--                              tasks, shortlist follow-up stage tasks, and
--                              mirrors of student Tasks & Notes reminders
--                              and application follow-ups (source/source_key;
--                              those keep their own tables and screens).
--                              original_due_date is written once, never
--                              changed; due_date is the revised one.
--                              Overdue is derived (past 19:00 IST on the due
--                              day), never stored.
--   cp_task_event              every task's history (created, not completed
--                              with a reason, shift requested / approved /
--                              rejected, rescheduled, completed) for ageing.
--   cp_day_close               a counsellor's "Close your day" for one date
--                              and whether the Head Counsellor was emailed.
--   cp_task_shift_request      the reason for an incomplete task on that day
--                              and the optional shift to the next working day,
--                              with the Head Counsellor's decision.
--   shortlist_follow_up        one partner-confirmation case per shortlist
--                              shared (at most one open per student:
--                              open_student_id is unique and NULL once over).
--   shortlist_follow_up_event  the student's follow-up history.
--   student_shortlisting       shortlisting TAT milestones (first write wins).
--   tat_action_target          + 'shortlisting': 24h SLA, editable in
--                              Settings -> TAT Settings.
--
-- New tables and one seed row only; additive and idempotent.

CREATE TABLE IF NOT EXISTS `cp_task` (
  `id`                      INT               NOT NULL AUTO_INCREMENT,
  `title`                   VARCHAR(200)      NOT NULL,
  `student_id`              INT               NOT NULL,
  `category`                TINYINT UNSIGNED  NOT NULL,              -- TaskCategory (src/lib/tasks.ts)
  `pending_activity`        VARCHAR(500)      NULL DEFAULT NULL,
  `priority`                TINYINT UNSIGNED  NOT NULL DEFAULT 1,    -- 0 Low, 1 Medium, 2 High
  `status`                  TINYINT UNSIGNED  NOT NULL DEFAULT 0,    -- 0 pending, 1 in progress, 2 completed, 3 cancelled
  `assignee_cp_user_id`     INT               NULL DEFAULT NULL,
  `created_by_cp_user_id`   INT               NULL DEFAULT NULL,
  `assigned_on`             DATE              NOT NULL,
  `original_due_date`       DATE              NULL DEFAULT NULL,     -- never changes
  `due_date`                DATE              NULL DEFAULT NULL,     -- revised due date
  `follow_up_date`          DATE              NULL DEFAULT NULL,
  `remarks`                 VARCHAR(1000)     NULL DEFAULT NULL,
  `postponements`           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `completed_at`            TIMESTAMP         NULL DEFAULT NULL,
  `completed_by_cp_user_id` INT               NULL DEFAULT NULL,
  `cancelled_at`            TIMESTAMP         NULL DEFAULT NULL,
  `cancel_reason`           VARCHAR(255)      NULL DEFAULT NULL,
  `source`                  VARCHAR(12)       NOT NULL DEFAULT 'manual', -- manual | note | follow_up | shortlist
  `source_id`               INT               NULL DEFAULT NULL,
  `source_key`              VARCHAR(40)       NULL DEFAULT NULL,     -- unique per mirrored / generated row
  `created_at`              TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_cp_task_source_key` (`source_key` ASC) VISIBLE,
  INDEX `idx_cp_task_assignee_open` (`assignee_cp_user_id` ASC, `status` ASC, `due_date` ASC) VISIBLE,
  INDEX `idx_cp_task_student` (`student_id` ASC) VISIBLE,
  INDEX `idx_cp_task_source` (`source` ASC, `source_id` ASC) VISIBLE,
  INDEX `idx_cp_task_created` (`created_at` ASC) VISIBLE,
  INDEX `fk_cp_task_created_by_idx` (`created_by_cp_user_id` ASC) VISIBLE,
  INDEX `fk_cp_task_completed_by_idx` (`completed_by_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_cp_task_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_cp_task_assignee`
    FOREIGN KEY (`assignee_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_cp_task_created_by`
    FOREIGN KEY (`created_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_cp_task_completed_by`
    FOREIGN KEY (`completed_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `cp_task_event` (
  `id`          INT           NOT NULL AUTO_INCREMENT,
  `task_id`     INT           NOT NULL,
  `kind`        VARCHAR(30)   NOT NULL,
  `cp_user_id`  INT           NULL DEFAULT NULL,
  `from_date`   DATE          NULL DEFAULT NULL,
  `to_date`     DATE          NULL DEFAULT NULL,
  `reason_code` VARCHAR(20)   NULL DEFAULT NULL,
  `note`        VARCHAR(1000) NULL DEFAULT NULL,
  `created_at`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_cp_task_event_task` (`task_id` ASC, `created_at` ASC) VISIBLE,
  INDEX `fk_cp_task_event_user_idx` (`cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_cp_task_event_task`
    FOREIGN KEY (`task_id`) REFERENCES `cp_task` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_cp_task_event_user`
    FOREIGN KEY (`cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `cp_day_close` (
  `id`                  INT       NOT NULL AUTO_INCREMENT,
  `cp_user_id`          INT       NOT NULL,
  `day`                 DATE      NOT NULL,                 -- IST working day being closed
  `submitted_at`        TIMESTAMP NULL DEFAULT NULL,        -- NULL = draft only
  `emailed_at`          TIMESTAMP NULL DEFAULT NULL,        -- Head Counsellor emailed (on submit)
  `reminder_emailed_at` TIMESTAMP NULL DEFAULT NULL,        -- evening digest: not closed by then
  `total_tasks`         INT       NOT NULL DEFAULT 0,       -- snapshot at submission
  `completed_tasks`     INT       NOT NULL DEFAULT 0,
  `created_at`          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_cp_day_close_user_day` (`cp_user_id` ASC, `day` ASC) VISIBLE,
  CONSTRAINT `fk_cp_day_close_user`
    FOREIGN KEY (`cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `cp_task_shift_request` (
  `id`                    INT               NOT NULL AUTO_INCREMENT,
  `task_id`               INT               NOT NULL,
  `day_close_id`          INT               NOT NULL,
  `day`                   DATE              NOT NULL,
  `cp_user_id`            INT               NULL DEFAULT NULL,  -- who gave the reason
  `reason_code`           VARCHAR(20)       NOT NULL,           -- DelayReason (src/lib/tasks.ts)
  `details`               VARCHAR(500)      NOT NULL,
  `shift_requested`       TINYINT           NOT NULL DEFAULT 0,
  `from_due_date`         DATE              NULL DEFAULT NULL,  -- due date when asked
  `new_due_date`          DATE              NULL DEFAULT NULL,  -- next working day
  -- 0 draft, 1 awaiting decision, 2 approved, 3 rejected, 4 reason only (no
  -- shift asked), 5 lapsed (task completed or cancelled before a decision)
  `status`                TINYINT UNSIGNED  NOT NULL DEFAULT 0,
  `approver_cp_user_id`   INT               NULL DEFAULT NULL,  -- the Head Counsellor; NULL = Super Admin
  `decided_by_cp_user_id` INT               NULL DEFAULT NULL,
  `decided_at`            TIMESTAMP         NULL DEFAULT NULL,
  `reject_reason`         VARCHAR(500)      NULL DEFAULT NULL,
  `created_at`            TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_cp_task_shift_task_day` (`task_id` ASC, `day` ASC) VISIBLE,
  INDEX `idx_cp_task_shift_status` (`status` ASC, `approver_cp_user_id` ASC) VISIBLE,
  INDEX `fk_cp_task_shift_day_close_idx` (`day_close_id` ASC) VISIBLE,
  INDEX `fk_cp_task_shift_user_idx` (`cp_user_id` ASC) VISIBLE,
  INDEX `fk_cp_task_shift_approver_idx` (`approver_cp_user_id` ASC) VISIBLE,
  INDEX `fk_cp_task_shift_decided_by_idx` (`decided_by_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_cp_task_shift_task`
    FOREIGN KEY (`task_id`) REFERENCES `cp_task` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_cp_task_shift_day_close`
    FOREIGN KEY (`day_close_id`) REFERENCES `cp_day_close` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_cp_task_shift_user`
    FOREIGN KEY (`cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_cp_task_shift_approver`
    FOREIGN KEY (`approver_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_cp_task_shift_decided_by`
    FOREIGN KEY (`decided_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `shortlist_follow_up` (
  `id`                     INT              NOT NULL AUTO_INCREMENT,
  `student_id`             INT              NOT NULL,
  `open_student_id`        INT              NULL DEFAULT NULL,  -- = student_id while open, else NULL
  -- 0 open, 1 confirmed, 2 closed at shortlisting, 3 ended (changes asked,
  -- all rejected, proposals withdrawn, student inactive)
  `status`                 TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `cycle`                  TINYINT UNSIGNED NOT NULL DEFAULT 1, -- +1 on every reopen
  `shared_at`              TIMESTAMP        NOT NULL,
  `shared_by_cp_user_id`   INT              NULL DEFAULT NULL,
  `cycle_started_at`       TIMESTAMP        NOT NULL,           -- shared_at, or the reopen
  `next_stage`             TINYINT UNSIGNED NOT NULL DEFAULT 2, -- 2 first, 3 second, 4 final follow-up
  `next_due_date`          DATE             NULL DEFAULT NULL,
  `last_recorded_at`       TIMESTAMP        NULL DEFAULT NULL,
  `outcome_at`             TIMESTAMP        NULL DEFAULT NULL,
  `outcome_by_cp_user_id`  INT              NULL DEFAULT NULL,
  `outcome_by_user_id`     INT              NULL DEFAULT NULL,  -- partner user (portal approval)
  `confirmed_via`          VARCHAR(20)      NULL DEFAULT NULL,  -- portal | counsellor | proceed
  `end_reason`             VARCHAR(30)      NULL DEFAULT NULL,
  `closure_reason`         VARCHAR(30)      NULL DEFAULT NULL,  -- ShortlistClosureReason
  `closure_note`           VARCHAR(1000)    NULL DEFAULT NULL,
  `reopened_at`            TIMESTAMP        NULL DEFAULT NULL,
  `reopened_by_cp_user_id` INT              NULL DEFAULT NULL,
  `created_at`             TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_shortlist_follow_up_open` (`open_student_id` ASC) VISIBLE,
  INDEX `idx_shortlist_follow_up_student` (`student_id` ASC) VISIBLE,
  INDEX `idx_shortlist_follow_up_status` (`status` ASC, `next_due_date` ASC) VISIBLE,
  INDEX `fk_shortlist_follow_up_shared_by_idx` (`shared_by_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_shortlist_follow_up_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_shortlist_follow_up_shared_by`
    FOREIGN KEY (`shared_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `shortlist_follow_up_event` (
  `id`              INT              NOT NULL AUTO_INCREMENT,
  `case_id`         INT              NOT NULL,
  `student_id`      INT              NOT NULL,
  `kind`            VARCHAR(30)      NOT NULL,
  `stage`           TINYINT UNSIGNED NULL DEFAULT NULL,
  `cp_user_id`      INT              NULL DEFAULT NULL,
  `partner_user_id` INT              NULL DEFAULT NULL,
  `response`        VARCHAR(20)      NULL DEFAULT NULL,  -- confirmed | changes | pending
  `channels`        VARCHAR(40)      NULL DEFAULT NULL,  -- call,email,whatsapp
  `call_time`       VARCHAR(10)      NULL DEFAULT NULL,
  `call_outcome`    VARCHAR(30)      NULL DEFAULT NULL,
  `comments`        VARCHAR(1000)    NULL DEFAULT NULL,
  `task_id`         INT              NULL DEFAULT NULL,
  `detail`          VARCHAR(500)     NULL DEFAULT NULL,
  `created_at`      TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_shortlist_follow_up_event_case` (`case_id` ASC, `created_at` ASC) VISIBLE,
  INDEX `idx_shortlist_follow_up_event_student` (`student_id` ASC, `created_at` ASC) VISIBLE,
  CONSTRAINT `fk_shortlist_follow_up_event_case`
    FOREIGN KEY (`case_id`) REFERENCES `shortlist_follow_up` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_shortlist_follow_up_event_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `student_shortlisting` (
  `student_id`                INT       NOT NULL,
  `assigned_at`               TIMESTAMP NULL DEFAULT NULL,
  `review_started_at`         TIMESTAMP NULL DEFAULT NULL,
  `review_completed_at`       TIMESTAMP NULL DEFAULT NULL,
  `docs_verified_at`          TIMESTAMP NULL DEFAULT NULL,
  `shortlisting_started_at`   TIMESTAMP NULL DEFAULT NULL,
  `shortlisting_completed_at` TIMESTAMP NULL DEFAULT NULL,
  `shared_at`                 TIMESTAMP NULL DEFAULT NULL,
  `confirmed_at`              TIMESTAMP NULL DEFAULT NULL,
  `updated_at`                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`student_id`),
  CONSTRAINT `fk_student_shortlisting_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;

-- Shortlisting SLA (Suraj, 19 Nov): 24 hours from student added to shortlist
-- shared, weekend and TAT-holiday hours excluded. INSERT IGNORE keeps a Super Admin's edit.
INSERT IGNORE INTO `tat_action_target` (`action_key`, `label`, `threshold_minutes`, `warning_pct`, `active`)
VALUES ('shortlisting', 'Shortlisting', 1440, 80, 1);
