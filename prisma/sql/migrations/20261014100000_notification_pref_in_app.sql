-- In-app channel for partner notification preferences. Only the agency
-- owner's "Notify my counsellors when students are assigned to them" setting
-- uses it today; every other type ignores it. Defaults to on, so existing
-- rows (and a missing row) keep behaving as before.
ALTER TABLE `notification_preference`
  ADD COLUMN `via_in_app` TINYINT NOT NULL DEFAULT 1 AFTER `via_email`;
