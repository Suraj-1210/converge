-- Partner notification preferences are now saved (they were page-only) and
-- control the matching emails. One row per partner per notification type;
-- via_email / via_sms (the "WhatsApp" column) are the two channels.
-- Collapse any duplicates first so the unique index can be added.
DELETE p1 FROM `notification_preference` p1
JOIN `notification_preference` p2
  ON p1.user_id = p2.user_id
 AND p1.notification_type = p2.notification_type
 AND p1.id < p2.id;

ALTER TABLE `notification_preference`
  ADD UNIQUE INDEX `uq_notification_pref_user_type` (`user_id` ASC, `notification_type` ASC) VISIBLE;
