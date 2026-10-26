BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

-- 僅直接建立合成 Auth 資料列供 FK/RLS 測試，不執行 Supabase Auth 流程。
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('11000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'local-t008-student-approved@example.invalid', '{}', '{}', now(), now()),
  ('11000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'local-t008-student-unconfirmed@example.invalid', '{}', '{}', now(), now()),
  ('11000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'local-t008-student-withdrawn@example.invalid', '{}', '{}', now(), now()),
  ('11000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'local-t008-student-expired@example.invalid', '{}', '{}', now(), now()),
  ('11000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'local-t008-student-disabled@example.invalid', '{}', '{}', now(), now()),
  ('11000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'local-t008-student-deleted@example.invalid', '{}', '{}', now(), now()),
  ('11000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated', 'local-t008-teacher-approved@example.invalid', '{}', '{}', now(), now()),
  ('11000000-0000-4000-8000-000000000008', 'authenticated', 'authenticated', 'local-t008-teacher-pending@example.invalid', '{}', '{}', now(), now()),
  ('11000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'local-t008-admin@example.invalid', '{}', '{}', now(), now()),
  ('11000000-0000-4000-8000-000000000010', 'authenticated', 'authenticated', 'local-t008-teacher-rejected@example.invalid', '{}', '{}', now(), now()),
  ('11000000-0000-4000-8000-000000000011', 'authenticated', 'authenticated', 'local-t008-student-unbound@example.invalid', '{}', '{}', now(), now());

INSERT INTO app.schools (id, label, approval_state, approval_epoch, valid_until, created_at, updated_at)
VALUES
  ('21000000-0000-4000-8000-000000000001', 'synthetic-approved-school', 'approved', 1, '2000-01-01 00:00:00+00', now(), now()),
  ('21000000-0000-4000-8000-000000000002', 'synthetic-unconfirmed-school', 'unconfirmed', 0, now(), now(), now()),
  ('21000000-0000-4000-8000-000000000003', 'synthetic-withdrawn-school', 'withdrawn', 2, now(), now(), now()),
  ('21000000-0000-4000-8000-000000000004', 'synthetic-expired-school', 'expired', 2, now(), now(), now());

INSERT INTO app.profiles (
  id, role, status, deletion_state, school_id, handle, display_label, status_changed_at
) VALUES
  ('11000000-0000-4000-8000-000000000001', 'student', 'approved', 'none', '21000000-0000-4000-8000-000000000001', 't008_student_a', 'synthetic-student-a', now()),
  ('11000000-0000-4000-8000-000000000002', 'student', 'approved', 'none', '21000000-0000-4000-8000-000000000002', 't008_student_b', 'synthetic-student-b', now()),
  ('11000000-0000-4000-8000-000000000003', 'student', 'approved', 'none', '21000000-0000-4000-8000-000000000003', 't008_student_c', 'synthetic-student-c', now()),
  ('11000000-0000-4000-8000-000000000004', 'student', 'approved', 'none', '21000000-0000-4000-8000-000000000004', 't008_student_d', 'synthetic-student-d', now()),
  ('11000000-0000-4000-8000-000000000005', 'student', 'disabled', 'none', '21000000-0000-4000-8000-000000000001', 't008_student_e', 'synthetic-student-e', now()),
  ('11000000-0000-4000-8000-000000000006', 'student', 'approved', 'marked', '21000000-0000-4000-8000-000000000001', 't008_student_f', 'synthetic-student-f', now()),
  ('11000000-0000-4000-8000-000000000007', 'teacher', 'approved', 'none', NULL, NULL, 'synthetic-teacher-a', now()),
  ('11000000-0000-4000-8000-000000000008', 'teacher', 'pending', 'none', NULL, NULL, 'synthetic-teacher-pending', now()),
  ('11000000-0000-4000-8000-000000000009', 'admin', 'approved', 'none', NULL, NULL, 'synthetic-admin', now()),
  ('11000000-0000-4000-8000-000000000010', 'teacher', 'rejected', 'none', NULL, NULL, 'synthetic-teacher-rejected', now()),
  ('11000000-0000-4000-8000-000000000011', 'student', 'approved', 'none', '21000000-0000-4000-8000-000000000001', 't008_student_unbound', 'synthetic-student-unbound', now());

INSERT INTO app.teacher_student_bindings (
  id, teacher_id, student_id, state, created_by_aid, created_at, ended_at, ended_by_aid, end_reason
) VALUES
  ('31000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000007', '11000000-0000-4000-8000-000000000001', 'active', '41000000-0000-4000-8000-000000000001', now(), NULL, NULL, NULL),
  ('31000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000007', '11000000-0000-4000-8000-000000000002', 'active', '41000000-0000-4000-8000-000000000001', now(), NULL, NULL, NULL),
  ('31000000-0000-4000-8000-000000000003', '11000000-0000-4000-8000-000000000007', '11000000-0000-4000-8000-000000000003', 'active', '41000000-0000-4000-8000-000000000001', now(), NULL, NULL, NULL),
  ('31000000-0000-4000-8000-000000000004', '11000000-0000-4000-8000-000000000007', '11000000-0000-4000-8000-000000000004', 'active', '41000000-0000-4000-8000-000000000001', now(), NULL, NULL, NULL);

SELECT extensions.no_plan();

SELECT extensions.is(
  (SELECT count(*)::integer
   FROM app.teacher_student_bindings
   WHERE student_id = '11000000-0000-4000-8000-000000000011'),
  0,
  'approved student in an approved school has no fixture binding'
);

SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000001', 'login'), true, 'approved state is not overridden by an unapproved valid-until interpretation');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000001', 'read_saved_content'), true, 'approved student passes the account-level saved-content gate');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000001', 'edit_saved_content'), true, 'approved student passes the account-level edit gate');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000001', 'download_own_results'), true, 'approved student passes the own-results gate');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000001', 'submit_for_review'), true, 'approved student passes the account-level review-submission gate');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000001', 'public_deploy'), true, 'approved school passes only the account-level deploy gate');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000001', 'ai_call'), false, 'AI remains denied without a separately verified duty gate');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000002', 'login'), false, 'unconfirmed student school blocks login');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000002', 'read_saved_content'), false, 'unconfirmed school does not grant saved-content access');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000003', 'login'), true, 'withdrawn is distinct from unconfirmed for student login');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000003', 'read_saved_content'), true, 'withdrawn permits the modeled saved-content account gate');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000004', 'login'), true, 'expired is distinct from unconfirmed for student login');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000004', 'read_saved_content'), true, 'explicit expired state is not treated as unconfirmed');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000003', 'public_deploy'), false, 'withdrawn school blocks new public deployment');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000005', 'login'), false, 'disabled account is denied');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000006', 'login'), false, 'marked-deleted account is denied');
SELECT extensions.is(app.account_gate('ffffffff-ffff-4fff-8fff-ffffffffffff', 'login'), false, 'missing identity is denied');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000007', 'login'), true, 'approved teacher login does not depend on school lookup');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000008', 'login'), true, 'pending teacher may use the limited status-entry login gate');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000008', 'read_saved_content'), false, 'pending teacher login does not grant saved-content access');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000010', 'login'), true, 'rejected teacher may use the limited status-entry login gate');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000010', 'read_saved_content'), false, 'rejected teacher login does not grant saved-content access');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000007', 'read_saved_content'), false, 'teacher login does not grant student learning-data access');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000009', 'login'), true, 'approved administrator login is separate from student capabilities');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000009', 'read_saved_content'), false, 'no unapproved administrator resource capability is inferred');
SELECT extensions.is(app.account_gate('11000000-0000-4000-8000-000000000008', 'unsupported_capability'), false, 'unknown capability is denied');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000007', true);
SELECT set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000007","role":"authenticated"}', true);

