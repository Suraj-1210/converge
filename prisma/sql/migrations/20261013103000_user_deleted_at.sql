-- Soft delete for partner users. An agency owner removing a counsellor who
-- has left sets this (and status = INACTIVE): the row stays, so its email and
-- phone remain reserved and its history intact, but it can't sign in and is
-- hidden from the agency's team list. Collegepond can restore it by clearing
-- the column.
ALTER TABLE `user`
  ADD COLUMN `deleted_at` TIMESTAMP NULL DEFAULT NULL AFTER `last_login_at`;
