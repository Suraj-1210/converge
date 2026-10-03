-- =============================================================================
-- Converge — MySQL schema
-- =============================================================================
-- Source of truth for the database structure. Generated via MySQL Workbench
-- Forward Engineering.
--
-- This file is intended to be run against an already-selected database (the
-- wrapper script in scripts/db-reset.sh handles DROP / CREATE / USE based on
-- the DATABASE_URL in .env).
-- =============================================================================

SET @OLD_UNIQUE_CHECKS      = @@UNIQUE_CHECKS,      UNIQUE_CHECKS = 0;
SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0;
SET @OLD_SQL_MODE           = @@SQL_MODE,
    SQL_MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';


-- -----------------------------------------------------
-- organization
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `organization` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `name`                  VARCHAR(100) NOT NULL,
  `type`                  TINYINT(3) UNSIGNED NOT NULL,
  `website`               VARCHAR(255) NULL DEFAULT NULL,
  `address`               VARCHAR(255) NULL DEFAULT NULL,
  `city`                  VARCHAR(100) NULL DEFAULT NULL,
  `state`                 VARCHAR(100) NULL DEFAULT NULL,
  `country`               VARCHAR(2)   NULL DEFAULT NULL,
  `num_counsellors`       TINYINT(5) UNSIGNED NULL DEFAULT NULL,
  `is_verified`           TINYINT NOT NULL DEFAULT 0,
  `created_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `annual_student_volume` TINYINT(5) UNSIGNED NULL DEFAULT NULL,
  `url_identifier`        VARCHAR(100) NOT NULL,
  `logo_url`              VARCHAR(255) NULL DEFAULT NULL,
  `gst_number`            VARCHAR(20)  NULL DEFAULT NULL,
  `gst_registered`        TINYINT      NULL DEFAULT NULL,
  `pan`                   VARCHAR(15)  NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `url_identifier_UNIQUE` (`url_identifier` ASC) VISIBLE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- cp_user  (internal staff accounts; carries role)
-- (renamed from collegepond_user)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `cp_user` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `first_name`    VARCHAR(50)  NOT NULL,
  `last_name`     VARCHAR(50)  NOT NULL,
  `email`         VARCHAR(125) NOT NULL,
  `phone`         VARCHAR(45)  NOT NULL,
  `role`          TINYINT(8) UNSIGNED NOT NULL,
  `department`    VARCHAR(100) NULL DEFAULT NULL,
  `status`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `last_login_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `email_UNIQUE` (`email` ASC) VISIBLE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- user  (FK -> organization, collegepond_user)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `user` (
  `id`                              INT NOT NULL AUTO_INCREMENT,
  `first_name`                      VARCHAR(50)  NOT NULL,
  `last_name`                       VARCHAR(50)  NOT NULL,
  `type`                            TINYINT(5) UNSIGNED NOT NULL,
  `email`                           VARCHAR(255) NOT NULL,
  `phone`                           VARCHAR(45)  NOT NULL,
  `is_owner`                        TINYINT NOT NULL DEFAULT 0,
  `status`                          TINYINT(3) UNSIGNED NOT NULL DEFAULT 0,
  `avatar_url`                      VARCHAR(500) NULL DEFAULT NULL,
  `is_email_verified`               TINYINT NOT NULL DEFAULT 0,
  `is_phone_verified`               TINYINT NOT NULL DEFAULT 0,
  `tracking_id`                     VARCHAR(50)  NULL DEFAULT NULL,
  `org_id`                          INT NULL DEFAULT NULL,
  `date_of_birth`                   DATE NULL DEFAULT NULL,
  `gender`                          TINYINT(3) UNSIGNED NULL DEFAULT NULL,
  `nationality`                     VARCHAR(2)   NULL DEFAULT NULL,
  `address`                         VARCHAR(255) NOT NULL,
  `city`                            VARCHAR(100) NOT NULL,
  `state`                           VARCHAR(100) NOT NULL,
  `country`                         VARCHAR(2)   NOT NULL,
  `approved_by_cp_user_id`          INT NULL DEFAULT NULL,
  `lead_counsellor_id`              INT NULL DEFAULT NULL,
  `counsellor_id`                   INT NULL DEFAULT NULL,
  `bdm_id`                          INT NULL DEFAULT NULL,
  `notes`                           VARCHAR(255) NULL DEFAULT NULL,
  `status_reason`                   VARCHAR(500) NULL DEFAULT NULL,
  `tier`                            TINYINT(3) UNSIGNED NOT NULL DEFAULT 0,
  `mou_signed_at`                   TIMESTAMP NULL DEFAULT NULL,
  `last_login_at`                   TIMESTAMP NULL DEFAULT NULL,
  `created_at`                      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `email_UNIQUE`       (`email` ASC) VISIBLE,
  UNIQUE INDEX `tracking_id_UNIQUE` (`tracking_id` ASC) VISIBLE,
  INDEX `fk_user_organization_idx`           (`org_id` ASC) VISIBLE,
  INDEX `fk_user_collegepond_user1_idx`      (`approved_by_cp_user_id` ASC) VISIBLE,
  INDEX `fk_user_collegepond_user1_idx1`     (`lead_counsellor_id` ASC) VISIBLE,
  INDEX `fk_user_collegepond_user2_idx`      (`counsellor_id` ASC) VISIBLE,
  INDEX `fk_user_collegepond_user_bdm_idx`   (`bdm_id` ASC) VISIBLE,
  CONSTRAINT `fk_user_organization`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_user_approved_by_collegepond_user`
    FOREIGN KEY (`approved_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_user_lead_counsellor`
    FOREIGN KEY (`lead_counsellor_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_user_counsellor`
    FOREIGN KEY (`counsellor_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_user_bdm`
    FOREIGN KEY (`bdm_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- document  (FK -> organization, user)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `document` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `file_name`       VARCHAR(255) NOT NULL,
  `file_url`        VARCHAR(500) NOT NULL,
  `mime_type`       VARCHAR(100) NULL DEFAULT NULL,
  `is_most_recent`  TINYINT(1) NOT NULL DEFAULT 1,
  `doc_type`        VARCHAR(50)  NOT NULL,
  `status`          TINYINT(3) UNSIGNED NOT NULL DEFAULT 0,
  `created_at`      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `org_id`          INT NULL DEFAULT NULL,
  `user_id`         INT NULL DEFAULT NULL,
  `is_org_document` TINYINT NOT NULL DEFAULT 0,
  `student_id`      INT NULL DEFAULT NULL,           -- student-profile documents
  `size_bytes`      INT NULL DEFAULT NULL,
  `description`     VARCHAR(255) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_document_organization1_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_document_user1_idx`         (`user_id` ASC) VISIBLE,
  INDEX `fk_document_student_idx`       (`student_id` ASC) VISIBLE,
  CONSTRAINT `fk_document_organization`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_document_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT `fk_document_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- session  (FK -> user)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `session` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `token_hash` VARCHAR(255) NOT NULL,
  `ip_address` VARCHAR(45)  NULL DEFAULT NULL,
  `user_agent` VARCHAR(500) NULL DEFAULT NULL,
  `expires_at` TIMESTAMP NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `user_id`    INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `token_hash_UNIQUE`  (`token_hash` ASC) VISIBLE,
  INDEX        `fk_session_user1_idx` (`user_id` ASC) VISIBLE,
  CONSTRAINT `fk_session_user1`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- student  (FK -> organization, user, collegepond_user)
-- AUTO_INCREMENT starts at 10001 so display IDs read CP-10001+ (mockup style).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `student` (
  `id`                 INT NOT NULL AUTO_INCREMENT,
  `first_name`         VARCHAR(50)  NOT NULL,
  `last_name`          VARCHAR(50)  NOT NULL,
  `email`              VARCHAR(255) NOT NULL,
  `phone`              VARCHAR(20)  NOT NULL,
  `country`            VARCHAR(2)   NOT NULL,  -- destination interest, not nationality
  `intake`             VARCHAR(20)  NOT NULL,
  `created_at`         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `gender`             TINYINT(3) UNSIGNED NULL DEFAULT NULL,
  `org_id`             INT NULL,                        -- NULL for independent counsellors
  `counsellor_id`      INT NULL,                        -- partner-side counsellor (scoping)
  `date_of_birth`      DATE NOT NULL,
  `nationality`        VARCHAR(2)  NULL DEFAULT NULL,
  `status`             TINYINT UNSIGNED NOT NULL DEFAULT 0,  -- StudentStatus enum (enums.ts)
  `course_level`       TINYINT UNSIGNED NULL DEFAULT NULL,   -- CourseLevel enum
  `interested_program` VARCHAR(100) NULL DEFAULT NULL,
  `needs_edu_loan`     TINYINT(1) NULL DEFAULT NULL,  -- renamed from education_loan
  `apply_through_cp`   TINYINT(1) NULL DEFAULT NULL,
  `cp_counsellor_id`   INT NULL DEFAULT NULL,           -- CP-side assigned counsellor
  `created_by_user_id` INT NULL DEFAULT NULL,           -- partner user who created the record
  -- Profile-page personal information (cp-student-profile mock)
  `middle_name`               VARCHAR(50)  NULL DEFAULT NULL,
  `marital_status`            TINYINT UNSIGNED NULL DEFAULT NULL,  -- 0 Single … 4 Prefer not to say
  `mailing_address1`          VARCHAR(255) NULL DEFAULT NULL,
  `mailing_address2`          VARCHAR(255) NULL DEFAULT NULL,
  `mailing_city`              VARCHAR(100) NULL DEFAULT NULL,
  `mailing_state`             VARCHAR(100) NULL DEFAULT NULL,
  `mailing_country`           VARCHAR(50)  NULL DEFAULT NULL,
  `mailing_postal`            VARCHAR(20)  NULL DEFAULT NULL,
  `permanent_same_as_mailing` TINYINT NOT NULL DEFAULT 0,
  `permanent_address1`        VARCHAR(255) NULL DEFAULT NULL,
  `permanent_address2`        VARCHAR(255) NULL DEFAULT NULL,
  `permanent_city`            VARCHAR(100) NULL DEFAULT NULL,
  `permanent_state`           VARCHAR(100) NULL DEFAULT NULL,
  `permanent_country`         VARCHAR(50)  NULL DEFAULT NULL,
  `permanent_postal`          VARCHAR(20)  NULL DEFAULT NULL,
  `dual_citizenship`          TINYINT NULL DEFAULT NULL,
  `passport_number`           VARCHAR(20)  NULL DEFAULT NULL,
  `passport_expiry`           DATE NULL DEFAULT NULL,
  `visa_refused`              TINYINT NULL DEFAULT NULL,
  `visa_refused_details`      VARCHAR(500) NULL DEFAULT NULL,
  `criminal_record`           TINYINT NULL DEFAULT NULL,
  `criminal_record_details`   VARCHAR(500) NULL DEFAULT NULL,
  `medical_condition`         TINYINT NULL DEFAULT NULL,
  `medical_condition_details` VARCHAR(500) NULL DEFAULT NULL,
  `highest_education_level`   TINYINT UNSIGNED NULL DEFAULT NULL,  -- EducationLevel enum
  PRIMARY KEY (`id`),
  UNIQUE INDEX `student_email_UNIQUE`  (`email` ASC) VISIBLE,
  INDEX `fk_student_organization1_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_student_user1_idx`         (`counsellor_id` ASC) VISIBLE,
  INDEX `idx_student_status`           (`status` ASC) VISIBLE,
  INDEX `idx_student_cp_counsellor`    (`cp_counsellor_id` ASC) VISIBLE,
  INDEX `idx_student_created_by`       (`created_by_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_student_organization`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_student_user`
    FOREIGN KEY (`counsellor_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT `fk_student_cp_counsellor`
    FOREIGN KEY (`cp_counsellor_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_student_created_by`
    FOREIGN KEY (`created_by_user_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB AUTO_INCREMENT = 10001;


-- -----------------------------------------------------
-- university
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `university` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(150) NOT NULL,
  `code`       VARCHAR(50) NULL DEFAULT NULL,             -- Admin-chosen identifier; used by bulk imports + ZIP logo matching
  `city`       VARCHAR(100) NOT NULL,
  `country`    VARCHAR(2)   NOT NULL,
  `type`       TINYINT NOT NULL DEFAULT 0,                -- 0=Public, 1=Private
  `ranking`    SMALLINT UNSIGNED NULL DEFAULT NULL,       -- QS / equivalent ranking
  `app_source` VARCHAR(50) NULL DEFAULT NULL,             -- "University Portal", "Agent Portal", "Paper-based Application"
  `website`    VARCHAR(255) NULL DEFAULT NULL,
  `logo_url`   VARCHAR(255) NULL DEFAULT NULL,
  `is_open`    TINYINT NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uni_code_UNIQUE` (`code` ASC)
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- course  (FK -> university)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `course` (
  `id`                            INT NOT NULL AUTO_INCREMENT,
  `name`                          VARCHAR(150) NOT NULL,
  `degree_level`                  TINYINT(5) UNSIGNED NOT NULL,
  `duration_months`               SMALLINT NOT NULL,
  `tuition_fee`                   DECIMAL(12,2) NOT NULL,
  `currency`                      CHAR(3) NOT NULL,
  `is_open`                       TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`                    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `university_id`                 INT NOT NULL,
  `code`                          VARCHAR(50) NULL DEFAULT NULL,
  -- Catalog enrichment fields populated from the Master_B2B import.
  `url`                           VARCHAR(255)  NOT NULL,
  `toefl`                         DECIMAL(5,2) UNSIGNED NULL DEFAULT NULL,
  `ielts`                         DECIMAL(3,1) UNSIGNED NULL DEFAULT NULL,
  `duolingo`                      SMALLINT UNSIGNED NULL DEFAULT NULL,  -- renamed from det
  `pte`                           DECIMAL(4,1) NULL DEFAULT NULL,
  `gre`                           SMALLINT NULL DEFAULT NULL,
  `gmat`                          SMALLINT NULL DEFAULT NULL,
  `is_stem`                       TINYINT(1) NULL DEFAULT NULL,
  `intake_month`                  VARCHAR(50)   NULL DEFAULT NULL,
  `intake_year`                   SMALLINT UNSIGNED NULL DEFAULT NULL,
  `is_coop_available`             TINYINT(1) NULL DEFAULT NULL,
  `has_app_fee_waiver`            TINYINT(1) NULL DEFAULT NULL,
  `app_fee`                       DECIMAL(7,2) UNSIGNED NULL DEFAULT NULL,
  `application_deadline`          DATE NULL DEFAULT NULL,
  `has_tuition_deposit`           TINYINT(1) NOT NULL DEFAULT 0,
  `has_scholarship`               TINYINT(1) NOT NULL DEFAULT 0,
  `scholarship_amount`            DECIMAL(12,2) UNSIGNED NULL DEFAULT NULL,
  `min_entry_req`                 VARCHAR(50)   NULL DEFAULT NULL,  -- renamed from min_entry_requirements
  `min_entry_requirements_scale`  VARCHAR(20)   NULL DEFAULT NULL,
  `has_faster_tat`                TINYINT(1) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_course_university1_idx` (`university_id` ASC) VISIBLE,
  UNIQUE INDEX `code_UNIQUE`        (`code` ASC) VISIBLE,
  CONSTRAINT `fk_course_university`
    FOREIGN KEY (`university_id`) REFERENCES `university` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- application  (FK -> student, course, organization)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `application` (
  `id`                 INT NOT NULL AUTO_INCREMENT,
  `status`             TINYINT(7) NOT NULL DEFAULT 0,
  `submitted_at`       TIMESTAMP NULL DEFAULT NULL,
  `decided_at`         TIMESTAMP NULL DEFAULT NULL,
  `created_at`         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `notes`              VARCHAR(1000) NULL DEFAULT NULL,
  `student_id`         INT NOT NULL,
  `course_id`          INT NOT NULL,
  `org_id`             INT NOT NULL,
  `offer_letter_url`   VARCHAR(255) NULL DEFAULT NULL,
  `program_start_date` DATE NULL DEFAULT NULL,
  `university_app_id`  VARCHAR(100) NULL DEFAULT NULL,
  `counsellor_vendor`  VARCHAR(100) NULL DEFAULT NULL,
  `conditional_docs`   JSON NULL DEFAULT NULL,
  `deposit_deadline`   DATE NULL DEFAULT NULL,
  `deposit_amount`     DECIMAL(12,2) NULL DEFAULT NULL,
  `deposit_currency`   CHAR(3) NULL DEFAULT NULL,
  -- Counsellor's structured vendor pick (the university × vendor deal).
  `commission_contract_id` INT NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_application_student1_idx`      (`student_id` ASC) VISIBLE,
  INDEX `fk_application_course1_idx`       (`course_id` ASC) VISIBLE,
  INDEX `fk_application_organization1_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_application_commission_contract_idx` (`commission_contract_id` ASC) VISIBLE,
  CONSTRAINT `fk_application_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_application_course`
    FOREIGN KEY (`course_id`) REFERENCES `course` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_application_organization`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_application_commission_contract`
    FOREIGN KEY (`commission_contract_id`) REFERENCES `commission_contract` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- commission  (FK -> application, organization)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `commission` (
  `id`                       INT NOT NULL AUTO_INCREMENT,
  `tuition_fee`              DECIMAL(12,2) NOT NULL,
  `currency`                 CHAR(3) NOT NULL,
  `commision_rate`           DECIMAL(5,2)  NOT NULL,
  `commision_amount`         DECIMAL(12,2) NOT NULL,
  `partner_paid_at`          TIMESTAMP NULL DEFAULT NULL,
  `created_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `application_id`           INT NOT NULL,
  `org_id`                   INT NOT NULL,
  `collegepond_received_at`  TIMESTAMP NULL DEFAULT NULL,
  -- Spine state = the two milestone timestamps (collegepond_received_at,
  -- partner_paid_at). The CommissionStatus badge is derived on read.
  `cp_share_pct`             DECIMAL(5,2)  NULL DEFAULT NULL,
  `partner_share_pct`        DECIMAL(5,2)  NULL DEFAULT NULL,
  `claimable_inr`            DECIMAL(14,2) NULL DEFAULT NULL,
  `received_fx_rate`         DECIMAL(12,4) NULL DEFAULT NULL,
  `vendor_id`                INT NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_commission_application1_idx`  (`application_id` ASC) VISIBLE,
  UNIQUE INDEX `application_id_UNIQUE`    (`application_id` ASC) VISIBLE,
  INDEX `fk_commission_organization1_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_commission_vendor_idx`        (`vendor_id` ASC) VISIBLE,
  CONSTRAINT `fk_commission_application`
    FOREIGN KEY (`application_id`) REFERENCES `application` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_commission_organization`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_commission_vendor`
    FOREIGN KEY (`vendor_id`) REFERENCES `vendor` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- invoice  (FK -> organization)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `invoice_number`        VARCHAR(30) NOT NULL,
  `invoice_date`          DATE NOT NULL,
  `total_amount`          DECIMAL(14,2) NOT NULL,
  `currency`              CHAR(3) NOT NULL,
  `status`                TINYINT(5) UNSIGNED NOT NULL DEFAULT 0,
  `bank_details`          VARCHAR(1000) NULL DEFAULT NULL,
  `notes`                 VARCHAR(1000) NULL DEFAULT NULL,
  `signatory_name`        VARCHAR(100)  NULL DEFAULT NULL,
  `signatory_designation` VARCHAR(100)  NULL DEFAULT NULL,
  -- GST tax-invoice snapshot (partner is the supplier): intra-state CGST+SGST,
  -- inter-state IGST, unregistered partner -> less TDS @2% u/s 194J.
  `gstin`                 VARCHAR(20)  NULL DEFAULT NULL,
  `pan`                   VARCHAR(15)  NULL DEFAULT NULL,
  `sac_code`              VARCHAR(10)  NULL DEFAULT NULL,
  `is_interstate`         TINYINT      NULL DEFAULT NULL,
  `cgst_amount`           DECIMAL(12,2) NULL DEFAULT NULL,
  `sgst_amount`           DECIMAL(12,2) NULL DEFAULT NULL,
  `igst_amount`           DECIMAL(12,2) NULL DEFAULT NULL,
  `tds_amount`            DECIMAL(12,2) NULL DEFAULT NULL,
  `net_payable`           DECIMAL(14,2) NULL DEFAULT NULL,
  `signed_at`             TIMESTAMP NULL DEFAULT NULL,
  `rejection_reason`      VARCHAR(500) NULL DEFAULT NULL,
  `bank_account_id`       INT NULL DEFAULT NULL,
  `fy`                    SMALLINT NULL DEFAULT NULL,
  `created_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `org_id`                INT NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_invoice_organization1_idx` (`org_id` ASC) VISIBLE,
  UNIQUE INDEX `invoice_number_UNIQUE` (`invoice_number` ASC) VISIBLE,
  INDEX `fk_invoice_bank_account_idx` (`bank_account_id` ASC) VISIBLE,
  CONSTRAINT `fk_invoice_organization`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_invoice_bank_account`
    FOREIGN KEY (`bank_account_id`) REFERENCES `partner_bank_account` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- event
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `event` (
  `id`             INT NOT NULL AUTO_INCREMENT,
  `title`          VARCHAR(255) NOT NULL,
  `event_type`     TINYINT(5) UNSIGNED NOT NULL,
  `description`    VARCHAR(1000) NULL DEFAULT NULL,
  `event_date`     DATE NOT NULL,
  `start_time`     TIME NULL DEFAULT NULL,
  `end_time`       TIME NULL DEFAULT NULL,
  `timezone`       VARCHAR(50) NULL DEFAULT NULL,
  `location`       VARCHAR(255) NULL DEFAULT NULL,
  `is_virtual`     TINYINT NOT NULL DEFAULT 0,
  `meeting_url`    VARCHAR(500) NULL,
  `max_attendees`  INT NULL DEFAULT NULL,
  `organizer`         VARCHAR(255) NULL DEFAULT NULL,
  `agenda`            TEXT NULL DEFAULT NULL,
  `actual_attendance` INT NULL DEFAULT NULL,
  `is_active`      TINYINT NOT NULL DEFAULT 1,
  `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- invoice_item  (FK -> invoice, commission)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_item` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `invoice_id`            INT NOT NULL,
  `commission_id`         INT NOT NULL,
  `commission_tranche_id` INT NULL,
  `amount`                DECIMAL(12,2) NOT NULL,
  `created_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_invoice_item_invoice1_idx`    (`invoice_id` ASC) VISIBLE,
  INDEX `fk_invoice_item_commission1_idx` (`commission_id` ASC) VISIBLE,
  INDEX `fk_invoice_item_tranche_idx`     (`commission_tranche_id` ASC) VISIBLE,
  -- One invoice line per tranche (pay-as-collected); a commission can be invoiced
  -- once per tranche. NULL tranche = legacy single-invoice rows.
  UNIQUE INDEX `uq_invoice_item_tranche`  (`commission_tranche_id` ASC) VISIBLE,
  CONSTRAINT `fk_invoice_item_invoice`
    FOREIGN KEY (`invoice_id`) REFERENCES `invoice` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_invoice_item_commission`
    FOREIGN KEY (`commission_id`) REFERENCES `commission` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_invoice_item_tranche`
    FOREIGN KEY (`commission_tranche_id`) REFERENCES `commission_tranche` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- event_registration  (FK -> event, user)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `event_registration` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `event_id`      INT NOT NULL,
  `user_id`       INT NOT NULL,
  `num_attendees` TINYINT(5) UNSIGNED NOT NULL DEFAULT 0,
  `status`        TINYINT(3) UNSIGNED NOT NULL DEFAULT 0,
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_event_registration_event1_idx` (`event_id` ASC) VISIBLE,
  INDEX `fk_event_registration_user1_idx`  (`user_id`  ASC) VISIBLE,
  CONSTRAINT `fk_event_registration_event`
    FOREIGN KEY (`event_id`) REFERENCES `event` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_event_registration_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- event_reminder  (FK -> event_registration)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `event_reminder` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `event_registration_id` INT NOT NULL,
  `reminder_type`         TINYINT(5) UNSIGNED NOT NULL,
  `via_email`             TINYINT NOT NULL DEFAULT 1,
  `via_whatsapp`          TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  INDEX `fk_event_reminder_event_registration1_idx` (`event_registration_id` ASC) VISIBLE,
  CONSTRAINT `fk_event_reminder_event_registration`
    FOREIGN KEY (`event_registration_id`) REFERENCES `event_registration` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- notification_preference  (FK -> user)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `notification_preference` (
  `id`                INT NOT NULL AUTO_INCREMENT,
  `user_id`           INT NOT NULL,
  `notification_type` TINYINT(5) UNSIGNED NOT NULL,
  `via_email`         TINYINT NOT NULL DEFAULT 1,
  `via_sms`           TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  INDEX `fk_notification_preference_user1_idx` (`user_id` ASC) VISIBLE,
  CONSTRAINT `fk_notification_preference_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- audit_log  (FK -> organization, user)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `audit_log` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `org_id`      INT NULL DEFAULT NULL,
  `user_id`     INT NULL DEFAULT NULL,
  `action`      VARCHAR(100) NOT NULL,
  `entity_type` VARCHAR(50) NULL DEFAULT NULL,
  `entity_id`   INT NULL DEFAULT NULL,
  `metadata`    JSON NULL DEFAULT NULL,
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_audit_log_organization1_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_audit_log_user1_idx`         (`user_id` ASC) VISIBLE,
  CONSTRAINT `fk_audit_log_organization1`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT `fk_audit_log_user1`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- uni_assist_template  (FK -> collegepond_user)
-- Saved Uni Assist filter sets, shared team-wide.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `uni_assist_template` (
  `id`                  INT NOT NULL AUTO_INCREMENT,
  `name`                VARCHAR(100) NOT NULL,
  `filters`             JSON NOT NULL,
  `collegepond_user_id` INT NOT NULL,
  `created_at`          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_uni_assist_template_cp_user_idx` (`collegepond_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_uni_assist_template_cp_user`
    FOREIGN KEY (`collegepond_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- student_note  (FK -> student, collegepond_user)
-- Tasks & Notes tab: is_task 0 = note, 1 = task (due
-- date / priority / done). Converting flips is_task.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `student_note` (
  `id`                  INT NOT NULL AUTO_INCREMENT,
  `student_id`          INT NOT NULL,
  `body`                VARCHAR(1000) NOT NULL,
  `is_task`             TINYINT NOT NULL DEFAULT 0,
  `due_date`            DATE NULL DEFAULT NULL,
  `priority`            TINYINT UNSIGNED NULL DEFAULT NULL,  -- 0 Low, 1 Medium, 2 High
  `is_done`             TINYINT NOT NULL DEFAULT 0,
  `created_at`          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `collegepond_user_id` INT NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_note_student_idx` (`student_id` ASC) VISIBLE,
  INDEX `fk_note_cp_user_idx` (`collegepond_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_note_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_note_cp_user`
    FOREIGN KEY (`collegepond_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- student_emergency_contact  (FK -> student)
-- relationship: 0 Parent, 1 Sibling, 2 Spouse, 3 Friend, 4 Other
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `student_emergency_contact` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `student_id`   INT NOT NULL,
  `relationship` TINYINT UNSIGNED NOT NULL,
  `name`         VARCHAR(100) NOT NULL,
  `email`        VARCHAR(255) NULL DEFAULT NULL,
  `phone`        VARCHAR(45)  NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_emergency_contact_student_idx` (`student_id` ASC) VISIBLE,
  CONSTRAINT `fk_emergency_contact_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- student_education  (FK -> student)
-- One row per education level (0 10th … 4 PhD).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `student_education` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `student_id`      INT NOT NULL,
  `level`           TINYINT UNSIGNED NOT NULL,
  `country`         VARCHAR(50)  NULL DEFAULT NULL,
  `board`           VARCHAR(100) NULL DEFAULT NULL,
  `state`           VARCHAR(50)  NULL DEFAULT NULL,
  `qualification`   VARCHAR(100) NULL DEFAULT NULL,
  `institution`     VARCHAR(150) NULL DEFAULT NULL,
  `city`            VARCHAR(100) NULL DEFAULT NULL,
  `grading_system`  VARCHAR(20)  NULL DEFAULT NULL,
  `scale`           VARCHAR(50)  NULL DEFAULT NULL,
  `score`           VARCHAR(20)  NULL DEFAULT NULL,
  `language`        VARCHAR(30)  NULL DEFAULT NULL,
  `pass_month`      TINYINT UNSIGNED NULL DEFAULT NULL,
  `pass_year`       SMALLINT UNSIGNED NULL DEFAULT NULL,
  `major`           VARCHAR(100) NULL DEFAULT NULL,
  `research_topic`  VARCHAR(255) NULL DEFAULT NULL,
  `predicted_score` VARCHAR(20)  NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_education_student_level` (`student_id` ASC, `level` ASC) VISIBLE,
  CONSTRAINT `fk_education_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- student_work_experience  (FK -> student)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `student_work_experience` (
  `id`                INT NOT NULL AUTO_INCREMENT,
  `student_id`        INT NOT NULL,
  `company`           VARCHAR(150) NOT NULL,
  `job_title`         VARCHAR(100) NULL DEFAULT NULL,
  `employment_type`   VARCHAR(20)  NULL DEFAULT NULL,
  `industry`          VARCHAR(50)  NULL DEFAULT NULL,
  `start_month`       TINYINT UNSIGNED NOT NULL,
  `start_year`        SMALLINT UNSIGNED NOT NULL,
  `end_month`         TINYINT UNSIGNED NULL DEFAULT NULL,
  `end_year`          SMALLINT UNSIGNED NULL DEFAULT NULL,
  `currently_working` TINYINT NOT NULL DEFAULT 0,
  `city`              VARCHAR(100) NULL DEFAULT NULL,
  `country`           VARCHAR(50)  NULL DEFAULT NULL,
  `description`       VARCHAR(1000) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_work_experience_student_idx` (`student_id` ASC) VISIBLE,
  CONSTRAINT `fk_work_experience_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- student_test_score  (FK -> student)
-- One row per attempt; `scores` holds the test's field
-- map (e.g. {"verbal":165,"quant":168,"total":333}).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `student_test_score` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `student_id` INT NOT NULL,
  `test`       VARCHAR(20) NOT NULL,
  `attempt`    TINYINT UNSIGNED NOT NULL,
  `scores`     JSON NOT NULL,
  `test_date`  DATE NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_test_score_student_test_attempt` (`student_id` ASC, `test` ASC, `attempt` ASC) VISIBLE,
  CONSTRAINT `fk_test_score_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- application_portal_credential  (FK -> application)
-- University-portal login per application. password_enc
-- is AES-256-GCM ciphertext (src/server/crypto.ts).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `application_portal_credential` (
  `id`             INT NOT NULL AUTO_INCREMENT,
  `application_id` INT NOT NULL,
  `username`       VARCHAR(255) NOT NULL,
  `password_enc`   VARCHAR(1024) NOT NULL,
  `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_portal_credential_application` (`application_id` ASC) VISIBLE,
  CONSTRAINT `fk_portal_credential_application`
    FOREIGN KEY (`application_id`) REFERENCES `application` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- application_stage_history  (FK -> application)
-- One row per happy-path stage (0-7) an application has
-- reached; powers stepper dates and keeps the stage
-- position when status holds a terminal outcome (>= 20).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `application_stage_history` (
  `id`             INT NOT NULL AUTO_INCREMENT,
  `application_id` INT NOT NULL,
  `stage`          TINYINT UNSIGNED NOT NULL,
  `occurred_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_stage_history_app_stage` (`application_id` ASC, `stage` ASC) VISIBLE,
  CONSTRAINT `fk_stage_history_application`
    FOREIGN KEY (`application_id`) REFERENCES `application` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- shortlist  (FK -> student, course, collegepond_user)
-- Uni Assist shortlists; precursor to an application.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `shortlist` (
  `id`                  INT NOT NULL AUTO_INCREMENT,
  `student_id`          INT NOT NULL,
  `course_id`           INT NOT NULL,
  `collegepond_user_id` INT NULL DEFAULT NULL,
  `created_at`          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_shortlist_student_course` (`student_id` ASC, `course_id` ASC) VISIBLE,
  INDEX `fk_shortlist_course_idx` (`course_id` ASC) VISIBLE,
  INDEX `fk_shortlist_cp_user_idx` (`collegepond_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_shortlist_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_shortlist_course`
    FOREIGN KEY (`course_id`) REFERENCES `course` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_shortlist_cp_user`
    FOREIGN KEY (`collegepond_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- otp_code  (email OTP store; phone OTPs are managed by MSG91 server-side)
-- One row per email identifier: replaced on resend, deleted on success /
-- expiry / after MAX attempts. Codes are stored hashed; powers the verify
-- attempt cap that blocks 5-digit brute force.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `otp_code` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `identifier` VARCHAR(255) NOT NULL,
  `code_hash`  VARCHAR(64)  NOT NULL,
  `expires_at` TIMESTAMP NOT NULL,
  `attempts`   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_otp_identifier` (`identifier` ASC) VISIBLE
) ENGINE = InnoDB;


-- =====================================================
-- Finance / Commission module
-- One spine (commission) with an inbound leg (CP bills the vendor) and an
-- outbound leg (partner bills CP). Status codes: src/server/db/enums.ts.
-- =====================================================

-- -----------------------------------------------------
-- vendor  (direct university contract OR third-party aggregator)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `vendor` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(150) NOT NULL,
  `type`          TINYINT(3) UNSIGNED NOT NULL,
  `contact_name`  VARCHAR(100) NULL DEFAULT NULL,
  `contact_email` VARCHAR(255) NULL DEFAULT NULL,
  `contact_phone` VARCHAR(45)  NULL DEFAULT NULL,
  `address`       VARCHAR(255) NULL DEFAULT NULL,
  `is_active`     TINYINT NOT NULL DEFAULT 1,
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- commission_contract  (FK -> university, vendor)
-- vendor_id NULL = direct university contract. One is_default per university.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `commission_contract` (
  `id`             INT NOT NULL AUTO_INCREMENT,
  `university_id`  INT NOT NULL,
  `vendor_id`      INT NULL DEFAULT NULL,
  `cp_share_pct`   DECIMAL(5,2) NULL DEFAULT NULL,
  `is_default`     TINYINT NOT NULL DEFAULT 0,
  `effective_date` DATE NULL DEFAULT NULL,
  `notes`          VARCHAR(500) NULL DEFAULT NULL,
  `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_contract_university_vendor` (`university_id` ASC, `vendor_id` ASC) VISIBLE,
  INDEX `fk_commission_contract_university_idx` (`university_id` ASC) VISIBLE,
  INDEX `fk_commission_contract_vendor_idx`     (`vendor_id` ASC) VISIBLE,
  CONSTRAINT `fk_commission_contract_university`
    FOREIGN KEY (`university_id`) REFERENCES `university` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_commission_contract_vendor`
    FOREIGN KEY (`vendor_id`) REFERENCES `vendor` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- commission_rate  (FK -> commission_contract, course)
-- course_id NULL = university-wide rate for the contract.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `commission_rate` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `contract_id`     INT NOT NULL,
  `course_id`       INT NULL DEFAULT NULL,
  `level`           TINYINT(3) UNSIGNED NULL DEFAULT NULL,
  `commission_type` TINYINT(3) UNSIGNED NOT NULL DEFAULT 0,
  `rate`            DECIMAL(12,2) NOT NULL,
  `currency`        CHAR(3) NULL DEFAULT NULL,
  `created_at`      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_rate_contract_course` (`contract_id` ASC, `course_id` ASC) VISIBLE,
  INDEX `fk_commission_rate_contract_idx` (`contract_id` ASC) VISIBLE,
  INDEX `fk_commission_rate_course_idx`   (`course_id` ASC) VISIBLE,
  CONSTRAINT `fk_commission_rate_contract`
    FOREIGN KEY (`contract_id`) REFERENCES `commission_contract` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_commission_rate_course`
    FOREIGN KEY (`course_id`) REFERENCES `course` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- commission_bonus_tier  (FK -> commission_contract; direct deals)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `commission_bonus_tier` (
  `id`                 INT NOT NULL AUTO_INCREMENT,
  `contract_id`        INT NOT NULL,
  `min_students`       SMALLINT UNSIGNED NOT NULL,
  `max_students`       SMALLINT UNSIGNED NULL DEFAULT NULL,
  `amount_per_student` DECIMAL(12,2) NOT NULL,
  `currency`           CHAR(3) NULL DEFAULT NULL,
  `created_at`         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_bonus_tier_contract_idx` (`contract_id` ASC) VISIBLE,
  CONSTRAINT `fk_bonus_tier_contract`
    FOREIGN KEY (`contract_id`) REFERENCES `commission_contract` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- commission_tranche_template  (FK -> commission_contract; max 4)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `commission_tranche_template` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `contract_id` INT NOT NULL,
  `seq`         TINYINT(3) UNSIGNED NOT NULL,
  `name`        VARCHAR(100) NOT NULL,
  `amount`      DECIMAL(12,2) NULL DEFAULT NULL,
  `pct`         DECIMAL(5,2)  NULL DEFAULT NULL,
  `timing`      VARCHAR(150) NULL DEFAULT NULL,
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_tranche_template_contract_seq` (`contract_id` ASC, `seq` ASC) VISIBLE,
  INDEX `fk_tranche_template_contract_idx` (`contract_id` ASC) VISIBLE,
  CONSTRAINT `fk_tranche_template_contract`
    FOREIGN KEY (`contract_id`) REFERENCES `commission_contract` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- commission_tranche  (FK -> commission; per-application instances)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `commission_tranche` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `commission_id` INT NOT NULL,
  `seq`           TINYINT(3) UNSIGNED NOT NULL,
  `name`          VARCHAR(100) NULL DEFAULT NULL,
  `amount`        DECIMAL(12,2) NULL DEFAULT NULL,
  `amount_inr`    DECIMAL(14,2) NULL DEFAULT NULL,
  `status`        TINYINT(3) UNSIGNED NOT NULL DEFAULT 0,
  `received_at`   TIMESTAMP NULL DEFAULT NULL,
  `disbursed_at`  TIMESTAMP NULL DEFAULT NULL,
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_commission_tranche_seq` (`commission_id` ASC, `seq` ASC) VISIBLE,
  INDEX `fk_commission_tranche_commission_idx` (`commission_id` ASC) VISIBLE,
  CONSTRAINT `fk_commission_tranche_commission`
    FOREIGN KEY (`commission_id`) REFERENCES `commission` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- vendor_invoice  (INBOUND: CP bills vendor; FK -> vendor, university)
-- created_by_cp_user_id is a loose audit ref (no FK).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `vendor_invoice` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `invoice_number`        VARCHAR(40) NOT NULL,
  `vendor_id`             INT NULL DEFAULT NULL,
  `university_id`         INT NULL DEFAULT NULL,
  `currency`              CHAR(3) NOT NULL,
  `invoice_date`          DATE NOT NULL,
  `due_date`              DATE NULL DEFAULT NULL,
  `status`                TINYINT(3) UNSIGNED NOT NULL DEFAULT 0,
  `total_expected_amount` DECIMAL(14,2) NOT NULL,
  `notes`                 VARCHAR(1000) NULL DEFAULT NULL,
  `fy`                    SMALLINT NULL DEFAULT NULL,
  `created_by_cp_user_id` INT NULL DEFAULT NULL,
  `created_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_vendor_invoice_number` (`invoice_number` ASC) VISIBLE,
  INDEX `fk_vendor_invoice_vendor_idx`     (`vendor_id` ASC) VISIBLE,
  INDEX `fk_vendor_invoice_university_idx` (`university_id` ASC) VISIBLE,
  INDEX `idx_vendor_invoice_status`        (`status` ASC) VISIBLE,
  CONSTRAINT `fk_vendor_invoice_vendor`
    FOREIGN KEY (`vendor_id`) REFERENCES `vendor` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_vendor_invoice_university`
    FOREIGN KEY (`university_id`) REFERENCES `university` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- vendor_invoice_item  (FK -> vendor_invoice, commission)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `vendor_invoice_item` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `vendor_invoice_id`     INT NOT NULL,
  `commission_id`         INT NOT NULL,
  `tuition_amount`        DECIMAL(12,2) NOT NULL,
  `calculated_commission` DECIMAL(12,2) NOT NULL,
  `expected_amount`       DECIMAL(12,2) NOT NULL,
  `variance`              DECIMAL(12,2) NOT NULL DEFAULT 0,
  `variance_reason`       TINYINT(3) UNSIGNED NOT NULL DEFAULT 0,
  `variance_note`         VARCHAR(255) NULL DEFAULT NULL,
  `created_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_vendor_invoice_item_commission` (`commission_id` ASC) VISIBLE,
  INDEX `fk_vendor_invoice_item_invoice_idx` (`vendor_invoice_id` ASC) VISIBLE,
  CONSTRAINT `fk_vendor_invoice_item_invoice`
    FOREIGN KEY (`vendor_invoice_id`) REFERENCES `vendor_invoice` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_vendor_invoice_item_commission`
    FOREIGN KEY (`commission_id`) REFERENCES `commission` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- vendor_payment  (FX receipt; FK -> vendor_invoice)
-- amount_inr is the source of truth (actual rupees deposited).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `vendor_payment` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `vendor_invoice_id`     INT NOT NULL,
  `amount_inr`            DECIMAL(14,2) NOT NULL,
  `exchange_rate`         DECIMAL(12,4) NOT NULL,
  `amount_foreign`        DECIMAL(14,2) NOT NULL,
  `payment_date`          DATE NOT NULL,
  `payment_reference`     VARCHAR(100) NULL DEFAULT NULL,
  `is_tranche`            TINYINT NOT NULL DEFAULT 0,
  `tranche_number`        TINYINT(3) UNSIGNED NULL DEFAULT NULL,
  `total_tranches`        TINYINT(3) UNSIGNED NULL DEFAULT NULL,
  `is_final`              TINYINT NOT NULL DEFAULT 0,
  `notes`                 VARCHAR(255) NULL DEFAULT NULL,
  `fy`                    SMALLINT NULL DEFAULT NULL,
  `created_by_cp_user_id` INT NULL DEFAULT NULL,
  `created_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_vendor_payment_invoice_idx` (`vendor_invoice_id` ASC) VISIBLE,
  CONSTRAINT `fk_vendor_payment_invoice`
    FOREIGN KEY (`vendor_invoice_id`) REFERENCES `vendor_invoice` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- partner_bank_account  (OUTBOUND vault; FK -> organization)
-- Raw a/c ideally at the payouts provider; gstin_enc/pan_enc are AES-256-GCM.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `partner_bank_account` (
  `id`                       INT NOT NULL AUTO_INCREMENT,
  `org_id`                   INT NOT NULL,
  `account_holder`           VARCHAR(150) NOT NULL,
  `account_number_enc`       VARCHAR(1024) NULL DEFAULT NULL,
  `account_number_last4`     CHAR(4) NULL DEFAULT NULL,
  `ifsc`                     VARCHAR(15) NULL DEFAULT NULL,
  `swift`                    VARCHAR(15) NULL DEFAULT NULL,
  `bank_name`                VARCHAR(150) NULL DEFAULT NULL,
  `branch`                   VARCHAR(150) NULL DEFAULT NULL,
  `account_type`             VARCHAR(30) NULL DEFAULT NULL,
  `gstin_enc`                VARCHAR(512) NULL DEFAULT NULL,
  `pan_enc`                  VARCHAR(512) NULL DEFAULT NULL,
  `provider_fund_account_id` VARCHAR(100) NULL DEFAULT NULL,
  `provider_contact_id`      VARCHAR(100) NULL DEFAULT NULL,
  `is_verified`              TINYINT NOT NULL DEFAULT 0,
  `verified_at`              TIMESTAMP NULL DEFAULT NULL,
  `created_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_partner_bank_account_org_idx` (`org_id` ASC) VISIBLE,
  CONSTRAINT `fk_partner_bank_account_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- partner_payout  (reconciliation/release; FK -> invoice, partner_bank_account)
-- *_by_cp_user_id are loose audit refs (no FK).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `partner_payout` (
  `id`                         INT NOT NULL AUTO_INCREMENT,
  `invoice_id`                 INT NOT NULL,
  `bank_account_id`            INT NULL DEFAULT NULL,
  `amount_inr`                 DECIMAL(14,2) NOT NULL,
  `status`                     TINYINT(3) UNSIGNED NOT NULL DEFAULT 0,
  `ops_approved_by_cp_user_id` INT NULL DEFAULT NULL,
  `ops_approved_at`            TIMESTAMP NULL DEFAULT NULL,
  `verify_bank_confirmed`      TINYINT NOT NULL DEFAULT 0,
  `verify_invoice_verified`    TINYINT NOT NULL DEFAULT 0,
  `verify_commission_verified` TINYINT NOT NULL DEFAULT 0,
  `verify_duplicate_check`     TINYINT NOT NULL DEFAULT 0,
  `verified_by_cp_user_id`     INT NULL DEFAULT NULL,
  `verified_at`                TIMESTAMP NULL DEFAULT NULL,
  `method`                     TINYINT(3) UNSIGNED NULL DEFAULT NULL,
  `bank_name`                  VARCHAR(150) NULL DEFAULT NULL,
  `account_number_last4`       CHAR(4) NULL DEFAULT NULL,
  `ifsc`                       VARCHAR(15) NULL DEFAULT NULL,
  `swift`                      VARCHAR(15) NULL DEFAULT NULL,
  `reference_number`           VARCHAR(100) NULL DEFAULT NULL,
  `provider_payout_id`         VARCHAR(100) NULL DEFAULT NULL,
  `utr`                        VARCHAR(50) NULL DEFAULT NULL,
  `provider_status`            VARCHAR(30) NULL DEFAULT NULL,
  `payment_date`               DATE NULL DEFAULT NULL,
  `notes`                      VARCHAR(500) NULL DEFAULT NULL,
  `released_by_cp_user_id`     INT NULL DEFAULT NULL,
  `released_at`                TIMESTAMP NULL DEFAULT NULL,
  `hold_reason`                VARCHAR(500) NULL DEFAULT NULL,
  `sent_back_reason`           VARCHAR(500) NULL DEFAULT NULL,
  `fy`                         SMALLINT NULL DEFAULT NULL,
  `created_at`                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_partner_payout_invoice` (`invoice_id` ASC) VISIBLE,
  INDEX `fk_partner_payout_bank_account_idx` (`bank_account_id` ASC) VISIBLE,
  INDEX `idx_partner_payout_status` (`status` ASC) VISIBLE,
  CONSTRAINT `fk_partner_payout_invoice`
    FOREIGN KEY (`invoice_id`) REFERENCES `invoice` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_partner_payout_bank_account`
    FOREIGN KEY (`bank_account_id`) REFERENCES `partner_bank_account` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- schema_migrations  (tracks applied delta files — see scripts/db-apply.sh)
-- Present in the canonical schema so fresh DBs and diffs both include it.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `version`    VARCHAR(255) NOT NULL,
  `applied_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`version`)
) ENGINE = InnoDB;

-- -----------------------------------------------------
-- fx_rate  (live, editable exchange rates for INR estimate conversion)
-- mid_rate = mid-market (INR per 1 unit), refreshed from a feed; effective rate
-- (computed in app) = manual_rate ?? mid_rate * (1 - margin_pct/100). INR is the base.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `fx_rate` (
  `currency`    VARCHAR(3)    NOT NULL,
  `mid_rate`    DECIMAL(12,4) NOT NULL,
  `margin_pct`  DECIMAL(6,3)  NOT NULL DEFAULT 0,
  `manual_rate` DECIMAL(12,4) NULL,
  `source`      VARCHAR(50)   NULL,
  `fetched_at`  TIMESTAMP     NULL,
  `updated_at`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`currency`)
) ENGINE = InnoDB;


-- System-wide settings (company/general + notification toggles), key → JSON
-- value. Super-admin edits via the Settings page; replaces the old
-- localStorage-only persistence.
CREATE TABLE IF NOT EXISTS `system_config` (
  `config_key` VARCHAR(64) NOT NULL,
  `value`      TEXT        NOT NULL,
  `updated_at` TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`config_key`)
) ENGINE = InnoDB;


-- Persistent in-app notification feed (partner-facing). Written on discrete
-- events (e.g. a counsellor approval decision); read via the partner bell.
-- unread = read_at IS NULL. `tone` mirrors the bell dot colours.
CREATE TABLE IF NOT EXISTS `notification` (
  `id`         INT           NOT NULL AUTO_INCREMENT,
  `user_id`    INT           NOT NULL,
  `type`       VARCHAR(50)   NOT NULL,
  `title`      VARCHAR(255)  NOT NULL,
  `body`       VARCHAR(500)  NULL DEFAULT NULL,
  `link`       VARCHAR(255)  NULL DEFAULT NULL,
  `tone`       VARCHAR(10)   NOT NULL DEFAULT 'blue',
  `read_at`    TIMESTAMP     NULL DEFAULT NULL,
  `created_at` TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_notification_user_created` (`user_id` ASC, `created_at` ASC) VISIBLE,
  INDEX `idx_notification_user_read`    (`user_id` ASC, `read_at` ASC) VISIBLE,
  CONSTRAINT `fk_notification_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- WhatsApp messages (Periskope). One row per message in a student ↔ counsellor
-- thread. from_me = 1 (sent by CP) / 0 (received from student). Outgoing rows
-- store the provider's message id on send; the webhook dedups on it.
CREATE TABLE IF NOT EXISTS `whatsapp_message` (
  `id`                  INT           NOT NULL AUTO_INCREMENT,
  `student_id`          INT           NULL DEFAULT NULL,
  `chat_id`             VARCHAR(64)   NOT NULL,
  `provider_message_id` VARCHAR(100)  NULL DEFAULT NULL,
  `from_me`             TINYINT       NOT NULL DEFAULT 0,
  `body`                TEXT          NULL DEFAULT NULL,
  `message_type`        VARCHAR(30)   NULL DEFAULT NULL,
  `sent_by_cp_user_id`  INT           NULL DEFAULT NULL,
  `status`              VARCHAR(30)   NULL DEFAULT NULL,
  `provider_ts`         TIMESTAMP     NULL DEFAULT NULL,
  `created_at`          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_whatsapp_message_provider` (`provider_message_id` ASC) VISIBLE,
  INDEX `idx_whatsapp_message_student` (`student_id` ASC, `created_at` ASC) VISIBLE,
  INDEX `idx_whatsapp_message_chat` (`chat_id` ASC) VISIBLE,
  CONSTRAINT `fk_whatsapp_message_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;


-- =====================================================
-- BDM CRM  (prospects, activities, tasks)
-- -----------------------------------------------------
-- Backs the Prospect Pipeline, Activity Log and My Tasks sections of the BDM
-- Performance page (cp-bdm-performance.html mock). Until these existed, those
-- sections were removed from the page rather than shipped on synthetic data.
--
-- Activities and tasks attach to EITHER a partner (organization) OR a prospect,
-- never both and never neither, enforced by a CHECK on each table. Two nullable
-- FKs rather than a polymorphic type+id pair, so referential integrity holds.
--
-- Enum codes are mirrored in src/server/db/enums.ts. Keep them in sync.
-- =====================================================


-- -----------------------------------------------------
-- bdm_prospect  (FK -> cp_user, organization)
-- An agency being courted before it becomes a partner. On onboarding the row
-- is kept and linked to the new organization via converted_org_id, so the
-- courtship history (activities, tasks, stage changes) survives.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `bdm_prospect` (
  `id`               INT              NOT NULL AUTO_INCREMENT,
  `agency_name`      VARCHAR(255)     NOT NULL,
  `contact_name`     VARCHAR(255)     NULL DEFAULT NULL,
  `email`            VARCHAR(255)     NULL DEFAULT NULL,
  `phone`            VARCHAR(20)      NULL DEFAULT NULL,
  `city`             VARCHAR(120)     NULL DEFAULT NULL,
  `source`           TINYINT UNSIGNED NOT NULL,            -- 0 Cold Call, 1 Inbound Inquiry, 2 Referral, 3 Event / Exhibition, 4 LinkedIn, 5 Other
  `stage`            TINYINT UNSIGNED NOT NULL DEFAULT 0,  -- 0 Lead, 1 Contacted, 2 Meeting Done, 3 Proposal Sent, 4 Negotiation, 5 Onboarding, 6 Converted, 7 Lost
  `temperature`      TINYINT UNSIGNED NULL DEFAULT NULL,   -- 0 Cold, 1 Lukewarm, 2 Warm, 3 Hot, 4 Signing Up
  `stage_changed_at` TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- drives "Days in Stage"
  `next_follow_up`   DATE             NULL DEFAULT NULL,
  `notes`            VARCHAR(1000)    NULL DEFAULT NULL,
  `bdm_id`           INT              NOT NULL,
  `converted_org_id` INT              NULL DEFAULT NULL,
  `created_at`       TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_bdm_prospect_bdm_stage` (`bdm_id` ASC, `stage` ASC) VISIBLE,
  INDEX `fk_bdm_prospect_org_idx` (`converted_org_id` ASC) VISIBLE,
  CONSTRAINT `fk_bdm_prospect_bdm`
    FOREIGN KEY (`bdm_id`) REFERENCES `cp_user` (`id`),
  CONSTRAINT `fk_bdm_prospect_org`
    FOREIGN KEY (`converted_org_id`) REFERENCES `organization` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- bdm_prospect_stage_history  (FK -> bdm_prospect, cp_user)
-- One row per stage change, with the note the "Advance Stage" modal collects.
-- Parallels application_stage_history, but records from/to and a note because
-- prospects can move backwards (e.g. Negotiation -> Lost -> Contacted).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `bdm_prospect_stage_history` (
  `id`          INT              NOT NULL AUTO_INCREMENT,
  `prospect_id` INT              NOT NULL,
  `from_stage`  TINYINT UNSIGNED NULL DEFAULT NULL,   -- NULL on creation
  `to_stage`    TINYINT UNSIGNED NOT NULL,
  `note`        VARCHAR(1000)    NULL DEFAULT NULL,
  `changed_by`  INT              NULL DEFAULT NULL,
  `changed_at`  TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_prospect_stage_history` (`prospect_id` ASC, `changed_at` ASC) VISIBLE,
  INDEX `fk_prospect_stage_history_user_idx` (`changed_by` ASC) VISIBLE,
  CONSTRAINT `fk_prospect_stage_history_prospect`
    FOREIGN KEY (`prospect_id`) REFERENCES `bdm_prospect` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_prospect_stage_history_user`
    FOREIGN KEY (`changed_by`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- bdm_activity  (FK -> cp_user, organization | bdm_prospect)
-- The Activity Log: calls, emails, meetings and notes against a partner or a
-- prospect.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `bdm_activity` (
  `id`              INT               NOT NULL AUTO_INCREMENT,
  `type`            TINYINT UNSIGNED  NOT NULL,   -- 0 Call, 1 Email, 2 Meeting, 3 Note
  `organization_id` INT               NULL DEFAULT NULL,
  `prospect_id`     INT               NULL DEFAULT NULL,
  `occurred_on`     DATE              NOT NULL,
  `duration_mins`   SMALLINT UNSIGNED NULL DEFAULT NULL,
  `summary`         VARCHAR(1000)     NOT NULL,
  `follow_up_date`  DATE              NULL DEFAULT NULL,
  `bdm_id`          INT               NOT NULL,
  `created_at`      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_bdm_activity_bdm_date` (`bdm_id` ASC, `occurred_on` ASC) VISIBLE,
  INDEX `fk_bdm_activity_org_idx` (`organization_id` ASC) VISIBLE,
  INDEX `fk_bdm_activity_prospect_idx` (`prospect_id` ASC) VISIBLE,
  CONSTRAINT `chk_bdm_activity_target`
    CHECK ((`organization_id` IS NULL) <> (`prospect_id` IS NULL)),
  CONSTRAINT `fk_bdm_activity_bdm`
    FOREIGN KEY (`bdm_id`) REFERENCES `cp_user` (`id`),
  CONSTRAINT `fk_bdm_activity_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organization` (`id`),
  CONSTRAINT `fk_bdm_activity_prospect`
    FOREIGN KEY (`prospect_id`) REFERENCES `bdm_prospect` (`id`)
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- bdm_task  (FK -> cp_user, organization | bdm_prospect)
-- "My Tasks" = tasks where assigned_to is the viewer. Open / Due Today /
-- Overdue are derived from due_date and is_done, not stored.
-- Rescheduling overwrites due_date; there is no reschedule history.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `bdm_task` (
  `id`              INT              NOT NULL AUTO_INCREMENT,
  `title`           VARCHAR(255)     NOT NULL,
  `description`     VARCHAR(1000)    NULL DEFAULT NULL,
  `organization_id` INT              NULL DEFAULT NULL,
  `prospect_id`     INT              NULL DEFAULT NULL,
  `due_date`        DATE             NOT NULL,
  `priority`        TINYINT UNSIGNED NOT NULL DEFAULT 1,  -- 0 Low, 1 Normal, 2 Urgent
  `category`        TINYINT UNSIGNED NOT NULL,            -- 0 Follow-up, 1 Meeting / Call, 2 Proposal / Document, 3 Onboarding, 4 Review / Check-in, 5 Other
  `is_done`         TINYINT          NOT NULL DEFAULT 0,
  `completed_at`    TIMESTAMP        NULL DEFAULT NULL,
  `assigned_to`     INT              NOT NULL,
  `created_by`      INT              NULL DEFAULT NULL,
  `created_at`      TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_bdm_task_assignee_due` (`assigned_to` ASC, `is_done` ASC, `due_date` ASC) VISIBLE,
  INDEX `fk_bdm_task_org_idx` (`organization_id` ASC) VISIBLE,
  INDEX `fk_bdm_task_prospect_idx` (`prospect_id` ASC) VISIBLE,
  INDEX `fk_bdm_task_creator_idx` (`created_by` ASC) VISIBLE,
  CONSTRAINT `chk_bdm_task_target`
    CHECK ((`organization_id` IS NULL) <> (`prospect_id` IS NULL)),
  CONSTRAINT `fk_bdm_task_assignee`
    FOREIGN KEY (`assigned_to`) REFERENCES `cp_user` (`id`),
  CONSTRAINT `fk_bdm_task_creator`
    FOREIGN KEY (`created_by`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_bdm_task_org`
    FOREIGN KEY (`organization_id`) REFERENCES `organization` (`id`),
  CONSTRAINT `fk_bdm_task_prospect`
    FOREIGN KEY (`prospect_id`) REFERENCES `bdm_prospect` (`id`)
) ENGINE = InnoDB;


SET SQL_MODE            = @OLD_SQL_MODE;
SET FOREIGN_KEY_CHECKS  = @OLD_FOREIGN_KEY_CHECKS;
SET UNIQUE_CHECKS       = @OLD_UNIQUE_CHECKS;
