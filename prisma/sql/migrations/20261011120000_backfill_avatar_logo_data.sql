-- Profile photos uploaded at signup were stored only as `document` rows
-- (doc_type 'profilePhoto'), never as the user's avatar, so they showed
-- nowhere in the portal. Signup now sets user.avatar_url as well; this
-- backfills existing partners. The same for agency logos, in case any
-- organization missed logo_url.
--
-- Data-only and idempotent: it fills blanks only and never overwrites a
-- photo or logo the partner has since chosen, so re-running is harmless.

UPDATE `user` u
JOIN (
  SELECT d.user_id, MAX(d.id) AS doc_id
  FROM `document` d
  WHERE d.doc_type = 'profilePhoto' AND d.user_id IS NOT NULL
  GROUP BY d.user_id
) latest ON latest.user_id = u.id
JOIN `document` d ON d.id = latest.doc_id
SET u.avatar_url = d.file_url
WHERE u.avatar_url IS NULL OR u.avatar_url = '';

UPDATE `organization` o
JOIN (
  SELECT d.org_id, MAX(d.id) AS doc_id
  FROM `document` d
  WHERE d.doc_type = 'logo' AND d.org_id IS NOT NULL
  GROUP BY d.org_id
) latest ON latest.org_id = o.id
JOIN `document` d ON d.id = latest.doc_id
SET o.logo_url = d.file_url
WHERE o.logo_url IS NULL OR o.logo_url = '';
