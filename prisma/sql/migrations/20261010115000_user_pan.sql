-- PAN is now collected at signup: an agency's company PAN goes on
-- organization.pan (already present); an independent counsellor's personal
-- PAN goes here.
ALTER TABLE `user`
  ADD COLUMN `pan` VARCHAR(15) NULL DEFAULT NULL AFTER `country`;
