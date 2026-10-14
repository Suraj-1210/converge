-- =============================================================================
-- Converge — Seed data
-- =============================================================================
-- Applied by scripts/db-reset.sh after schema.sql.
--
-- Phone is stored as "${countryCode}${phone}" so it round-trips through the
-- toE164() helper used by the auth flow.
--
-- Dev login credentials (all use phone OTP):
--   role=0 SUPER_ADMIN          → admin@collegepond.com           / +91 9876543210
--   role=1 FINANCE_MANAGER      → finance.manager@collegepond.com / +91 9876543211
--   role=2 FINANCE_EXECUTIVE    → finance.exec@collegepond.com    / +91 9876543212
--   role=3 COUNSELLOR_LEAD      → counsellor.lead@collegepond.com / +91 9876543213
--   role=4 COUNSELLOR           → counsellor@collegepond.com      / +91 9876543214
--   role=5 OPERATIONS_LEAD      → ops.lead@collegepond.com        / +91 9876543215
--   role=6 OPERATIONS_EXECUTIVE → ops.exec@collegepond.com        / +91 9876543216
--   role=7 CONTENT_MANAGER      → content.manager@collegepond.com / +91 9876543217
--   role=8 BDM                  → bdm@collegepond.com             / +91 9876543218
-- =============================================================================

-- Department master (Settings -> Departments). Same rows as the
-- 20261013120000_department_master migration seeds.
INSERT IGNORE INTO `department` (`name`, `is_active`, `sort_order`) VALUES
  ('Management',           1, 10),
  ('Counselling',          1, 20),
  ('Business Development', 1, 30),
  ('Operations',           1, 40),
  ('Finance',              1, 50),
  ('Content',              1, 60);

-- Partner Tiers master (Settings -> Partner Tiers). Same rows as the
-- 20261014091941_partner_tiers migration seeds.
INSERT IGNORE INTO `partner_tier` (`name`, `display_order`, `badge_color`, `icon`, `benefits`) VALUES
  ('Silver',   10, '#344054', CONVERT(0xf09fa588 USING utf8mb4), JSON_ARRAY('Standard Application Processing', 'Email Support')),
  ('Gold',     20, '#027A48', CONVERT(0xf09fa587 USING utf8mb4), JSON_ARRAY('Priority Application Processing', 'Dedicated Support', 'Quarterly Webinars')),
  ('Platinum', 30, '#B54708', CONVERT(0xf09f8f86 USING utf8mb4), JSON_ARRAY('Priority Processing', 'Priority access to your Relationship Manager', 'Training & Webinars', 'Early University Access')),
  ('Titanium', 40, '#6941C6', CONVERT(0xe29aa1 USING utf8mb4), JSON_ARRAY('Priority Processing', 'Priority access to your Relationship Manager', 'Exclusive Training', 'Early Access', 'Sponsored Events')),
  ('Diamond',  50, '#1570EF', CONVERT(0xf09f928e USING utf8mb4), JSON_ARRAY('Priority Application Processing', 'Priority access to your Relationship Manager', 'Exclusive Training & Webinars', 'Early Access to New Universities', 'Sponsored Events & Fam Trips'));

INSERT IGNORE INTO `partner_tier_rule` (`fy`, `tier_id`, `min_students`, `max_students`, `share_pct`)
  SELECT 2026, t.`id`, r.min_s, r.max_s, r.share
  FROM `partner_tier` t
  JOIN (
    SELECT 'Silver' AS name, 0 AS min_s, 10 AS max_s, 70.00 AS share
    UNION ALL SELECT 'Gold',     11, 30,   75.00
    UNION ALL SELECT 'Platinum', 31, 50,   80.00
    UNION ALL SELECT 'Titanium', 51, 75,   85.00
    UNION ALL SELECT 'Diamond',  76, NULL, 90.00
  ) r ON r.name = t.`name`;

