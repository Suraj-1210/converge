-- Partner documents never maintained `is_most_recent`: an admin adding a
-- document on a partner's behalf created a second row for the same type and
-- both stayed "current". That now matters, because approving a partner
-- approves its current pending documents and the admin/partner screens list
-- only current ones. The app now clears the flag on the older row when a
-- replacement is added; this does the same for rows already in the table.
--
-- For each partner (personal documents by user_id, company documents by
-- org_id) and doc_type, only the newest row stays current. Student documents
-- (student_id set) are untouched — they manage the flag themselves.
--
-- Data-only and idempotent: it only ever clears the flag on a row that has a
-- newer row of the same type and owner, so re-running is harmless.

UPDATE `document` d
JOIN `document` newer
  ON newer.doc_type = d.doc_type
 AND newer.id > d.id
 AND newer.student_id IS NULL
 AND (
       (d.user_id IS NOT NULL AND newer.user_id = d.user_id)
    OR (d.user_id IS NULL AND d.org_id IS NOT NULL
        AND newer.user_id IS NULL AND newer.org_id = d.org_id)
 )
SET d.is_most_recent = 0
WHERE d.student_id IS NULL
  AND d.is_most_recent = 1;
