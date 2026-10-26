BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

-- 僅直接建立合成 Auth 資料列供 FK/RLS 測試，不執行 Supabase Auth 流程。
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'local-t007-student@example.invalid', '{}', '{}', now(), now()),
  ('10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'local-t007-teacher@example.invalid', '{}', '{}', now(), now()),
  ('10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'local-t007-other-student@example.invalid', '{}', '{}', now(), now()),
  ('10000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'local-t007-admin@example.invalid', '{}', '{}', now(), now());

INSERT INTO app.schools (id, label, approval_state, approval_epoch, created_at, updated_at)
VALUES
  ('20000000-0000-4000-8000-000000000001', 'synthetic-school-a', 'approved', 1, now(), now()),
  ('20000000-0000-4000-8000-000000000002', 'synthetic-school-b', 'approved', 1, now(), now());

INSERT INTO app.profiles (
  id, role, status, deletion_state, school_id, handle, display_label, status_changed_at
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'student', 'approved', 'none', '20000000-0000-4000-8000-000000000001', 'local_student_a', 'synthetic-student-a', now()),
  ('10000000-0000-4000-8000-000000000002', 'teacher', 'approved', 'none', NULL, NULL, 'synthetic-teacher-a', now()),
  ('10000000-0000-4000-8000-000000000003', 'student', 'approved', 'none', '20000000-0000-4000-8000-000000000002', 'local_student_b', 'synthetic-student-b', now()),
  ('10000000-0000-4000-8000-000000000004', 'admin', 'approved', 'none', NULL, NULL, 'synthetic-admin', now());

INSERT INTO app.teacher_school_memberships (
  id, teacher_id, school_id, state, created_by_aid, created_at, ended_at
) VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'active', '40000000-0000-4000-8000-000000000001', now(), NULL),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'ended', '40000000-0000-4000-8000-000000000001', now(), now());

INSERT INTO app.teacher_student_bindings (
  id, teacher_id, student_id, state, created_by_aid, created_at, ended_at, ended_by_aid, end_reason
) VALUES
  ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'active', '40000000-0000-4000-8000-000000000001', now(), NULL, NULL, NULL),
  ('50000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 'ended', '40000000-0000-4000-8000-000000000001', now(), now(), '40000000-0000-4000-8000-000000000001', 'admin_unbind');

INSERT INTO app.audit_identity_map (aid, account_id, created_at)
VALUES ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004', now());

SELECT extensions.no_plan();

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
     AND relrowsecurity
     AND relforcerowsecurity),
  6,
  'every foundation table enables and forces RLS'
);
SELECT extensions.ok(NOT has_table_privilege('anon', 'app.audit_identity_map', 'SELECT'), 'anon cannot read audit identity mapping');
SELECT extensions.ok(NOT has_table_privilege('anon', 'app.audit_identity_map', 'INSERT'), 'anon cannot write audit identity mapping');
SELECT extensions.ok(NOT has_table_privilege('anon', 'app.audit_events', 'SELECT'), 'anon cannot read audit events');
SELECT extensions.ok(NOT has_table_privilege('anon', 'app.audit_events', 'INSERT'), 'anon cannot append audit events');
SELECT extensions.ok(NOT has_table_privilege('anon', 'app.audit_events', 'UPDATE'), 'anon cannot update audit events');
SELECT extensions.ok(NOT has_table_privilege('anon', 'app.audit_events', 'DELETE'), 'anon cannot delete audit events');
SELECT extensions.is(pg_has_role('anon', 'app_audit_writer', 'MEMBER'), false, 'anon cannot assume audit-writer role');
SELECT extensions.is(pg_has_role('authenticated', 'app_audit_writer', 'MEMBER'), false, 'authenticated cannot assume audit-writer role');
SELECT extensions.is(pg_has_role('service_role', 'app_audit_writer', 'MEMBER'), false, 'service_role is not granted audit-writer membership');
SELECT extensions.throws_ok(
  $$UPDATE app.profiles SET school_id = NULL WHERE id = '10000000-0000-4000-8000-000000000001'$$,
  '23514',
  NULL,
  'student profile requires its modeled school relationship'
);
SELECT extensions.throws_ok(
  $$UPDATE app.profiles SET handle = 'LOCAL_STUDENT_A' WHERE id = '10000000-0000-4000-8000-000000000002'$$,
  '23505',
  NULL,
  'student handle uniqueness is case insensitive'
);
SELECT extensions.throws_ok(
  $$INSERT INTO app.teacher_school_memberships (id, teacher_id, school_id, state, created_by_aid, created_at) VALUES ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'active', '40000000-0000-4000-8000-000000000001', now())$$,
  '23505',
  NULL,
  'a teacher-school pair cannot have two active affiliations'
);
SELECT extensions.throws_ok(
  $$INSERT INTO app.teacher_student_bindings (id, teacher_id, student_id, state, created_by_aid, created_at) VALUES ('50000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'active', '40000000-0000-4000-8000-000000000001', now())$$,
  '23505',
  NULL,
  'a teacher-student pair cannot have two active bindings'
);
SELECT extensions.throws_ok(
  $$INSERT INTO app.audit_identity_map (aid, account_id, created_at) VALUES ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000004', now())$$,
  '23505',
  NULL,
  'each account maps to one audit identity'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

SELECT extensions.is(current_user::text, 'authenticated', 'RLS checks run as authenticated');
SELECT extensions.is(
  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user),
  false,
  'RLS checks do not run as superuser'
);
SELECT extensions.is(
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user),
  false,
  'authenticated is not a BYPASSRLS role'
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
SELECT extensions.is(
  (SELECT count(*)::integer FROM app.profiles),
  1,
  'student reads only their own profile'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM app.profiles WHERE id = '10000000-0000-4000-8000-000000000003'),
  0,
  'student cannot read another account profile'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM app.schools),
  1,
  'student reads only their own school'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM app.teacher_school_memberships),
  0,
  'student cannot read teacher affiliations'
);
SELECT extensions.throws_ok(
  $$UPDATE app.profiles SET role = 'admin' WHERE id = auth.uid()$$,
  '42501',
  NULL,
  'student cannot promote their own role'
);
SELECT extensions.throws_ok(
  $$UPDATE app.profiles SET status = 'approved' WHERE id = auth.uid()$$,
  '42501',
  NULL,
  'student cannot change account approval status'
);
SELECT extensions.throws_ok(
  $$UPDATE app.profiles SET deletion_state = 'none' WHERE id = auth.uid()$$,
  '42501',
  NULL,
  'student cannot change deletion state'
);
SELECT extensions.throws_ok(
  $$UPDATE app.schools SET approval_state = 'approved' WHERE id = '20000000-0000-4000-8000-000000000002'$$,
  '42501',
  NULL,
  'student cannot approve a school'
);
SELECT extensions.throws_ok(
  $$INSERT INTO app.teacher_school_memberships (id, teacher_id, school_id, state, created_by_aid, created_at) VALUES ('30000000-0000-4000-8000-000000000003', auth.uid(), '20000000-0000-4000-8000-000000000002', 'active', '40000000-0000-4000-8000-000000000001', now())$$,
  '42501',
  NULL,
  'student cannot create teacher affiliation'
);
SELECT extensions.throws_ok(
  $$INSERT INTO app.teacher_student_bindings (id, teacher_id, student_id, state, created_by_aid, created_at) VALUES ('50000000-0000-4000-8000-000000000003', auth.uid(), auth.uid(), 'active', '40000000-0000-4000-8000-000000000001', now())$$,
  '42501',
  NULL,
  'student cannot create a binding'
);
SELECT extensions.throws_ok(
  $$SELECT * FROM app.audit_identity_map$$,
  '42501',
  NULL,
  'student cannot read audit identity mapping'
);
SELECT extensions.throws_ok(
  $$INSERT INTO app.audit_identity_map (aid, account_id, created_at) VALUES ('40000000-0000-4000-8000-000000000002', auth.uid(), now())$$,
  '42501',
  NULL,
  'student cannot write audit identity mapping'
);
SELECT extensions.throws_ok(
  $$UPDATE app.audit_identity_map SET account_id = auth.uid()$$,
  '42501',
  NULL,
  'student cannot update audit identity mapping'
);
SELECT extensions.throws_ok(
  $$DELETE FROM app.audit_identity_map$$,
  '42501',
  NULL,
  'student cannot delete audit identity mapping'
);
SELECT extensions.throws_ok(
  $$SELECT * FROM app.audit_events$$,
  '42501',
  NULL,
  'student cannot read audit events'
);
SELECT extensions.throws_ok(
  $$INSERT INTO app.audit_events (id, at, actor_aid, action, object_type, result, meta) VALUES ('60000000-0000-4000-8000-000000000001', now(), '40000000-0000-4000-8000-000000000001', 'teacher_view', 'project', 'ok', '{}')$$,
  '42501',
  NULL,
  'student cannot append arbitrary audit events'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

SELECT extensions.is(
  (SELECT count(*)::integer FROM app.teacher_school_memberships),
  1,
  'teacher reads only active own school affiliation'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM app.schools),
  1,
  'teacher reads only an actively affiliated school'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM app.teacher_student_bindings),
  1,
  'teacher reads an active binding to an approved student'
);
SELECT extensions.is(
  app.teacher_can_view_student('10000000-0000-4000-8000-000000000001'),
  true,
  'active binding allows the bounded teacher relationship check'
);
SELECT extensions.is(
  app.teacher_can_view_student('10000000-0000-4000-8000-000000000003'),
  false,
  'ended cross-school binding does not grant access'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM app.profiles WHERE id = '10000000-0000-4000-8000-000000000001'),
  0,
  'teacher cannot read a student profile through the binding'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000004', true);
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}', true);