-- One CollegePond staff user per role, for local development. status=1 → active.
-- last_login_at seeded to NOW() so the dev UI doesn't show "Never" everywhere.
INSERT IGNORE INTO `cp_user` (
  `first_name`, `last_name`, `email`, `phone`, `role`, `status`, `last_login_at`
) VALUES
  ('Admin',       'User',       'admin@collegepond.com',           '+919876543210', 0, 1, NOW()),
  ('Finance',     'Manager',    'finance.manager@collegepond.com', '+919876543211', 1, 1, NOW()),
  ('Finance',     'Executive',  'finance.exec@collegepond.com',    '+919876543212', 2, 1, NOW()),
  ('Counsellor',  'Lead',       'counsellor.lead@collegepond.com', '+919876543213', 3, 1, NOW()),
  ('Counsellor',  'One',        'counsellor@collegepond.com',      '+919876543214', 4, 1, NOW()),
  ('Operations',  'Lead',       'ops.lead@collegepond.com',        '+919876543215', 5, 1, NOW()),
  ('Operations',  'Executive',  'ops.exec@collegepond.com',        '+919876543216', 6, 1, NOW()),
  ('Content',     'Manager',    'content.manager@collegepond.com', '+919876543217', 7, 1, NOW()),
  ('BDM',         'Partner',    'bdm@collegepond.com',             '+919876543218', 8, 1, NOW());

-- ---------------------------------------------------------------------------
-- Partner orgs + users
-- ---------------------------------------------------------------------------
INSERT INTO organization (id, name, type, website, city, country, is_verified, url_identifier) VALUES
  (1, 'test',                         0, NULL,                                       NULL,     NULL, 1, 'test'),
  (2, 'Global Education Consultants', 0, 'https://globaleduconsultants.example.com', 'Mumbai', 'IN', 1, 'global-education-consultants'),
  (3, 'EduBridge International',      0, 'https://edubridge.example.com',            'Pune',   'IN', 1, 'edubridge-international');

INSERT INTO user (id, first_name, last_name, type, email, phone, is_owner, status, is_email_verified, is_phone_verified, tracking_id, org_id, address, city, state, country, bdm_id, mou_signed_at) VALUES
  (1, 'Test',   'Partner',  0, 'test@college.pond',           '+919111111111', 1, 1, 1, 1, 'PT-2026-0001', 1, 'Office Address', 'Mumbai', 'Maharashtra', 'IN', 9, NOW()),
  (2, 'Meera',  'Krishnan', 0, 'gec.owner@example.com',       '+919822000111', 1, 1, 1, 1, 'PT-2026-0002', 2, 'Office Address', 'Mumbai', 'Maharashtra', 'IN', 9, NOW()),
  (3, 'Arjun',  'Malhotra', 0, 'edubridge.owner@example.com', '+919822000222', 1, 1, 1, 1, 'PT-2026-0003', 3, 'Office Address', 'Mumbai', 'Maharashtra', 'IN', 9, NOW()),
  (4, 'Nisha',  'Iyer',     1, 'counsellor@college.pond',     '+919822000333', 0, 1, 1, 1, 'PT-2026-0004', 1, 'Office Address', 'Mumbai', 'Maharashtra', 'IN', NULL, NULL);

-- ---------------------------------------------------------------------------
-- Universities + courses (mirrors the dev catalogue)
-- ---------------------------------------------------------------------------
INSERT INTO university (id, name, code, city, country, type, website, is_open) VALUES
  (1, 'Massachusetts Institute of Technology', 'MIT', 'Cambridge', 'US', 1, 'https://www.mit.edu', 1),
  (2, 'Stanford University',                   NULL,  'Stanford',  'US', 0, 'https://www.stanford.edu', 1),
  (3, 'University of Oxford',                  'OXF', 'Oxford',    'GB', 0, 'https://www.ox.ac.uk', 1),
  (4, 'University of Toronto',                 NULL,  'Toronto',   'CA', 0, 'https://www.utoronto.ca', 1),
  (5, 'National University of Singapore',      NULL,  'Singapore', 'SG', 0, 'https://www.nus.edu.sg', 1),
  (6, 'Imperial College London',               NULL,  'London',    'GB', 0, 'https://www.imperial.ac.uk', 1),
  (7, 'MIT Sloan',                             'MIS', 'Cambridge', 'US', 1, 'https://mitsloan.mit.edu', 1),
  (8, 'Cambridge',                             'CAM', 'Cambridge', 'GB', 0, 'https://www.cam.ac.uk', 1);

-- How applications reach each university (drives the source badge and the
-- portal-credentials section on the student profile).
UPDATE university SET app_source = 'University Portal' WHERE id IN (1, 3, 4, 6);
UPDATE university SET app_source = 'Agent Portal'      WHERE id IN (2, 5);
UPDATE university SET app_source = 'Paper-based'       WHERE id = 8;

