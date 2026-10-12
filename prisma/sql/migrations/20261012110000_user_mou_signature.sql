-- Keep the partner's MOU signature so the executed MOU can be downloaded.
-- Until now signMou only stamped mou_signed_at and discarded the signature, so
-- partners who signed before this have a date but no signature on record.
ALTER TABLE `user`
  ADD COLUMN `mou_signature`      MEDIUMTEXT       NULL DEFAULT NULL AFTER `mou_signed_at`,  -- drawn: PNG data URL; typed: the typed name
  ADD COLUMN `mou_signature_kind` TINYINT UNSIGNED NULL DEFAULT NULL AFTER `mou_signature`,  -- 0 drawn, 1 typed
  ADD COLUMN `mou_signer_name`    VARCHAR(101)     NULL DEFAULT NULL AFTER `mou_signature_kind`,
  ADD COLUMN `mou_signed_ip`      VARCHAR(45)      NULL DEFAULT NULL AFTER `mou_signer_name`,
  ADD COLUMN `mou_version`        VARCHAR(20)      NULL DEFAULT NULL AFTER `mou_signed_ip`;