SELECT extensions.is(app.current_account_gate('login'), true, 'approved administrator can pass the login gate');
SELECT extensions.is((SELECT count(*)::integer FROM app.schools), 0, 'administrator has no unimplemented school-management access');
SELECT extensions.is((SELECT count(*)::integer FROM app.teacher_student_bindings), 0, 'administrator has no unimplemented student-data access');
SELECT extensions.throws_ok(
  $$SELECT app.account_gate('10000000-0000-4000-8000-000000000001', 'login')$$,
  '42501',
  NULL,
  'general role cannot probe another account through the internal gate'
);

RESET ROLE;
SET LOCAL ROLE app_audit_writer;

SELECT extensions.is(current_user::text, 'app_audit_writer', 'append uses the dedicated non-login database role');
SELECT extensions.is(
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user),
  false,
  'audit writer does not bypass RLS'
);
SELECT extensions.is(
  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user),
  false,
  'audit writer is not a superuser'
);
SELECT extensions.is(
  (SELECT rolcanlogin FROM pg_roles WHERE rolname = current_user),
  false,
  'audit writer cannot log in'
);
SELECT extensions.is(
  (SELECT rolinherit FROM pg_roles WHERE rolname = current_user),
  false,
  'audit writer does not inherit privileges'
);
SELECT extensions.ok(
  (SELECT relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
   FROM pg_class WHERE oid = 'app.audit_events'::regclass),
  'audit writer is not the audit table owner'
);
SELECT extensions.ok(has_table_privilege(current_user, 'app.audit_events', 'INSERT'), 'audit writer can append');
SELECT extensions.ok(NOT has_table_privilege(current_user, 'app.audit_events', 'SELECT'), 'audit writer cannot read audit history');
SELECT extensions.ok(NOT has_table_privilege(current_user, 'app.audit_events', 'UPDATE'), 'audit writer cannot update audit events');
SELECT extensions.ok(NOT has_table_privilege(current_user, 'app.audit_events', 'DELETE'), 'audit writer cannot delete audit events');
SELECT extensions.lives_ok(
  $$INSERT INTO app.audit_events (id, at, actor_aid, subject_aid, action, object_type, object_ref, school_id, result, meta)
    VALUES ('60000000-0000-4000-8000-000000000002', now(), '40000000-0000-4000-8000-000000000001', NULL, 'teacher_view', 'project', NULL, '20000000-0000-4000-8000-000000000001', 'ok', '{}')$$,
  'dedicated audit writer can append the explicitly modeled action without content'
);
SELECT extensions.throws_ok(
  $$UPDATE app.audit_events SET result = 'denied' WHERE id = '60000000-0000-4000-8000-000000000002'$$,
  '42501',
  NULL,
  'audit writer cannot update an appended event'
);
SELECT extensions.throws_ok(
  $$DELETE FROM app.audit_events WHERE id = '60000000-0000-4000-8000-000000000002'$$,
  '42501',
  NULL,
  'audit writer cannot delete an appended event'
);
SELECT extensions.throws_ok(
  $$INSERT INTO app.audit_events (id, at, actor_aid, action, object_type, result, meta)
    VALUES ('60000000-0000-4000-8000-000000000003', now(), '40000000-0000-4000-8000-000000000001', 'account_approved', 'project', 'ok', '{}')$$,
  '23514',
  NULL,
  'append role cannot invent an unmodeled audit action'
);
SELECT extensions.throws_ok(
  $$INSERT INTO app.audit_events (id, at, actor_aid, action, object_type, result, meta)
    VALUES ('60000000-0000-4000-8000-000000000004', now(), '40000000-0000-4000-8000-000000000001', 'teacher_view', 'project', 'ok', '{"body":"not allowed"}')$$,
  '23514',
  NULL,
  'audit metadata cannot contain unapproved content'
);