INSERT INTO course (id, university_id, name, degree_level, duration_months, tuition_fee, currency, intake_month, intake_year, is_stem, is_open, url) VALUES
  (1,  1, 'MS Computer Science',         1, 24, 58000.00, 'USD', 'Sep',      2026, 1, 1, 'https://www.example.edu/program'),
  (2,  1, 'MEng Mechanical Engineering', 1, 18, 56000.00, 'USD', 'Sep, Jan', 2026, 1, 1, 'https://www.example.edu/program'),
  (3,  2, 'MBA',                         2, 21, 82455.00, 'USD', 'Sep',      2026, 0, 1, 'https://www.example.edu/program'),
  (4,  2, 'MS Computer Science',         1, 18, 60000.00, 'USD', 'Sep',      2026, 1, 1, 'https://www.example.edu/program'),
  (5,  3, 'MSc Computer Science',        1, 12, 32760.00, 'GBP', 'Oct',      2026, 1, 1, 'https://www.example.edu/program'),
  (6,  3, 'MBA',                         2, 12, 76500.00, 'GBP', 'Sep',      2026, 0, 1, 'https://www.example.edu/program'),
  (7,  4, 'MEng Software Engineering',   1, 16, 47200.00, 'CAD', 'Sep, Jan', 2026, 1, 1, 'https://www.example.edu/program'),
  (8,  5, 'MSc Computer Science',        1, 18, 50100.00, 'SGD', 'Aug',      2026, 1, 1, 'https://www.example.edu/program'),
  (9,  6, 'MSc Artificial Intelligence', 1, 12, 42500.00, 'GBP', 'Sep',      2026, 1, 1, 'https://www.example.edu/program'),
  (10, 6, 'MSc Data Science',            1, 12, 41200.00, 'GBP', 'Sep',      2026, 1, 1, 'https://www.example.edu/program');





-- Display IDs read CP-10001+ (mockup style).
ALTER TABLE student AUTO_INCREMENT = 10001;

