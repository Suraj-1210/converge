-- From 21 January 2026 the TOEFL iBT is scored on a 1-6 band scale (0.5
-- steps); the 0-120 score is reported alongside only for a two-year transition.
-- Universities now publish minimums on either scale, so a program keeps both:
-- the existing `toefl` (0-120) and this `toefl_2026` (1-6). Uni Assist
-- compares a student's score against the minimum on the same scale.
ALTER TABLE `course`
  ADD COLUMN `toefl_2026` DECIMAL(2,1) UNSIGNED NULL DEFAULT NULL AFTER `toefl`;