RESET ROLE;

-- T007 補強：逐表最小權限、跨帳號隔離與教師不可自行改關係／角色。
SELECT extensions.is(
  (SELECT count(*)::integer
   FROM unnest(ARRAY[
     'app.schools', 'app.profiles', 'app.teacher_school_memberships',
     'app.teacher_student_bindings', 'app.audit_identity_map', 'app.audit_events'
   ]) AS t(name)
   CROSS JOIN unnest(ARRAY['authenticated', 'anon', 'service_role']) AS r(name)
   CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(name)
   WHERE has_table_privilege(r.name, t.name, p.name)),
  0,
  'client and service roles hold no write privilege on any identity or audit foundation table'
);
SELECT extensions.is(
  (SELECT count(*)::integer
   FROM unnest(ARRAY[
     'app.schools', 'app.profiles', 'app.teacher_school_memberships',
     'app.teacher_student_bindings', 'app.audit_identity_map', 'app.audit_events'
   ]) AS t(name)
   WHERE has_table_privilege('anon', t.name, 'SELECT')),
  0,
  'anon cannot read any identity or audit foundation table'
);
SELECT extensions.is(
  (SELECT count(*)::integer
   FROM unnest(ARRAY['app.audit_identity_map', 'app.audit_events']) AS t(name)
   WHERE has_table_privilege('authenticated', t.name, 'SELECT')),
  0,
  'authenticated cannot read audit identity mapping or audit events'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated"}', true);

SELECT extensions.is((SELECT count(*)::integer FROM app.profiles), 1, 'second student reads only their own profile');
SELECT extensions.is(
  (SELECT count(*)::integer FROM app.profiles WHERE id = '10000000-0000-4000-8000-000000000001'),
  0,
  'second student cannot read the first student profile'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM app.schools WHERE id = '20000000-0000-4000-8000-000000000001'),
  0,
  'second student cannot read the first student school'
);
SELECT extensions.is(
  (SELECT count(*)::integer FROM app.teacher_student_bindings),
  0,
  'a student cannot read teacher-student bindings'
);
SELECT extensions.throws_ok(
  $$UPDATE app.profiles SET display_label = 'synthetic-overwrite' WHERE id = '10000000-0000-4000-8000-000000000001'$$,
  '42501',
  NULL,
  'second student cannot update another student profile'
);
SELECT extensions.throws_ok(
  $$DELETE FROM app.profiles WHERE id = '10000000-0000-4000-8000-000000000001'$$,
  '42501',
  NULL,
  'second student cannot delete another student profile'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
SELECT set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

SELECT extensions.throws_ok(
  $$UPDATE app.teacher_student_bindings SET state = 'active' WHERE id = '50000000-0000-4000-8000-000000000002'$$,
  '42501',
  NULL,
  'teacher cannot reactivate an ended binding'
);
SELECT extensions.throws_ok(
  $$DELETE FROM app.teacher_student_bindings WHERE id = '50000000-0000-4000-8000-000000000001'$$,
  '42501',
  NULL,
  'teacher cannot delete their own binding'
);
SELECT extensions.throws_ok(
  $$INSERT INTO app.teacher_student_bindings (id, teacher_id, student_id, state, created_by_aid, created_at) VALUES ('50000000-0000-4000-8000-000000000004', auth.uid(), '10000000-0000-4000-8000-000000000003', 'active', '40000000-0000-4000-8000-000000000001', now())$$,
  '42501',
  NULL,
  'teacher cannot bind themselves to another student'
);
SELECT extensions.throws_ok(
  $$UPDATE app.profiles SET role = 'admin' WHERE id = auth.uid()$$,
  '42501',
  NULL,
  'teacher cannot promote their own role'
);
SELECT extensions.throws_ok(
  $$UPDATE app.profiles SET status = 'approved' WHERE id = '10000000-0000-4000-8000-000000000001'$$,
  '42501',
  NULL,
  'teacher cannot change another account status'
);
SELECT extensions.throws_ok(
  $$INSERT INTO app.teacher_school_memberships (id, teacher_id, school_id, state, created_by_aid, created_at) VALUES ('30000000-0000-4000-8000-000000000004', auth.uid(), '20000000-0000-4000-8000-000000000002', 'active', '40000000-0000-4000-8000-000000000001', now())$$,
  '42501',
  NULL,
  'teacher cannot add their own school affiliation'
);
SELECT extensions.throws_ok($$SELECT * FROM app.audit_identity_map$$, '42501', NULL, 'teacher cannot read audit identity mapping');
SELECT extensions.throws_ok($$SELECT * FROM app.audit_events$$, '42501', NULL, 'teacher cannot read audit events');

RESET ROLE;
SELECT * FROM extensions.finish();
ROLLBACK;