-- status codes: see StudentStatus in src/server/db/enums.ts
-- course_level: 0 Foundation, 1 Diploma, 2 UG, 3 PG, 4 MBA, 5 PhD
INSERT INTO student (id, first_name, last_name, email, phone, country, intake, date_of_birth, gender, org_id, counsellor_id, nationality, status, course_level, interested_program, needs_edu_loan, apply_through_cp, cp_counsellor_id, created_by_user_id, created_at, updated_at) VALUES
  -- org 1 (test) — owner user 1, agency counsellor user 4
  (10001, 'Ananya',   'Patel',    'ananya.patel@example.com',    '+91 98200 11234', 'CA', 'Fall 2026', '2000-01-01',   2, 1, 4,    'IN', 12, 3, 'MS Computer Science',      1, 1, 5,    4,    '2026-04-02 09:15:00', '2026-06-10 14:05:00'),
  (10002, 'Rohan',    'Sharma',   'rohan.sharma@example.com',    '+91 98200 11235', 'US', 'Fall 2026', '2000-01-01',   1, 1, 4,    'IN', 0,  3, 'Data Science',             0, 1, NULL, 4,    '2026-06-05 11:30:00', '2026-06-09 16:40:00'),
  (10003, 'Priya',    'Mehta',    'priya.mehta@example.com',     '+91 98200 11236', 'GB', 'Spring 2027', '2000-01-01', 2, 1, NULL, 'IN', 2,  2, 'Business Analytics',       0, 0, 5,    1,    '2026-05-18 10:00:00', '2026-06-08 12:20:00'),
  (10004, 'Aditya',   'Verma',    'aditya.verma@example.com',    '+91 98200 11237', 'AU', 'Fall 2026', '2000-01-01',   1, 1, 4,    'IN', 11, 3, 'Mechanical Engineering',   1, 1, 4,    4,    '2026-03-28 14:45:00', '2026-06-11 09:10:00'),
  (10005, 'Sneha',    'Reddy',    'sneha.reddy@example.com',     '+91 98200 11238', 'CA', 'Spring 2027', '2000-01-01', 2, 1, NULL, 'IN', 20, 4, 'MBA / Business Admin',     1, 1, 5,    1,    '2026-04-12 09:00:00', '2026-06-07 17:55:00'),
  (10006, 'Karthik',  'Iyer',     'karthik.iyer@example.com',    '+91 98200 11239', 'DE', 'Fall 2027', '2000-01-01',   1, 1, NULL, 'IN', 1,  3, 'Information Technology',   0, 0, NULL, 1,    '2026-06-01 13:25:00', '2026-06-06 10:35:00'),
  (10007, 'Ishita',   'Gupta',    'ishita.gupta@example.com',    '+91 98200 11240', 'IE', 'Fall 2026', '2000-01-01',   2, 1, 4,    'IN', 3,  2, 'Computer Science',         0, 1, NULL, 4,    '2026-05-22 15:50:00', '2026-06-05 11:45:00'),
  (10008, 'Arjun',    'Nair',     'arjun.nair@example.com',      '+91 98200 11241', 'SG', 'Fall 2026', '2000-01-01',   1, 1, NULL, 'IN', 13, 3, 'Finance',                  1, 1, 4,    1,    '2026-04-08 08:40:00', '2026-06-10 18:30:00'),
  (10009, 'Meera',    'Joshi',    'meera.joshi@example.com',     '+91 98200 11242', 'GB', 'Spring 2027', '2000-01-01', 2, 1, NULL, 'IN', 40, 3, 'Law',                      1, 1, 5,    1,    '2026-03-15 12:10:00', '2026-06-04 09:25:00'),
  (10010, 'Vikram',   'Singh',    'vikram.singh@example.com',    '+91 98200 11243', 'US', 'Fall 2026', '2000-01-01',   1, 1, NULL, 'IN', 4,  5, 'Physics',                  0, 0, NULL, 1,    '2026-05-02 16:35:00', '2026-05-28 14:15:00'),
  -- org 2 (Global Education Consultants) — owner user 2
  (10011, 'Kavya',    'Desai',    'kavya.desai@example.com',     '+91 98330 22101', 'CA', 'Fall 2026', '2000-01-01',   2, 2, NULL, 'IN', 21, 3, 'Artificial Intelligence',  1, 1, 5,    2,    '2026-03-20 10:20:00', '2026-06-09 13:50:00'),
  (10012, 'Rahul',    'Chopra',   'rahul.chopra@example.com',    '+91 98330 22102', 'US', 'Fall 2026', '2000-01-01',   1, 2, NULL, 'IN', 41, 3, 'MS Computer Science',      1, 1, 4,    2,    '2026-02-25 09:05:00', '2026-06-02 15:30:00'),
  (10013, 'Divya',    'Menon',    'divya.menon@example.com',     '+91 98330 22103', 'GB', 'Spring 2027', '2000-01-01', 2, 2, NULL, 'IN', 0,  2, 'Psychology',               0, 0, NULL, 2,    '2026-06-08 14:55:00', '2026-06-11 10:45:00'),
  (10014, 'Siddharth','Rao',      'siddharth.rao@example.com',   '+91 98330 22104', 'AU', 'Fall 2027', '2000-01-01',   1, 2, NULL, 'IN', 10, 3, 'Civil Engineering',        1, 1, 5,    2,    '2026-05-10 11:15:00', '2026-06-08 16:05:00'),
  (10015, 'Tanya',    'Bose',     'tanya.bose@example.com',      '+91 98330 22105', 'CA', 'Fall 2026', '2000-01-01',   2, 2, NULL, 'IN', 22, 1, 'Hospitality',              0, 1, NULL, 2,    '2026-04-18 13:40:00', '2026-06-03 12:00:00'),
  (10016, 'Nikhil',   'Kulkarni', 'nikhil.kulkarni@example.com', '+91 98330 22106', 'DE', 'Spring 2027', '2000-01-01', 1, 2, NULL, 'IN', 42, 3, 'Mechanical Engineering',   1, 0, NULL, 2,    '2026-03-05 10:30:00', '2026-05-30 09:45:00'),
  (10017, 'Pooja',    'Hegde',    'pooja.hegde@example.com',     '+91 98330 22107', 'US', 'Fall 2026', '2000-01-01',   2, 2, NULL, 'IN', 30, 4, 'MBA / Business Admin',     0, 0, NULL, 2,    '2026-04-25 15:20:00', '2026-05-26 17:10:00'),
  (10018, 'Aarav',    'Shetty',   'aarav.shetty@example.com',    '+91 98330 22108', 'NZ', 'Fall 2027', '2000-01-01',   1, 2, NULL, 'IN', 5,  2, 'Information Technology',   0, 0, NULL, 2,    '2026-05-28 09:50:00', '2026-06-01 11:25:00'),
  -- org 3 (EduBridge International) — owner user 3
  (10019, 'Riya',     'Kapoor',   'riya.kapoor@example.com',     '+91 98440 33201', 'GB', 'Fall 2026', '2000-01-01',   2, 3, NULL, 'IN', 12, 3, 'Business Analytics',       1, 1, 4,    3,    '2026-04-05 12:45:00', '2026-06-10 10:15:00'),
  (10020, 'Dev',      'Patel',    'dev.patel@example.com',       '+91 98440 33202', 'CA', 'Spring 2027', '2000-01-01', 1, 3, NULL, 'IN', 2,  2, 'Architecture',             0, 1, NULL, 3,    '2026-05-25 10:05:00', '2026-06-07 14:35:00'),
  (10021, 'Anjali',   'Bhatt',    'anjali.bhatt@example.com',    '+91 98440 33203', 'US', 'Fall 2026', '2000-01-01',   2, 3, NULL, 'IN', 31, 3, 'Data Science',             0, 0, NULL, 3,    '2026-03-30 16:00:00', '2026-05-24 13:05:00'),
  (10022, 'Farhan',   'Khan',     'farhan.khan@example.com',     '+91 98440 33204', 'IE', 'Fall 2027', '2000-01-01',   1, 3, NULL, 'IN', 43, 3, 'Media & Communications',   1, 1, NULL, 3,    '2026-02-15 11:35:00', '2026-05-22 15:45:00'),
  (10023, 'Lakshmi',  'Pillai',   'lakshmi.pillai@example.com',  '+91 98440 33205', 'SG', 'Fall 2026', '2000-01-01',   2, 3, NULL, 'IN', 44, 3, 'Finance',                  0, 1, NULL, 3,    '2026-03-10 09:30:00', '2026-05-20 10:50:00'),
  (10024, 'Manav',    'Thakur',   'manav.thakur@example.com',    '+91 98440 33206', 'AU', 'Spring 2027', '2000-01-01', 1, 3, NULL, 'IN', 0,  0, 'Foundation Year',          0, 0, NULL, 3,    '2026-06-09 17:20:00', '2026-06-11 08:55:00');