SELECT extensions.is(
  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user),
  false,
  'RLS assertions do not run as superuser'
);
SELECT extensions.is(
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user),
  false,
  'RLS assertions use a non-BYPASSRLS role'
);
SELECT extensions.ok(
  (SELECT relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
   FROM pg_class WHERE oid = 'app.profiles'::regclass),
  'authenticated is not the profiles table owner'
);
SELECT extensions.is(
  (SELECT count(*)::integer
   FROM pg_class
   WHERE oid IN (
     'app.schools'::regclass,
     'app.profiles'::regclass,
     'app.teacher_school_memberships'::regclass,
     'app.teacher_student_bindings'::regclass,
     'app.audit_identity_map'::regclass,
     'app.audit_events'::regclass
   )
     AND relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)),
  0,
  'authenticated owns none of the forced-RLS foundation tables'
);
SELECT extensions.is(app.current_account_gate('login'), true, 'current identity is read from auth.uid');
SELECT extensions.is(app.current_account_gate('read_saved_content'), false, 'teacher identity cannot use student saved-content capability');
SELECT extensions.is(app.teacher_can_view_student('11000000-0000-4000-8000-000000000001'), true, 'active teacher binding allows only the defined relationship predicate');
SELECT extensions.is(app.teacher_can_view_student('11000000-0000-4000-8000-000000000002'), false, 'active binding does not bypass the unconfirmed school state');
SELECT extensions.is(app.teacher_can_view_student('11000000-0000-4000-8000-000000000003'), false, 'withdrawn-school teacher-view policy remains fail-closed while unresolved');
SELECT extensions.is(app.teacher_can_view_student('11000000-0000-4000-8000-000000000004'), false, 'expired-school teacher-view policy remains fail-closed while unresolved');
SELECT extensions.is(app.teacher_can_view_student('11000000-0000-4000-8000-000000000011'), false, 'approved student in an approved school is denied without an active teacher binding');
SELECT extensions.is((SELECT count(*)::integer FROM app.teacher_student_bindings), 1, 'teacher can see only the active allowed binding');
SELECT extensions.is((SELECT count(*)::integer FROM app.profiles WHERE id = '11000000-0000-4000-8000-000000000001'), 0, 'teacher relationship does not expose student profile data');
SELECT extensions.throws_ok(
  $$SELECT app.account_gate('11000000-0000-4000-8000-000000000001', 'login')$$,
  '42501',
  NULL,
  'authenticated cannot call the arbitrary-account internal gate'
);

