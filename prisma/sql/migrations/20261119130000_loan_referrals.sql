-- Loan lead sharing with the Collegepond Enrollment App (19 Nov 2026), Phase 1.
-- Partners refer education-loan leads from Converge; the loan counsellors work
-- them in the Enrollment App (Firebase), which pushes progress back here so the
-- partner can follow it. Spec: Claude Doc "B2B Loan Lead Sharing"; wire format:
-- docs/loan-sharing/CONTRACT.md.
--
--   loan_referral              one row per referral: who referred (org or
--                              independent, the referring user), the student
--                              (student_id, or contact details for a loan-only
--                              referral), consent, send status, the Enrollment
--                              loan lead id, and the lead's current state as
--                              last reported (stage, counsellor, follow-up).
--   loan_referral_application  one row per lender application on the lead.
--   loan_referral_event        every event received (unique event_id = the
--                              idempotency key) plus Converge's own; rows with
--                              visible = 1 make up the partner's timeline.
--
-- New tables only; additive and idempotent. A re-run is a no-op.

CREATE TABLE IF NOT EXISTS `loan_referral` (
  `id`                INT             NOT NULL AUTO_INCREMENT,
  `public_id`         CHAR(36)        NOT NULL,
  `org_id`            INT             NULL DEFAULT NULL,
  `partner_user_id`   INT             NOT NULL,
  `student_id`        INT             NULL DEFAULT NULL,
  `student_name`      VARCHAR(150)    NOT NULL,
  `phone`             VARCHAR(20)     NOT NULL,
  `email`             VARCHAR(255)    NOT NULL,
  `intake`            VARCHAR(20)     NOT NULL,
  `country`           VARCHAR(2)      NULL DEFAULT NULL,
  `university`        VARCHAR(255)    NULL DEFAULT NULL,
  `course_level`      TINYINT UNSIGNED NULL DEFAULT NULL,
  `loan_amount`       DECIMAL(14,2)   NULL DEFAULT NULL,
  `note`              VARCHAR(1000)   NULL DEFAULT NULL,
  `consent_at`        TIMESTAMP       NOT NULL,
  `send_status`       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `send_attempts`     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `next_attempt_at`   TIMESTAMP       NULL DEFAULT NULL,
  `last_error`        VARCHAR(500)    NULL DEFAULT NULL,
  `received_at`       TIMESTAMP       NULL DEFAULT NULL,
  `loan_lead_id`      VARCHAR(64)     NULL DEFAULT NULL,
  `stage`             VARCHAR(30)     NULL DEFAULT NULL,
  `counsellor_name`   VARCHAR(150)    NULL DEFAULT NULL,
  `next_follow_up_at` TIMESTAMP       NULL DEFAULT NULL,
  `closure_reason`    VARCHAR(255)    NULL DEFAULT NULL,
  `last_update_at`    TIMESTAMP       NULL DEFAULT NULL,
  `lead_synced_at`    TIMESTAMP(3)    NULL DEFAULT NULL,
  `created_at`        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_loan_referral_public_id` (`public_id` ASC) VISIBLE,
  INDEX `idx_loan_referral_org` (`org_id` ASC) VISIBLE,
  INDEX `idx_loan_referral_partner_user` (`partner_user_id` ASC) VISIBLE,
  INDEX `idx_loan_referral_student` (`student_id` ASC) VISIBLE,
  INDEX `idx_loan_referral_send` (`send_status` ASC, `next_attempt_at` ASC) VISIBLE,
  CONSTRAINT `fk_loan_referral_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_loan_referral_partner_user`
    FOREIGN KEY (`partner_user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_loan_referral_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_referral_application` (
  `id`                INT             NOT NULL AUTO_INCREMENT,
  `referral_id`       INT             NOT NULL,
  `external_id`       VARCHAR(64)     NOT NULL,
  `lender`            VARCHAR(150)    NOT NULL,
  `status`            VARCHAR(30)     NOT NULL,
  `loan_amount`       DECIMAL(14,2)   NULL DEFAULT NULL,
  `sanctioned_amount` DECIMAL(14,2)   NULL DEFAULT NULL,
  `roi`               DECIMAL(6,3)    NULL DEFAULT NULL,
  `disbursed_amount`  DECIMAL(14,2)   NULL DEFAULT NULL,
  `disbursed_at`      TIMESTAMP       NULL DEFAULT NULL,
  `synced_at`         TIMESTAMP(3)    NOT NULL,
  `created_at`        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_loan_referral_application_ext` (`referral_id` ASC, `external_id` ASC) VISIBLE,
  CONSTRAINT `fk_loan_referral_application_referral`
    FOREIGN KEY (`referral_id`) REFERENCES `loan_referral` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_referral_event` (
  `id`          INT           NOT NULL AUTO_INCREMENT,
  `referral_id` INT           NOT NULL,
  `event_id`    VARCHAR(120)  NOT NULL,
  `kind`        VARCHAR(30)   NOT NULL,
  `visible`     TINYINT       NOT NULL DEFAULT 0,
  `title`       VARCHAR(255)  NULL DEFAULT NULL,
  `body`        VARCHAR(1000) NULL DEFAULT NULL,
  `actor_name`  VARCHAR(150)  NULL DEFAULT NULL,
  `occurred_at` TIMESTAMP(3)  NOT NULL,
  `created_at`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_loan_referral_event_event_id` (`event_id` ASC) VISIBLE,
  INDEX `idx_loan_referral_event_referral` (`referral_id` ASC, `occurred_at` ASC) VISIBLE,
  CONSTRAINT `fk_loan_referral_event_referral`
    FOREIGN KEY (`referral_id`) REFERENCES `loan_referral` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;