-- Applications for students past the lead stage.
-- application.status codes: see UniApplicationStatus in src/server/db/enums.ts
INSERT INTO application (status, submitted_at, student_id, course_id, org_id) VALUES
  (2,  '2026-05-28 10:00:00', 10001, 7,  1),  -- Ananya → Toronto MEng SW (submitted)
  (1,  NULL,                  10001, 1,  1),  -- Ananya → MIT MSCS (docs pending)
  (1,  NULL,                  10004, 2,  1),  -- Aditya → MIT MEng Mech
  (4,  '2026-05-12 09:30:00', 10005, 3,  1),  -- Sneha → Stanford MBA (conditional)
  (3,  '2026-05-30 14:00:00', 10008, 8,  1),  -- Arjun → NUS MSCS (under review)
  (6,  '2026-04-20 11:00:00', 10009, 6,  1),  -- Meera → Oxford MBA (deposit paid)
  (5,  '2026-04-28 10:30:00', 10011, 9,  2),  -- Kavya → Imperial AI (unconditional)
  (7,  '2026-03-18 09:00:00', 10012, 4,  2),  -- Rahul → Stanford MSCS (visa secured)
  (5,  '2026-03-25 15:00:00', 10012, 1,  2),  -- Rahul → MIT MSCS (unconditional)
  (0,  NULL,                  10014, 2,  2),  -- Siddharth → MIT MEng Mech (begin)
  (20, '2026-05-02 12:00:00', 10015, 7,  2),  -- Tanya → Toronto (rejected by university)
  (23, '2026-04-15 10:00:00', 10016, 2,  2),  -- Nikhil → MIT (visa rejected)
  (21, '2026-05-06 16:00:00', 10017, 3,  2),  -- Pooja → Stanford MBA (withdrawal)
  (2,  '2026-06-01 09:45:00', 10019, 10, 3),  -- Riya → Imperial DS (submitted)
  (22, '2026-05-10 13:30:00', 10021, 4,  3),  -- Anjali → Stanford MSCS (declined)
  (24, '2026-05-14 11:15:00', 10022, 9,  3),  -- Farhan → Imperial AI (deferred)
  (25, '2026-05-08 10:40:00', 10023, 8,  3);  -- Lakshmi → NUS (course closed)

-- Uni Assist shortlists — courses flagged for a student but not yet applied
-- (shows on the student profile's Application tab). collegepond_user 1 is
-- the seeded super admin.
INSERT INTO shortlist (student_id, course_id, collegepond_user_id, created_at) VALUES
  (10001, 5,  1, '2026-06-08 11:20:00'),  -- Ananya → Oxford MSc CS
  (10001, 10, 1, '2026-06-09 15:45:00'),  -- Ananya → Imperial Data Science
  (10005, 6,  1, '2026-06-05 10:10:00');  -- Sneha → Oxford MBA
