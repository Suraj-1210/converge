-- Partner users and their agency, enforced by the database: an agency owner or
-- agency counsellor must have an organization; an independent counsellor must
-- not. (Admins, type 10, aren't partner users and are exempt.) Before this,
-- an owner-added counsellor could silently lose their org and turn into an
-- "Independent Counsellor".
--
-- PRECONDITION: no row may violate the rule, or this fails with "Check
-- constraint 'chk_user_partner_org' is violated" and the boot-time db-apply
-- stops the deploy. Run `node scripts/fix-counsellor-links.mjs` (preview) in
-- the app console first; section 3 must report 0 blocking rows.
--
-- MySQL refuses a CHECK on a column used by a cascading foreign key, so the
-- user → organization key changes from CASCADE to RESTRICT: deleting an agency
-- no longer silently deletes everyone in it. Nothing in the app deletes
-- organizations; scripts/reset-data.mjs deletes children first. One ALTER, so
-- a violation leaves the original key in place. (The key gets a new name
-- because MySQL can't drop and re-add the same name in one statement.)
ALTER TABLE `user`
  DROP FOREIGN KEY `fk_user_organization`,
  ADD CONSTRAINT `fk_user_org`
    FOREIGN KEY (`org_id`) REFERENCES `organization` (`id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT `chk_user_partner_org`
    CHECK (`type` NOT IN (0, 1, 2) OR ((`type` = 2) = (`org_id` IS NULL)));