RESET ROLE;
UPDATE app.schools
SET approval_state = 'unconfirmed'
WHERE id = '21000000-0000-4000-8000-000000000001';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000007', true);
SELECT set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000007","role":"authenticated"}', true);

SELECT set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SELECT extensions.is(app.current_account_gate('login'), false, 'student gate reads the changed school state immediately');

SELECT set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000007', true);
SELECT set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000007","role":"authenticated"}', true);
SELECT extensions.is(app.teacher_can_view_student('11000000-0000-4000-8000-000000000001'), false, 'current unconfirmed school state blocks teacher student access');
SELECT extensions.is((SELECT count(*)::integer FROM app.teacher_student_bindings), 0, 'current unconfirmed school state hides the binding');

RESET ROLE;
UPDATE app.schools
SET approval_state = 'approved'
WHERE id = '21000000-0000-4000-8000-000000000001';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000007', true);
SELECT set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000007","role":"authenticated"}', true);

SELECT extensions.is(app.teacher_can_view_student('11000000-0000-4000-8000-000000000001'), true, 'current approved school state restores only the bounded relationship predicate');

RESET ROLE;
UPDATE app.profiles SET status = 'disabled' WHERE id = '11000000-0000-4000-8000-000000000001';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

SELECT extensions.is(app.current_account_gate('login'), false, 'existing identity cannot access after account disablement');
SELECT extensions.is((SELECT count(*)::integer FROM app.profiles), 0, 'disabled identity cannot read its prior profile');

RESET ROLE;
UPDATE app.profiles
SET status = 'approved', deletion_state = 'purging'
WHERE id = '11000000-0000-4000-8000-000000000001';

SET LOCAL ROLE authenticated;
SELECT extensions.is(app.current_account_gate('login'), false, 'existing identity cannot access during deletion');
SELECT extensions.is((SELECT count(*)::integer FROM app.profiles), 0, 'deleting identity cannot read its prior profile');

RESET ROLE;
UPDATE app.profiles
SET deletion_state = 'none'
WHERE id = '11000000-0000-4000-8000-000000000001';

UPDATE app.profiles
SET status = 'disabled'
WHERE id = '11000000-0000-4000-8000-000000000001';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000007', true);
SELECT set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000007","role":"authenticated"}', true);

SELECT extensions.is(app.teacher_can_view_student('11000000-0000-4000-8000-000000000001'), false, 'disabled student is frozen from teacher access');
SELECT extensions.is((SELECT count(*)::integer FROM app.teacher_student_bindings), 0, 'teacher cannot see the disabled student binding');

RESET ROLE;
UPDATE app.profiles
SET status = 'approved'
WHERE id = '11000000-0000-4000-8000-000000000001';
UPDATE app.teacher_student_bindings
SET state = 'ended', ended_at = now(), end_reason = 'admin_unbind'
WHERE id = '31000000-0000-4000-8000-000000000001';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000007', true);
SELECT set_config('request.jwt.claims', '{"sub":"11000000-0000-4000-8000-000000000007","role":"authenticated"}', true);

SELECT extensions.is(app.teacher_can_view_student('11000000-0000-4000-8000-000000000001'), false, 'ending a binding immediately denies the teacher relationship');
SELECT extensions.is((SELECT count(*)::integer FROM app.teacher_student_bindings), 0, 'ended binding is no longer visible to the teacher');

RESET ROLE;
SELECT * FROM extensions.finish();
ROLLBACK;
