-- A frozen PDF of the executed MOU, rendered at the moment of signing, so a
-- partner's copy never changes if the MOU wording is updated later. Storage
-- key (Spaces, private) or /uploads/... path in local dev. NULL for MOUs
-- signed before this, which /api/mou renders on the fly instead.
ALTER TABLE `user`
  ADD COLUMN `mou_pdf_url` VARCHAR(500) NULL DEFAULT NULL AFTER `mou_version`;
