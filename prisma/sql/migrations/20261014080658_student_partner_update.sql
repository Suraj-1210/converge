-- Changes a partner made to a student's profile (partner portal), kept so
-- Collegepond's counselling team is told: one email per burst of edits to
-- the student's Collegepond counsellor (or the Counsellor Leads), and an
-- admin-bell item until someone marks them reviewed on the student profile.
-- `changes` is a field-level diff: [{"field": "...", "from": ..., "to": ...}].
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
