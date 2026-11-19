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
--   type: 0 = agency, 1 = institution (school / college); OrganizationType
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
-- department  (master list for cp_user.department_id; Settings -> Departments)
-- Organisational only — access is decided by cp_user.role. Deactivate rather
-- than delete; a delete is blocked while any cp_user still points here.
-- -----------------------------------------------------
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


-- -----------------------------------------------------
-- cp_user  (internal staff accounts; carries role)
-- (renamed from collegepond_user)
-- `department` is the legacy free-text column, frozen since
-- 20261013120000_department_master and no longer written; department_id
-- replaces it. Drop it once that migration has been live without a rollback.
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
  `department_id` INT NULL DEFAULT NULL,
  `status`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `last_login_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `email_UNIQUE` (`email` ASC) VISIBLE,
  INDEX `fk_cp_user_department_idx` (`department_id` ASC) VISIBLE,
  CONSTRAINT `fk_cp_user_department`
    FOREIGN KEY (`department_id`) REFERENCES `department` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- counsellor_team  (one per Counsellor Lead: primary SPOC + Auto Assign)
-- counsellor_team_member  (counsellors reporting to a lead; one team each)
-- Settings -> Counselling Teams. See 20261014084901_counselling_teams.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `counsellor_team` (
  `id`                      INT       NOT NULL AUTO_INCREMENT,
  `lead_cp_user_id`         INT       NOT NULL,
  `primary_spoc_cp_user_id` INT       NULL DEFAULT NULL,
  `auto_assign`             TINYINT   NOT NULL DEFAULT 0,
  `created_at`              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_counsellor_team_lead` (`lead_cp_user_id` ASC) VISIBLE,
  INDEX `fk_counsellor_team_spoc_idx` (`primary_spoc_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_counsellor_team_lead`
    FOREIGN KEY (`lead_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_counsellor_team_spoc`
    FOREIGN KEY (`primary_spoc_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `counsellor_team_member` (
  `id`         INT       NOT NULL AUTO_INCREMENT,
  `team_id`    INT       NOT NULL,
  `cp_user_id` INT       NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_counsellor_team_member` (`cp_user_id` ASC) VISIBLE,
  INDEX `fk_counsellor_team_member_team_idx` (`team_id` ASC) VISIBLE,
  CONSTRAINT `fk_counsellor_team_member_team`
    FOREIGN KEY (`team_id`) REFERENCES `counsellor_team` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_counsellor_team_member_user`
    FOREIGN KEY (`cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- partner_tier  (Settings -> Partner Tiers; display data, edits apply now)
-- partner_tier_rule  (per-FY ladder: range + commission share. FY X uses the
--   rows of the latest fy <= X, so edits are written for the next FY)
-- partner_tier_override  (Super Admin floor for one partner; optional end date)
-- See 20261014091941_partner_tiers.
-- -----------------------------------------------------
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
  -- Personal PAN of an independent counsellor. An agency's PAN lives on
  -- organization.pan instead.
  `pan`                             VARCHAR(15)  NULL DEFAULT NULL,
  `approved_by_cp_user_id`          INT NULL DEFAULT NULL,
  `lead_counsellor_id`              INT NULL DEFAULT NULL,
  `counsellor_id`                   INT NULL DEFAULT NULL,
  `bdm_id`                          INT NULL DEFAULT NULL,
  `notes`                           VARCHAR(255) NULL DEFAULT NULL,
  `status_reason`                   VARCHAR(500) NULL DEFAULT NULL,
  `tier`                            TINYINT(3) UNSIGNED NOT NULL DEFAULT 0,
  `mou_signed_at`                   TIMESTAMP NULL DEFAULT NULL,
  -- The MOU signature, kept so the executed MOU can be downloaded.
  `mou_signature`                   MEDIUMTEXT   NULL DEFAULT NULL,  -- drawn: PNG data URL; typed: the typed name
  `mou_signature_kind`              TINYINT UNSIGNED NULL DEFAULT NULL,  -- 0 drawn, 1 typed
  `mou_signer_name`                 VARCHAR(101) NULL DEFAULT NULL,
  `mou_signed_ip`                   VARCHAR(45)  NULL DEFAULT NULL,
  `mou_version`                     VARCHAR(20)  NULL DEFAULT NULL,
  `mou_pdf_url`                     VARCHAR(500) NULL DEFAULT NULL,  -- frozen PDF rendered at signing
  `last_login_at`                   TIMESTAMP NULL DEFAULT NULL,
  -- Soft delete (counsellor removed by their agency); see migration 20261013103000.
  `deleted_at`                      TIMESTAMP NULL DEFAULT NULL,
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
  -- RESTRICT, not CASCADE: MySQL won't CHECK a column with a cascading key,
  -- and deleting an agency shouldn't silently delete its people.
  CONSTRAINT `fk_user_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Agency owner/counsellor ⇔ has an org; independent ⇔ none (admins exempt).
  CONSTRAINT `chk_user_partner_org`
    CHECK (`type` NOT IN (0, 1, 2) OR ((`type` = 2) = (`org_id` IS NULL))),
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
  -- A partner's upload for one application after Deposit Paid (deposit slip,
  -- visa documents, visa approved copy), verified by Collegepond: status
  -- 0 pending / 1 approved / 2 rejected, review_note on rejection.
  `application_id`         INT          NULL DEFAULT NULL,
  `review_note`            VARCHAR(255) NULL DEFAULT NULL,
  `reviewed_at`            TIMESTAMP    NULL DEFAULT NULL,
  `reviewed_by_cp_user_id` INT          NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_document_organization1_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_document_user1_idx`         (`user_id` ASC) VISIBLE,
  INDEX `fk_document_student_idx`       (`student_id` ASC) VISIBLE,
  INDEX `fk_document_application_idx`   (`application_id` ASC) VISIBLE,
  INDEX `fk_document_reviewed_by_idx`   (`reviewed_by_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_document_organization`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_document_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT `fk_document_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_document_application`
    FOREIGN KEY (`application_id`) REFERENCES `application` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_document_reviewed_by`
    FOREIGN KEY (`reviewed_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL
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
  `cp_auto_assigned_at` TIMESTAMP NULL DEFAULT NULL,    -- set when auto-assign chose cp_counsellor_id
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
  -- Manual Inactive (overall student status); NULL inactive_at = not set.
  `inactive_at`               TIMESTAMP    NULL DEFAULT NULL,
  `inactive_reason`           VARCHAR(20)  NULL DEFAULT NULL,  -- InactiveReason enum
  `inactive_note`             VARCHAR(255) NULL DEFAULT NULL,
  `inactive_by_cp_user_id`    INT          NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `student_email_UNIQUE`  (`email` ASC) VISIBLE,
  INDEX `fk_student_organization1_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_student_user1_idx`         (`counsellor_id` ASC) VISIBLE,
  INDEX `idx_student_status`           (`status` ASC) VISIBLE,
  INDEX `idx_student_cp_counsellor`    (`cp_counsellor_id` ASC) VISIBLE,
  INDEX `idx_student_created_by`       (`created_by_user_id` ASC) VISIBLE,
  INDEX `fk_student_inactive_by_idx`   (`inactive_by_cp_user_id` ASC) VISIBLE,
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
    ON DELETE SET NULL,
  CONSTRAINT `fk_student_inactive_by`
    FOREIGN KEY (`inactive_by_cp_user_id`) REFERENCES `cp_user` (`id`)
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
  `toefl`                         DECIMAL(5,2) UNSIGNED NULL DEFAULT NULL,  -- TOEFL iBT on the 0-120 scale
  `toefl_2026`                    DECIMAL(2,1) UNSIGNED NULL DEFAULT NULL,  -- TOEFL iBT on the 1-6 band scale (from Jan 2026)
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
  `min_entry_req`                 VARCHAR(2000) NULL DEFAULT NULL,  -- renamed from min_entry_requirements; full requirement text
  `min_entry_requirements_scale`  VARCHAR(20)   NULL DEFAULT NULL,
  `has_faster_tat`                TINYINT(1) NULL DEFAULT NULL,  -- legacy flag, kept in step with faster_tat
  `faster_tat`                    TINYINT UNSIGNED NULL DEFAULT NULL,  -- 1=Same day, 2=1-3 days, 3=Within 7 days, NULL=standard (src/lib/faster-tat.ts)
  `moi_accepted`                  TINYINT(1) NULL DEFAULT NULL,  -- MOI letter accepted instead of an English test: 1=yes, 0=no, NULL=unknown (src/lib/moi.ts)
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
  -- NULL for an independent counsellor's student (same as student.org_id);
  -- the student's created_by_user_id says whose it is.
  `org_id`             INT NULL DEFAULT NULL,
  `offer_letter_url`   VARCHAR(255) NULL DEFAULT NULL,
  `program_start_date` DATE NULL DEFAULT NULL,
  `university_app_id`  VARCHAR(100) NULL DEFAULT NULL,
  `counsellor_vendor`  VARCHAR(100) NULL DEFAULT NULL,
  `conditional_docs`   JSON NULL DEFAULT NULL,
  `pending_docs`       JSON NULL DEFAULT NULL,  -- [{key,label,receivedAt}] named at Documents Pending
  `deposit_deadline`   DATE NULL DEFAULT NULL,
  `deposit_amount`     DECIMAL(12,2) NULL DEFAULT NULL,
  `deposit_currency`   CHAR(3) NULL DEFAULT NULL,
  -- Counsellor's structured vendor pick (the university × vendor deal).
  `commission_contract_id` INT NULL DEFAULT NULL,
  -- Deferred to a later intake: the application stays open at its stage.
  `deferred_intake_month`  TINYINT UNSIGNED  NULL DEFAULT NULL,
  `deferred_intake_year`   SMALLINT UNSIGNED NULL DEFAULT NULL,
  `deferred_from_intake`   VARCHAR(40)       NULL DEFAULT NULL,
  `deferred_at`            TIMESTAMP         NULL DEFAULT NULL,
  `deferred_by_cp_user_id` INT               NULL DEFAULT NULL,
  `deferred_note`          VARCHAR(255)      NULL DEFAULT NULL,
  -- Why the university rejected it (RejectionReason code; note for "Other").
  `rejection_reason`       TINYINT UNSIGNED  NULL DEFAULT NULL,
  `rejection_note`         VARCHAR(500)      NULL DEFAULT NULL,
  -- Weeks the university is expected to take to decide, from submitted_at
  -- (application follow-ups). NULL = not set: 1 for a Faster TAT course, else 4.
  `decision_expected_weeks` TINYINT UNSIGNED NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_application_student1_idx`      (`student_id` ASC) VISIBLE,
  INDEX `idx_application_deferred`         (`deferred_at` ASC) VISIBLE,
  INDEX `fk_application_deferred_by_idx`   (`deferred_by_cp_user_id` ASC) VISIBLE,
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
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_application_deferred_by`
    FOREIGN KEY (`deferred_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- commission  (FK -> application, organization)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `commission` (
  `id`                       INT NOT NULL AUTO_INCREMENT,
  `tuition_fee`              DECIMAL(12,2) NOT NULL,
  `currency`                 CHAR(3) NOT NULL,
  -- The course currency the tuition is in. A FLAT deal is stamped in the
  -- contract currency (`currency`), which can differ. NULL = same as currency.
  `tuition_currency`         CHAR(3) NULL DEFAULT NULL,
  `commision_rate`           DECIMAL(5,2)  NOT NULL,
  `commision_amount`         DECIMAL(12,2) NOT NULL,
  `partner_paid_at`          TIMESTAMP NULL DEFAULT NULL,
  `created_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `application_id`           INT NOT NULL,
  -- Payee, stamped at billing confirmation: the agency (org_id) or the
  -- independent counsellor (payee_user_id) — exactly one (chk_commission_payee).
  `org_id`                   INT NULL DEFAULT NULL,
  `payee_user_id`            INT NULL DEFAULT NULL,
  `collegepond_received_at`  TIMESTAMP NULL DEFAULT NULL,
  -- Spine state = the two milestone timestamps (collegepond_received_at,
  -- partner_paid_at). The CommissionStatus badge is derived on read.
  `cp_share_pct`             DECIMAL(5,2)  NULL DEFAULT NULL,
  `partner_share_pct`        DECIMAL(5,2)  NULL DEFAULT NULL,
  -- Tier whose share was stamped at billing confirmation (snapshot).
  `partner_tier_id`          INT NULL DEFAULT NULL,
  `claimable_inr`            DECIMAL(14,2) NULL DEFAULT NULL,
  `received_fx_rate`         DECIMAL(12,4) NULL DEFAULT NULL,
  `vendor_id`                INT NULL DEFAULT NULL,
  -- Who approved the commission (University Billing > Approve commission) and
  -- when. Loose cp_user ref, like partner_payout.ops_approved_by_cp_user_id.
  `approved_by_cp_user_id`   INT NULL DEFAULT NULL,
  `approved_at`              TIMESTAMP NULL DEFAULT NULL,
  -- "YYYY-MM": the intake the student was counted in for volume bonuses.
  `bonus_intake`             CHAR(7) NULL DEFAULT NULL,
  -- Set when Finance edited the base at approval: what the rate gave, and why.
  `calculated_commission_amount` DECIMAL(12,2) NULL DEFAULT NULL,
  `commission_amount_reason` VARCHAR(500) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_commission_application1_idx`  (`application_id` ASC) VISIBLE,
  UNIQUE INDEX `application_id_UNIQUE`    (`application_id` ASC) VISIBLE,
  INDEX `fk_commission_organization1_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_commission_vendor_idx`        (`vendor_id` ASC) VISIBLE,
  INDEX `fk_commission_partner_tier_idx`  (`partner_tier_id` ASC) VISIBLE,
  INDEX `fk_commission_payee_user_idx`    (`payee_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_commission_application`
    FOREIGN KEY (`application_id`) REFERENCES `application` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- RESTRICT both ways: MySQL won't CHECK a column with a cascading key.
  CONSTRAINT `fk_commission_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_commission_payee_user`
    FOREIGN KEY (`payee_user_id`) REFERENCES `user` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_commission_payee`
    CHECK ((`org_id` IS NULL) <> (`payee_user_id` IS NULL)),
  CONSTRAINT `fk_commission_vendor`
    FOREIGN KEY (`vendor_id`) REFERENCES `vendor` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_commission_partner_tier`
    FOREIGN KEY (`partner_tier_id`) REFERENCES `partner_tier` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
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
  -- Currency the claim is paid out in (snapshot of the bank account's);
  -- amounts above stay INR. Non-INR: no GST, no TDS. NULL = INR.
  `payout_currency`       CHAR(3) NULL DEFAULT NULL,
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
  -- Supplier: the agency (org_id) or the independent counsellor
  -- (payee_user_id) — exactly one (chk_invoice_payee).
  `org_id`                INT NULL DEFAULT NULL,
  `payee_user_id`         INT NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_invoice_organization1_idx` (`org_id` ASC) VISIBLE,
  UNIQUE INDEX `invoice_number_UNIQUE` (`invoice_number` ASC) VISIBLE,
  INDEX `fk_invoice_bank_account_idx` (`bank_account_id` ASC) VISIBLE,
  INDEX `fk_invoice_payee_user_idx` (`payee_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_invoice_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_invoice_payee_user`
    FOREIGN KEY (`payee_user_id`) REFERENCES `user` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_invoice_payee`
    CHECK ((`org_id` IS NULL) <> (`payee_user_id` IS NULL)),
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
  -- Poster (JPG/PNG/PDF) and optional external registration form.
  `creative_url`      VARCHAR(500) NULL DEFAULT NULL,
  `registration_url`  VARCHAR(500) NULL DEFAULT NULL,
  -- 1 = all approved partners, 2 = selected (the invite list).
  `audience`          TINYINT UNSIGNED NOT NULL DEFAULT 1,
  -- Email + bell the audience on publish (event_share records who got it).
  `share_partners`    TINYINT NOT NULL DEFAULT 1,
  -- Calendar invite SEQUENCE, bumped on a date/time/place/link change.
  `ics_sequence`      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
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
-- event_share  (FK -> event, user)
-- One row per partner user sent an event's announcement (email + bell). The
-- unique key makes "never twice" hold; share_batch marks the rows one save
-- inserted, so only those are notified.
-- -----------------------------------------------------
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


-- -----------------------------------------------------
-- partner_banner  (FK -> event)
-- Rotating slides on the partner dashboard. kind 1 = EVENT (follows its
-- event: published, not past, the event's audience), 2 = INFORMATION (every
-- partner; opens a pop-up with `details`). Rotation interval: system_config
-- 'partner_banner.rotate_seconds'.
-- -----------------------------------------------------
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
  `via_in_app`        TINYINT NOT NULL DEFAULT 1,
  `via_sms`           TINYINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  INDEX `fk_notification_preference_user1_idx` (`user_id` ASC) VISIBLE,
  -- One row per partner per type (codes: src/lib/constants/notification-prefs.ts).
  UNIQUE INDEX `uq_notification_pref_user_type` (`user_id` ASC, `notification_type` ASC) VISIBLE,
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
-- application_partner_report  (FK -> application, document, user, cp_user)
-- A partner's report of Deposit Paid or a visa outcome, with the supporting
-- student document; pending until a Collegepond counsellor confirms it.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `application_partner_report` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `application_id`        INT NOT NULL,
  `from_status`           TINYINT UNSIGNED NOT NULL,  -- application.status when reported
  `target_status`         TINYINT UNSIGNED NOT NULL,  -- what the partner reports
  `document_id`           INT NULL DEFAULT NULL,      -- supporting file (student document)
  `note`                  VARCHAR(500) NULL DEFAULT NULL,
  `reported_by_user_id`   INT NULL DEFAULT NULL,
  `status`                TINYINT UNSIGNED NOT NULL DEFAULT 0,  -- 0 pending, 1 confirmed, 2 rejected
  `decided_by_cp_user_id` INT NULL DEFAULT NULL,
  `decided_at`            TIMESTAMP NULL DEFAULT NULL,
  `decision_note`         VARCHAR(500) NULL DEFAULT NULL,
  `created_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A reported deferral: the new intake.
  `deferred_intake_month` TINYINT UNSIGNED  NULL DEFAULT NULL,
  `deferred_intake_year`  SMALLINT UNSIGNED NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_apr_application_status` (`application_id` ASC, `status` ASC) VISIBLE,
  INDEX `fk_apr_document_idx` (`document_id` ASC) VISIBLE,
  INDEX `fk_apr_user_idx` (`reported_by_user_id` ASC) VISIBLE,
  INDEX `fk_apr_cp_user_idx` (`decided_by_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_apr_application`
    FOREIGN KEY (`application_id`) REFERENCES `application` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_apr_document`
    FOREIGN KEY (`document_id`) REFERENCES `document` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_apr_user`
    FOREIGN KEY (`reported_by_user_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_apr_cp_user`
    FOREIGN KEY (`decided_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- application_follow_up  (FK -> application)
-- Application follow-ups (src/server/follow-ups.ts), by kind: 'decision'
-- (Application Submitted / Under Review), 'deposit' (auto, 7 days before
-- application.deposit_deadline), 'visa' (weekly from the visa documentation
-- stage). Numbered per kind. Open until completed or auto-closed; never
-- deleted. The *_notified/emailed/reminded columns keep the daily cron
-- idempotent; ics_* track the calendar invite. cp_user ids are loose references.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `application_follow_up` (
  `id`                      INT               NOT NULL AUTO_INCREMENT,
  `application_id`          INT               NOT NULL,
  `kind`                    VARCHAR(10)       NOT NULL DEFAULT 'decision',  -- decision | deposit | visa
  `seq`                     SMALLINT UNSIGNED NOT NULL,  -- Follow-up 1, 2, 3 … per application and kind
  `due_date`                DATE              NOT NULL,
  `anchor_date`             DATE              NULL DEFAULT NULL,  -- deposit: the deadline it was made for
  `respond_within_days`     TINYINT UNSIGNED  NULL DEFAULT NULL,  -- visa: days the partner has to respond
  `remarks`                 VARCHAR(1000)     NULL DEFAULT NULL,
  `completed_at`            TIMESTAMP         NULL DEFAULT NULL,
  `completed_by_cp_user_id` INT               NULL DEFAULT NULL,
  `closed_at`               TIMESTAMP         NULL DEFAULT NULL,  -- auto-closed (offer or later, or closed)
  `closed_reason`           VARCHAR(100)      NULL DEFAULT NULL,
  `due_notified_at`         TIMESTAMP         NULL DEFAULT NULL,  -- due-day in-app + email sent
  `overdue_emailed_at`      TIMESTAMP         NULL DEFAULT NULL,  -- first overdue day in-app + email sent
  `overdue_reminded_on`     DATE              NULL DEFAULT NULL,  -- last daily overdue in-app reminder (IST date)
  `ics_sequence`            SMALLINT UNSIGNED NOT NULL DEFAULT 0,  -- calendar SEQUENCE, bumped on a date change
  `ics_sent_sequence`       SMALLINT UNSIGNED NULL DEFAULT NULL,   -- SEQUENCE last emailed as an invite
  `ics_sent_to`             VARCHAR(255)      NULL DEFAULT NULL,   -- address holding the invite
  `created_by_cp_user_id`   INT               NULL DEFAULT NULL,
  `created_at`              TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_follow_up_application_kind_seq` (`application_id` ASC, `kind` ASC, `seq` ASC) VISIBLE,
  INDEX `idx_follow_up_open_due` (`completed_at` ASC, `closed_at` ASC, `due_date` ASC) VISIBLE,
  CONSTRAINT `fk_follow_up_application`
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
  -- Who proposed it: 0 = Collegepond counsellor, 1 = partner (ShortlistSource).
  `added_by`              TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `added_by_user_id`      INT NULL DEFAULT NULL,
  -- The other side's decision: 0 pending, 1 approved, 2 rejected
  -- (ShortlistApproval). Apply is refused until approved.
  `approval_status`       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `proposed_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `proposal_note`         VARCHAR(500) NULL DEFAULT NULL,
  `decided_at`            TIMESTAMP NULL DEFAULT NULL,
  `decided_by_user_id`    INT NULL DEFAULT NULL,
  `decided_by_cp_user_id` INT NULL DEFAULT NULL,
  `reject_reason`         VARCHAR(500) NULL DEFAULT NULL,
  -- Collegepond's rejection reason (RejectionReason); reject_reason = note.
  `reject_reason_code`    TINYINT UNSIGNED NULL DEFAULT NULL,
  `created_at`          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_shortlist_student_course` (`student_id` ASC, `course_id` ASC) VISIBLE,
  INDEX `fk_shortlist_course_idx` (`course_id` ASC) VISIBLE,
  INDEX `fk_shortlist_cp_user_idx` (`collegepond_user_id` ASC) VISIBLE,
  INDEX `idx_shortlist_approval` (`approval_status` ASC) VISIBLE,
  INDEX `fk_shortlist_added_by_user_idx` (`added_by_user_id` ASC) VISIBLE,
  INDEX `fk_shortlist_decided_by_user_idx` (`decided_by_user_id` ASC) VISIBLE,
  INDEX `fk_shortlist_decided_by_cp_user_idx` (`decided_by_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_shortlist_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_shortlist_course`
    FOREIGN KEY (`course_id`) REFERENCES `course` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_shortlist_cp_user`
    FOREIGN KEY (`collegepond_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_shortlist_added_by_user`
    FOREIGN KEY (`added_by_user_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_shortlist_decided_by_user`
    FOREIGN KEY (`decided_by_user_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_shortlist_decided_by_cp_user`
    FOREIGN KEY (`decided_by_cp_user_id`) REFERENCES `cp_user` (`id`)
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
  -- The vendor agreement's currency; its contracts default to it.
  `currency`      CHAR(3)      NULL DEFAULT NULL,
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
  -- Contract currency: flat rates, fixed tranche amounts and bonus tiers are
  -- in it. NULL (rows before 20261030140000) = the course's currency.
  `currency`       CHAR(3)      NULL DEFAULT NULL,
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
-- tranche_condition  (Settings -> Tranche Conditions master; the
-- "Condition" dropdown on a tranche. Deactivate, don't delete, once used.)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `tranche_condition` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(150) NOT NULL,
  `sort_order` INT          NOT NULL DEFAULT 0,
  `is_active`  TINYINT      NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_tranche_condition_name` (`name` ASC) VISIBLE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- commission_tranche_template  (FK -> commission_contract; max 4)
-- condition_id -> tranche_condition; `timing` is a snapshot of that
-- condition's name (rewritten on rename), kept for every reader of it.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `commission_tranche_template` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `contract_id` INT NOT NULL,
  `seq`         TINYINT(3) UNSIGNED NOT NULL,
  `name`        VARCHAR(100) NOT NULL,
  `amount`      DECIMAL(12,2) NULL DEFAULT NULL,
  `pct`         DECIMAL(5,2)  NULL DEFAULT NULL,
  `condition_id` INT NULL DEFAULT NULL,
  `timing`      VARCHAR(150) NULL DEFAULT NULL,
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_tranche_template_contract_seq` (`contract_id` ASC, `seq` ASC) VISIBLE,
  INDEX `fk_tranche_template_contract_idx` (`contract_id` ASC) VISIBLE,
  INDEX `fk_tranche_template_condition_idx` (`condition_id` ASC) VISIBLE,
  CONSTRAINT `fk_tranche_template_contract`
    FOREIGN KEY (`contract_id`) REFERENCES `commission_contract` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_tranche_template_condition`
    FOREIGN KEY (`condition_id`) REFERENCES `tranche_condition` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- commission_tranche  (FK -> commission; per-application instances)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `commission_tranche` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `commission_id` INT NOT NULL,
  `seq`           TINYINT(3) UNSIGNED NOT NULL,
  -- 0 = base instalment, 1 = university volume bonus (vendor-billed, no
  -- partner share), 2 = CP-funded partner incentive (never vendor-billed).
  `kind`          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `name`          VARCHAR(100) NULL DEFAULT NULL,
  `amount`        DECIMAL(12,2) NULL DEFAULT NULL,
  `amount_inr`    DECIMAL(14,2) NULL DEFAULT NULL,
  -- The recorded collection covering this tranche (loose ref, no FK). Status
  -- 5 = collected, awaiting approval; approval makes it 3 (claimable).
  `vendor_payment_id` INT NULL DEFAULT NULL,
  `status`        TINYINT(3) UNSIGNED NOT NULL DEFAULT 0,
  `received_at`   TIMESTAMP NULL DEFAULT NULL,
  `disbursed_at`  TIMESTAMP NULL DEFAULT NULL,
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_commission_tranche_seq` (`commission_id` ASC, `seq` ASC) VISIBLE,
  INDEX `fk_commission_tranche_commission_idx` (`commission_id` ASC) VISIBLE,
  INDEX `idx_commission_tranche_vendor_payment` (`vendor_payment_id` ASC) VISIBLE,
  CONSTRAINT `fk_commission_tranche_commission`
    FOREIGN KEY (`commission_id`) REFERENCES `commission` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;

-- -----------------------------------------------------
-- Bonus schemes (20261116180000_bonus_schemes): kind 1 = university volume
-- bonus (income, per contract per intake), kind 2 = CP-funded partner
-- incentive. commission_bonus is the snapshot stamped on a commission.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS `bonus_scheme` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `kind`                  TINYINT UNSIGNED NOT NULL,
  `name`                  VARCHAR(150) NOT NULL,
  `currency`              CHAR(3) NOT NULL,
  -- Volume bonus: the commission approval date. Partner incentive: the date
  -- the student's application was submitted. NULL = open-ended.
  `active_from`           DATE NULL DEFAULT NULL,
  `active_to`             DATE NULL DEFAULT NULL,
  -- Volume bonus: the university contract (direct or vendor) it belongs to.
  `contract_id`           INT NULL DEFAULT NULL,
  -- Scope; NULL = any.
  `country`               VARCHAR(100) NULL DEFAULT NULL,
  `university_id`         INT NULL DEFAULT NULL,
  `intake_month`          TINYINT UNSIGNED NULL DEFAULT NULL,
  `intake_year`           SMALLINT UNSIGNED NULL DEFAULT NULL,
  -- Volume bonus only: 1 = once the threshold is reached every student
  -- counted in that intake earns it; 0 = only students from the threshold on.
  `retroactive`           TINYINT NOT NULL DEFAULT 0,
  `is_active`             TINYINT NOT NULL DEFAULT 1,
  `notes`                 VARCHAR(500) NULL DEFAULT NULL,
  -- Copied from commission_bonus_tier by this migration.
  `imported_from_tiers`   TINYINT NOT NULL DEFAULT 0,
  `created_by_cp_user_id` INT NULL DEFAULT NULL,
  `created_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_bonus_scheme_kind` (`kind` ASC, `is_active` ASC) VISIBLE,
  INDEX `fk_bonus_scheme_contract_idx` (`contract_id` ASC) VISIBLE,
  INDEX `fk_bonus_scheme_university_idx` (`university_id` ASC) VISIBLE,
  CONSTRAINT `fk_bonus_scheme_contract`
    FOREIGN KEY (`contract_id`) REFERENCES `commission_contract` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_bonus_scheme_university`
    FOREIGN KEY (`university_id`) REFERENCES `university` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `bonus_scheme_slab` (
  `id`                 INT NOT NULL AUTO_INCREMENT,
  `scheme_id`          INT NOT NULL,
  `min_students`       SMALLINT UNSIGNED NOT NULL,
  `max_students`       SMALLINT UNSIGNED NULL DEFAULT NULL,
  `amount_per_student` DECIMAL(12,2) NOT NULL,
  `created_at`         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_bonus_scheme_slab_scheme_idx` (`scheme_id` ASC) VISIBLE,
  CONSTRAINT `fk_bonus_scheme_slab_scheme`
    FOREIGN KEY (`scheme_id`) REFERENCES `bonus_scheme` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `commission_bonus` (
  `id`                    INT NOT NULL AUTO_INCREMENT,
  `commission_id`         INT NOT NULL,
  `kind`                  TINYINT UNSIGNED NOT NULL,
  `scheme_id`             INT NULL DEFAULT NULL,
  -- Snapshots, so the record reads the same if the scheme is later closed.
  `scheme_name`           VARCHAR(150) NULL DEFAULT NULL,
  `slab_min`              SMALLINT UNSIGNED NULL DEFAULT NULL,
  `slab_max`              SMALLINT UNSIGNED NULL DEFAULT NULL,
  -- The count (including this student) that reached the slab.
  `student_count`         SMALLINT UNSIGNED NULL DEFAULT NULL,
  `intake`                CHAR(7) NULL DEFAULT NULL,
  -- What the scheme gave; NULL when Finance added one no scheme matched.
  `calculated_amount`     DECIMAL(12,2) NULL DEFAULT NULL,
  `amount`                DECIMAL(12,2) NOT NULL,
  `currency`              CHAR(3) NOT NULL,
  `commission_tranche_id` INT NULL DEFAULT NULL,
  `is_manual`             TINYINT NOT NULL DEFAULT 0,
  `edit_reason`           VARCHAR(500) NULL DEFAULT NULL,
  -- 'approval' (stamped at Approve commission) or 'retroactive' (a volume
  -- bonus added when a later student reached the threshold).
  `via`                   VARCHAR(20) NOT NULL DEFAULT 'approval',
  `created_by_cp_user_id` INT NULL DEFAULT NULL,
  `created_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_commission_bonus_kind` (`commission_id` ASC, `kind` ASC) VISIBLE,
  UNIQUE INDEX `uq_commission_bonus_tranche` (`commission_tranche_id` ASC) VISIBLE,
  INDEX `fk_commission_bonus_scheme_idx` (`scheme_id` ASC) VISIBLE,
  CONSTRAINT `fk_commission_bonus_commission`
    FOREIGN KEY (`commission_id`) REFERENCES `commission` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_commission_bonus_scheme`
    FOREIGN KEY (`scheme_id`) REFERENCES `bonus_scheme` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_commission_bonus_tranche`
    FOREIGN KEY (`commission_tranche_id`) REFERENCES `commission_tranche` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
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
  -- Not unique: a commission can sit on several invoices, one per instalment
  -- (vendor_invoice_item_tranche). A line with no tranche rows bills the
  -- whole commission; createVendorInvoice keeps the two from overlapping.
  INDEX `fk_vendor_invoice_item_commission_idx` (`commission_id` ASC) VISIBLE,
  INDEX `fk_vendor_invoice_item_invoice_idx` (`vendor_invoice_id` ASC) VISIBLE,
  CONSTRAINT `fk_vendor_invoice_item_invoice`
    FOREIGN KEY (`vendor_invoice_id`) REFERENCES `vendor_invoice` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_vendor_invoice_item_commission`
    FOREIGN KEY (`commission_id`) REFERENCES `commission` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- vendor_invoice_item_tranche  (FK -> vendor_invoice_item, commission_tranche)
-- The instalments a vendor invoice line bills. An instalment is invoiced at
-- most once (UNIQUE commission_tranche_id). A line with no rows here bills
-- every tranche of its commission (lines made before 16 Nov 2026).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `vendor_invoice_item_tranche` (
  `id`                     INT NOT NULL AUTO_INCREMENT,
  `vendor_invoice_item_id` INT NOT NULL,
  `commission_tranche_id`  INT NOT NULL,
  `created_at`             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_vendor_invoice_item_tranche_tranche` (`commission_tranche_id` ASC) VISIBLE,
  INDEX `fk_vendor_invoice_item_tranche_item_idx` (`vendor_invoice_item_id` ASC) VISIBLE,
  CONSTRAINT `fk_vendor_invoice_item_tranche_item`
    FOREIGN KEY (`vendor_invoice_item_id`) REFERENCES `vendor_invoice_item` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_vendor_invoice_item_tranche_tranche`
    FOREIGN KEY (`commission_tranche_id`) REFERENCES `commission_tranche` (`id`)
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
  -- What the covered tranches were invoiced at (invoice currency).
  `amount_expected`       DECIMAL(14,2) NULL DEFAULT NULL,
  `payment_date`          DATE NOT NULL,
  `payment_reference`     VARCHAR(100) NULL DEFAULT NULL,
  `is_tranche`            TINYINT NOT NULL DEFAULT 0,
  `tranche_number`        TINYINT(3) UNSIGNED NULL DEFAULT NULL,
  `total_tranches`        TINYINT(3) UNSIGNED NULL DEFAULT NULL,
  `is_final`              TINYINT NOT NULL DEFAULT 0,
  `notes`                 VARCHAR(255) NULL DEFAULT NULL,
  `fy`                    SMALLINT NULL DEFAULT NULL,
  `created_by_cp_user_id` INT NULL DEFAULT NULL,
  -- Approve collection (Super Admin / Finance Manager); loose cp_user ref.
  `approved_by_cp_user_id` INT NULL DEFAULT NULL,
  `approved_at`           TIMESTAMP NULL DEFAULT NULL,
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
  -- Owner: the agency (org_id) or the independent counsellor
  -- (payee_user_id) — exactly one (chk_bank_account_payee).
  `org_id`                   INT NULL DEFAULT NULL,
  `payee_user_id`            INT NULL DEFAULT NULL,
  `region`                   TINYINT UNSIGNED NOT NULL DEFAULT 0,  -- 0 Domestic (IFSC), 1 International (SWIFT)
  -- Currency the partner is paid in: INR when domestic; picked when international.
  `payout_currency`          CHAR(3) NULL DEFAULT NULL,
  `account_holder`           VARCHAR(150) NOT NULL,
  `account_number_enc`       VARCHAR(1024) NULL DEFAULT NULL,
  `account_number_last4`     CHAR(4) NULL DEFAULT NULL,
  `ifsc`                     VARCHAR(15) NULL DEFAULT NULL,
  `swift`                    VARCHAR(15) NULL DEFAULT NULL,
  `iban`                     VARCHAR(34)  NULL DEFAULT NULL,
  `bank_name`                VARCHAR(150) NULL DEFAULT NULL,
  `branch`                   VARCHAR(150) NULL DEFAULT NULL,
  `bank_country`             CHAR(2)      NULL DEFAULT NULL,
  `bank_address`             VARCHAR(255) NULL DEFAULT NULL,
  `account_type`             VARCHAR(30) NULL DEFAULT NULL,
  `gstin_enc`                VARCHAR(512) NULL DEFAULT NULL,
  `pan_enc`                  VARCHAR(512) NULL DEFAULT NULL,
  -- Cancelled cheque (domestic) / bank letter (international); finance checks
  -- it by hand before marking the account verified. Payouts need verified.
  `proof_url`                VARCHAR(500) NULL DEFAULT NULL,
  `proof_file_name`          VARCHAR(255) NULL DEFAULT NULL,
  -- When the partner last saved these details; orders the Bank Verifications
  -- queue, and a verify/reject only applies if it's unchanged.
  `submitted_at`             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `provider_fund_account_id` VARCHAR(100) NULL DEFAULT NULL,
  `provider_contact_id`      VARCHAR(100) NULL DEFAULT NULL,
  `is_verified`              TINYINT NOT NULL DEFAULT 0,
  `verified_at`              TIMESTAMP NULL DEFAULT NULL,
  `verified_by_cp_user_id`   INT NULL DEFAULT NULL,
  `verification_note`        VARCHAR(500) NULL DEFAULT NULL,
  -- Finance rejected the details; cleared when the partner saves new ones.
  -- Status: verified (is_verified = 1), rejected (rejected_at set), else pending.
  `rejected_at`              TIMESTAMP NULL DEFAULT NULL,
  `rejected_by_cp_user_id`   INT NULL DEFAULT NULL,
  `rejection_reason`         VARCHAR(500) NULL DEFAULT NULL,
  `created_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_partner_bank_account_org_idx` (`org_id` ASC) VISIBLE,
  INDEX `idx_partner_bank_account_queue` (`is_verified` ASC, `rejected_at` ASC, `submitted_at` ASC) VISIBLE,
  INDEX `fk_partner_bank_account_payee_user_idx` (`payee_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_bank_account_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_bank_account_payee_user`
    FOREIGN KEY (`payee_user_id`) REFERENCES `user` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_bank_account_payee`
    CHECK ((`org_id` IS NULL) <> (`payee_user_id` IS NULL))
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
  -- Foreign-currency payout, set at release: remitted amount and rate.
  `currency`                   CHAR(3)       NULL DEFAULT NULL,
  `amount_foreign`             DECIMAL(14,2) NULL DEFAULT NULL,
  `exchange_rate`              DECIMAL(12,4) NULL DEFAULT NULL,
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
  -- Cleared from the bell; still on the Notifications page (19 Nov).
  `archived_at` TIMESTAMP    NULL DEFAULT NULL,
  `created_at` TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_notification_user_created` (`user_id` ASC, `created_at` ASC) VISIBLE,
  INDEX `idx_notification_user_read`    (`user_id` ASC, `read_at` ASC) VISIBLE,
  INDEX `idx_notification_user_archived` (`user_id` ASC, `archived_at` ASC, `created_at` ASC) VISIBLE,
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

-- -----------------------------------------------------
-- student_partner_update  (FK -> student, user, cp_user)
-- Partner-portal profile edits awaiting Collegepond review (email + admin bell).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `student_partner_update` (
  `id`                     INT NOT NULL AUTO_INCREMENT,
  `student_id`             INT NOT NULL,
  `user_id`                INT NULL DEFAULT NULL,
  `section`                VARCHAR(30) NOT NULL,
  `changes`                JSON NOT NULL,
  `created_at`             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `emailed_at`             TIMESTAMP NULL DEFAULT NULL,
  `reviewed_at`            TIMESTAMP NULL DEFAULT NULL,
  `reviewed_by_cp_user_id` INT NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_spu_student_reviewed` (`student_id` ASC, `reviewed_at` ASC) VISIBLE,
  INDEX `idx_spu_emailed` (`emailed_at` ASC, `created_at` ASC) VISIBLE,
  INDEX `fk_spu_user_idx` (`user_id` ASC) VISIBLE,
  INDEX `fk_spu_cp_user_idx` (`reviewed_by_cp_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_spu_student`
    FOREIGN KEY (`student_id`) REFERENCES `student` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_spu_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_spu_cp_user`
    FOREIGN KEY (`reviewed_by_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
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


-- -----------------------------------------------------
-- geo_country / geo_state / geo_city — location master list
-- -----------------------------------------------------
-- Reference data for the country / state / city pickers (partner signup).
-- Loaded from GeoNames (CC BY 4.0) by the *_geo_master_data.sql migration,
-- which scripts/geo-build.mjs generates. Ids are GeoNames ids.
-- organization / user keep storing the picked names (and ISO2 country), not
-- these ids, so a city typed in by hand ("not listed") still fits.
CREATE TABLE IF NOT EXISTS `geo_country` (
  `iso2`  CHAR(2)      NOT NULL,
  `name`  VARCHAR(100) NOT NULL,
  PRIMARY KEY (`iso2`)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `geo_state` (
  `id`           INT UNSIGNED NOT NULL,
  `country_iso2` CHAR(2)      NOT NULL,
  `code`         VARCHAR(20)  NOT NULL,  -- GeoNames admin1 code, e.g. IN.16 -> "16"
  `name`         VARCHAR(100) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_geo_state_country_code` (`country_iso2` ASC, `code` ASC) VISIBLE,
  INDEX `idx_geo_state_country_name` (`country_iso2` ASC, `name` ASC) VISIBLE,
  CONSTRAINT `fk_geo_state_country`
    FOREIGN KEY (`country_iso2`) REFERENCES `geo_country` (`iso2`)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `geo_city` (
  `id`           INT UNSIGNED NOT NULL,
  `country_iso2` CHAR(2)      NOT NULL,
  `state_id`     INT UNSIGNED NULL DEFAULT NULL,  -- NULL when GeoNames has no admin1 for it
  `name`         VARCHAR(100) NOT NULL,
  `population`   INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  INDEX `idx_geo_city_state_name` (`state_id` ASC, `name` ASC) VISIBLE,
  INDEX `idx_geo_city_country_name` (`country_iso2` ASC, `name` ASC) VISIBLE,
  CONSTRAINT `fk_geo_city_country`
    FOREIGN KEY (`country_iso2`) REFERENCES `geo_country` (`iso2`),
  CONSTRAINT `fk_geo_city_state`
    FOREIGN KEY (`state_id`) REFERENCES `geo_state` (`id`)
) ENGINE = InnoDB;


-- -----------------------------------------------------------------------------
-- Partner chat (partner <-> Collegepond, one thread per student) and the TAT
-- master. See migrations/20261017061915_partner_chat.sql for the design notes.
-- -----------------------------------------------------------------------------
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
  `no_reply_needed_at`        TIMESTAMP   NULL DEFAULT NULL,
  `no_reply_needed_by_cp_user_id` INT     NULL DEFAULT NULL,
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
  `chat_ack_phrases`      VARCHAR(1000) NULL DEFAULT NULL,
  `chat_ack_max_length`   SMALLINT    NOT NULL DEFAULT 40,
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


-- Out of office (24 Oct 2026): one row per Collegepond counsellor, the dates
-- (inclusive, TAT timezone) and the alternate who covers them. See
-- src/server/out-of-office.ts.
-- cp_notification: persistent in-app feed for Collegepond staff (admin
-- Notifications page); `notification` is the partner users' feed.
CREATE TABLE IF NOT EXISTS `cp_out_of_office` (
  `id`                   INT       NOT NULL AUTO_INCREMENT,
  `cp_user_id`           INT       NOT NULL,
  `from_date`            DATE      NOT NULL,
  `to_date`              DATE      NOT NULL,
  `alternate_cp_user_id` INT       NOT NULL,
  `set_by_cp_user_id`    INT       NULL DEFAULT NULL,
  `created_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_cp_out_of_office_user` (`cp_user_id` ASC) VISIBLE,
  INDEX `fk_cp_out_of_office_alternate_idx` (`alternate_cp_user_id` ASC) VISIBLE,
  INDEX `idx_cp_out_of_office_dates` (`from_date` ASC, `to_date` ASC) VISIBLE,
  CONSTRAINT `fk_cp_out_of_office_user`
    FOREIGN KEY (`cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_cp_out_of_office_alternate`
    FOREIGN KEY (`alternate_cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `cp_notification` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `cp_user_id` INT          NOT NULL,
  `type`       VARCHAR(50)  NOT NULL,
  `title`      VARCHAR(255) NOT NULL,
  `body`       VARCHAR(500) NULL DEFAULT NULL,
  `link`       VARCHAR(255) NULL DEFAULT NULL,
  `tone`       VARCHAR(10)  NOT NULL DEFAULT 'blue',
  `read_at`    TIMESTAMP    NULL DEFAULT NULL,
  -- Cleared from the bell; still on the Notifications page (19 Nov).
  `archived_at` TIMESTAMP   NULL DEFAULT NULL,
  `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_cp_notification_user_created` (`cp_user_id` ASC, `created_at` ASC) VISIBLE,
  INDEX `idx_cp_notification_user_read` (`cp_user_id` ASC, `read_at` ASC) VISIBLE,
  INDEX `idx_cp_notification_user_archived` (`cp_user_id` ASC, `archived_at` ASC, `created_at` ASC) VISIBLE,
  CONSTRAINT `fk_cp_notification_user`
    FOREIGN KEY (`cp_user_id`) REFERENCES `cp_user` (`id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- cp_tab_default / cp_tab_override: tab on/off switches per user type and
-- per user (src/server/tab-access.ts). Rows exist only where a Super Admin
-- saved something different from the built-in default.
-- -----------------------------------------------------
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


-- -----------------------------------------------------
-- adjustment_reason  (Settings -> Adjustment Reasons master. Deactivate,
-- don't delete, once an adjustment uses it.)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `adjustment_reason` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(150) NOT NULL,
  `sort_order` INT          NOT NULL DEFAULT 0,
  `is_active`  TINYINT      NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_adjustment_reason_name` (`name` ASC) VISIBLE
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- adjustment  (append-only ledger of deductions / credits; 16 Nov 2026)
--   side       0 UNIVERSITY (what the university / vendor owes CP)
--              1 PARTNER    (what CP owes the payee)
--   direction  0 DEDUCTION (reduces it)  1 CREDIT (increases it)
--   status     0 DRAFT  1 APPROVED  2 REJECTED  (only a Super Admin decides)
-- The original commission / invoice / payment / payout rows are never edited:
-- an approved adjustment is applied through adjustment_allocation rows.
-- PARTNER side: exactly one payee (org_id XOR payee_user_id), amounts in INR.
-- note_* = the numbered Adjustment Note sent to the partner on approval.
-- *_by_cp_user_id are loose audit refs (no FK), like partner_payout's.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `adjustment` (
  `id`                    INT           NOT NULL AUTO_INCREMENT,
  `side`                  TINYINT UNSIGNED NOT NULL,
  `direction`             TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `status`                TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `reason_id`             INT           NOT NULL,
  `amount`                DECIMAL(14,2) NOT NULL,
  `currency`              CHAR(3)       NOT NULL,
  `adjustment_date`       DATE          NOT NULL,
  `vendor_id`             INT           NULL DEFAULT NULL,
  `university_id`         INT           NULL DEFAULT NULL,
  `org_id`                INT           NULL DEFAULT NULL,
  `payee_user_id`         INT           NULL DEFAULT NULL,
  `commission_id`         INT           NULL DEFAULT NULL,
  `commission_tranche_id` INT           NULL DEFAULT NULL,
  `vendor_invoice_id`     INT           NULL DEFAULT NULL,
  `source_adjustment_id`  INT           NULL DEFAULT NULL,
  `internal_note`         VARCHAR(1000) NULL DEFAULT NULL,
  `partner_note`          VARCHAR(500)  NULL DEFAULT NULL,
  `created_by_cp_user_id` INT           NOT NULL,
  `decided_by_cp_user_id` INT           NULL DEFAULT NULL,
  `decided_at`            TIMESTAMP     NULL DEFAULT NULL,
  `decision_note`         VARCHAR(500)  NULL DEFAULT NULL,
  `note_fy`               SMALLINT      NULL DEFAULT NULL,
  `note_seq`              INT           NULL DEFAULT NULL,
  `note_number`           VARCHAR(30)   NULL DEFAULT NULL,
  `created_at`            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_adjustment_note_number` (`note_number` ASC) VISIBLE,
  UNIQUE INDEX `uq_adjustment_note_seq` (`note_fy` ASC, `note_seq` ASC) VISIBLE,
  INDEX `idx_adjustment_side_status` (`side` ASC, `status` ASC) VISIBLE,
  INDEX `fk_adjustment_reason_idx` (`reason_id` ASC) VISIBLE,
  INDEX `fk_adjustment_vendor_idx` (`vendor_id` ASC) VISIBLE,
  INDEX `fk_adjustment_university_idx` (`university_id` ASC) VISIBLE,
  INDEX `fk_adjustment_org_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_adjustment_payee_user_idx` (`payee_user_id` ASC) VISIBLE,
  INDEX `fk_adjustment_commission_idx` (`commission_id` ASC) VISIBLE,
  INDEX `fk_adjustment_tranche_idx` (`commission_tranche_id` ASC) VISIBLE,
  INDEX `fk_adjustment_vendor_invoice_idx` (`vendor_invoice_id` ASC) VISIBLE,
  INDEX `fk_adjustment_source_idx` (`source_adjustment_id` ASC) VISIBLE,
  CONSTRAINT `fk_adjustment_reason`
    FOREIGN KEY (`reason_id`) REFERENCES `adjustment_reason` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_vendor`
    FOREIGN KEY (`vendor_id`) REFERENCES `vendor` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_university`
    FOREIGN KEY (`university_id`) REFERENCES `university` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_payee_user`
    FOREIGN KEY (`payee_user_id`) REFERENCES `user` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_commission`
    FOREIGN KEY (`commission_id`) REFERENCES `commission` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_tranche`
    FOREIGN KEY (`commission_tranche_id`) REFERENCES `commission_tranche` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_vendor_invoice`
    FOREIGN KEY (`vendor_invoice_id`) REFERENCES `vendor_invoice` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_source`
    FOREIGN KEY (`source_adjustment_id`) REFERENCES `adjustment` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_adjustment_amount` CHECK (`amount` > 0),
  CONSTRAINT `chk_adjustment_partner_payee` CHECK (
    `side` <> 1 OR ((`org_id` IS NULL) <> (`payee_user_id` IS NULL)))
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- adjustment_evidence  (staff-only uploads, folder adjustment-evidence/)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `adjustment_evidence` (
  `id`                     INT          NOT NULL AUTO_INCREMENT,
  `adjustment_id`          INT          NOT NULL,
  `file_url`               VARCHAR(500) NOT NULL,
  `file_name`              VARCHAR(255) NULL DEFAULT NULL,
  `uploaded_by_cp_user_id` INT          NOT NULL,
  `created_at`             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_adjustment_evidence_adjustment_idx` (`adjustment_id` ASC) VISIBLE,
  CONSTRAINT `fk_adjustment_evidence_adjustment`
    FOREIGN KEY (`adjustment_id`) REFERENCES `adjustment` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- adjustment_allocation  (how much of an approved adjustment has been applied,
-- and where: a vendor invoice (UNIVERSITY side) or a released partner payout
-- (PARTNER side). Exactly one target. Balance = amount - SUM(allocations).)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `adjustment_allocation` (
  `id`                    INT           NOT NULL AUTO_INCREMENT,
  `adjustment_id`         INT           NOT NULL,
  `vendor_invoice_id`     INT           NULL DEFAULT NULL,
  `partner_payout_id`     INT           NULL DEFAULT NULL,
  `amount`                DECIMAL(14,2) NOT NULL,
  `created_by_cp_user_id` INT           NULL DEFAULT NULL,
  `created_at`            TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `fk_adjustment_allocation_adjustment_idx` (`adjustment_id` ASC) VISIBLE,
  INDEX `fk_adjustment_allocation_vendor_invoice_idx` (`vendor_invoice_id` ASC) VISIBLE,
  INDEX `fk_adjustment_allocation_payout_idx` (`partner_payout_id` ASC) VISIBLE,
  CONSTRAINT `fk_adjustment_allocation_adjustment`
    FOREIGN KEY (`adjustment_id`) REFERENCES `adjustment` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_allocation_vendor_invoice`
    FOREIGN KEY (`vendor_invoice_id`) REFERENCES `vendor_invoice` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_adjustment_allocation_payout`
    FOREIGN KEY (`partner_payout_id`) REFERENCES `partner_payout` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_adjustment_allocation_amount` CHECK (`amount` > 0),
  CONSTRAINT `chk_adjustment_allocation_target` CHECK (
    (`vendor_invoice_id` IS NULL) <> (`partner_payout_id` IS NULL))
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- payout_hold  (a payee on payout hold: claims still come in, nothing is
-- approved for payment or released. Active = lifted_at IS NULL. Placed and
-- lifted by a Finance Manager / Super Admin; rows are kept as the history.)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS `payout_hold` (
  `id`                    INT          NOT NULL AUTO_INCREMENT,
  `org_id`                INT          NULL DEFAULT NULL,
  `payee_user_id`         INT          NULL DEFAULT NULL,
  `reason`                VARCHAR(500) NOT NULL,
  `placed_by_cp_user_id`  INT          NOT NULL,
  `placed_at`             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lifted_by_cp_user_id`  INT          NULL DEFAULT NULL,
  `lifted_at`             TIMESTAMP    NULL DEFAULT NULL,
  `lift_note`             VARCHAR(500) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `fk_payout_hold_org_idx` (`org_id` ASC) VISIBLE,
  INDEX `fk_payout_hold_payee_user_idx` (`payee_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_payout_hold_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_payout_hold_payee_user`
    FOREIGN KEY (`payee_user_id`) REFERENCES `user` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `chk_payout_hold_payee` CHECK (
    (`org_id` IS NULL) <> (`payee_user_id` IS NULL))
) ENGINE = InnoDB;


-- -----------------------------------------------------
-- Partner Notices master (Settings -> Partner Notices). partner_notice_trigger
-- holds per-trigger overrides keyed by the code's trigger code (no row = the
-- code's defaults); manual notices are free-text announcements, optionally
-- limited to specific partners.
-- -----------------------------------------------------
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


-- Resources library (Admin > Resources, Partner > Resources; 16 Nov 2026).
-- resource_category is the Settings > Resource Categories master (deactivate,
-- don't delete, once a resource uses it). A file resource keeps every upload
-- in resource_version (partners get the highest version_no); downloads and
-- previews are logged in resource_download; resource_notification makes the
-- publish bell / email go once per resource per recipient.
-- -----------------------------------------------------
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

-- -----------------------------------------------------
-- Counsellor tasks, shortlist follow-ups, shortlisting TAT (19 Nov 2026).
-- See 20261119120000_tasks_followups and src/server/tasks.ts,
-- src/server/shortlist-follow-up.ts.
-- -----------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- Loan lead sharing with the Enrollment App (partners refer education-loan
-- leads; progress mirrored back). See migrations/20261119130000_loan_referrals.sql
-- and docs/loan-sharing/CONTRACT.md.
-- -----------------------------------------------------------------------------
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
  `synced_at`   TIMESTAMP(3)  NULL DEFAULT NULL,
  `created_at`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_loan_referral_event_event_id` (`event_id` ASC) VISIBLE,
  INDEX `idx_loan_referral_event_referral` (`referral_id` ASC, `occurred_at` ASC) VISIBLE,
  CONSTRAINT `fk_loan_referral_event_referral`
    FOREIGN KEY (`referral_id`) REFERENCES `loan_referral` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_referral_message` (
  `id`              INT               NOT NULL AUTO_INCREMENT,
  `public_id`       CHAR(36)          NOT NULL,
  `referral_id`     INT               NOT NULL,
  `side`            VARCHAR(10)       NOT NULL DEFAULT 'partner',
  `external_id`     VARCHAR(80)       NULL DEFAULT NULL,
  `author_user_id`  INT               NULL DEFAULT NULL,
  `author_name`     VARCHAR(150)      NOT NULL,
  `body`            VARCHAR(2000)     NOT NULL DEFAULT '',
  `send_status`     TINYINT UNSIGNED  NOT NULL DEFAULT 0,
  `send_attempts`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `next_attempt_at` TIMESTAMP         NULL DEFAULT NULL,
  `last_error`      VARCHAR(500)      NULL DEFAULT NULL,
  `activity_id`     VARCHAR(64)       NULL DEFAULT NULL,
  `emailed_at`      TIMESTAMP         NULL DEFAULT NULL,
  `created_at`      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      TIMESTAMP         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_loan_referral_message_public_id` (`public_id` ASC) VISIBLE,
  UNIQUE INDEX `uq_loan_referral_message_external` (`external_id` ASC) VISIBLE,
  INDEX `idx_loan_referral_message_referral` (`referral_id` ASC, `created_at` ASC) VISIBLE,
  INDEX `idx_loan_referral_message_send` (`send_status` ASC, `next_attempt_at` ASC) VISIBLE,
  INDEX `idx_loan_referral_message_author` (`author_user_id` ASC) VISIBLE,
  CONSTRAINT `fk_loan_referral_message_referral`
    FOREIGN KEY (`referral_id`) REFERENCES `loan_referral` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_loan_referral_message_author`
    FOREIGN KEY (`author_user_id`) REFERENCES `user` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_referral_message_file` (
  `id`          INT          NOT NULL AUTO_INCREMENT,
  `message_id`  INT          NOT NULL,
  `file_name`   VARCHAR(200) NOT NULL,
  `storage_ref` VARCHAR(255) NOT NULL,
  `size`        INT UNSIGNED NOT NULL,
  `sha256`      CHAR(64)     NOT NULL,
  `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_loan_referral_message_file_message` (`message_id` ASC) VISIBLE,
  CONSTRAINT `fk_loan_referral_message_file_message`
    FOREIGN KEY (`message_id`) REFERENCES `loan_referral_message` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS `loan_chat_read` (
  `referral_id` INT          NOT NULL,
  `user_id`     INT          NOT NULL,
  `read_at`     TIMESTAMP(3) NOT NULL,
  PRIMARY KEY (`referral_id`, `user_id`),
  INDEX `idx_loan_chat_read_user` (`user_id` ASC) VISIBLE,
  CONSTRAINT `fk_loan_chat_read_referral`
    FOREIGN KEY (`referral_id`) REFERENCES `loan_referral` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_loan_chat_read_user`
    FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;



SET SQL_MODE            = @OLD_SQL_MODE;
SET FOREIGN_KEY_CHECKS  = @OLD_FOREIGN_KEY_CHECKS;
SET UNIQUE_CHECKS       = @OLD_UNIQUE_CHECKS;
