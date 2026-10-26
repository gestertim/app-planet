-- 僅供 §33 明確隔離的本機合成測試；不是正式環境部署 migration。
-- M1 歸屬表僅為本機結構，不包含真實歸屬管理或寫入流程。
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS extensions;

REVOKE CREATE ON SCHEMA app FROM PUBLIC, anon, authenticated, service_role;

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions;

CREATE TYPE app.account_role AS ENUM ('student', 'teacher', 'admin');
CREATE TYPE app.account_status AS ENUM ('pending', 'approved', 'rejected', 'disabled');
CREATE TYPE app.deletion_state AS ENUM ('none', 'marked', 'purging', 'purge_failed', 'purged');
CREATE TYPE app.school_approval_state AS ENUM ('unconfirmed', 'approved', 'withdrawn', 'expired');
CREATE TYPE app.binding_state AS ENUM ('active', 'ended');
CREATE TYPE app.audit_result AS ENUM ('ok', 'denied', 'failed');

CREATE TABLE app.schools (
  id uuid PRIMARY KEY,
  label text NOT NULL,
  approval_state app.school_approval_state NOT NULL DEFAULT 'unconfirmed',
  approval_epoch bigint NOT NULL,
  valid_until timestamptz NULL,
  current_doc_version text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE app.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id),
  role app.account_role NOT NULL,
  status app.account_status NOT NULL,
  deletion_state app.deletion_state NOT NULL,
  school_id uuid NULL REFERENCES app.schools (id),
  handle extensions.citext NULL UNIQUE,
  display_label text,
  initiated_by uuid NULL,
  status_changed_at timestamptz NOT NULL,
  CONSTRAINT profiles_student_school_required
    CHECK (role <> 'student' OR school_id IS NOT NULL)
);

CREATE TABLE app.teacher_school_memberships (
  id uuid PRIMARY KEY,
  teacher_id uuid NOT NULL REFERENCES app.profiles (id),
  school_id uuid NOT NULL REFERENCES app.schools (id),
  state app.binding_state NOT NULL,
  created_by_aid uuid NOT NULL,
  created_at timestamptz NOT NULL,
  ended_at timestamptz NULL,
  ended_by_aid uuid NULL
);

CREATE UNIQUE INDEX teacher_school_memberships_one_active
  ON app.teacher_school_memberships (teacher_id, school_id)
  WHERE state = 'active';

CREATE TABLE app.teacher_student_bindings (
  id uuid PRIMARY KEY,
  teacher_id uuid NOT NULL REFERENCES app.profiles (id),
  student_id uuid NOT NULL REFERENCES app.profiles (id),
  state app.binding_state NOT NULL,
  created_by_aid uuid NOT NULL,
  created_at timestamptz NOT NULL,
  ended_at timestamptz NULL,
  ended_by_aid uuid NULL,
  end_reason text NULL
);

CREATE UNIQUE INDEX teacher_student_bindings_one_active
  ON app.teacher_student_bindings (teacher_id, student_id)
  WHERE state = 'active';

CREATE TABLE app.audit_identity_map (
  aid uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES app.profiles (id),
  created_at timestamptz NOT NULL
);

CREATE TABLE app.audit_events (
  id uuid PRIMARY KEY,
  at timestamptz NOT NULL,
  actor_aid uuid NOT NULL,
  subject_aid uuid NULL,
  action text NOT NULL CHECK (action = 'teacher_view'),
  object_type text NOT NULL CHECK (object_type IN ('project', 'conversation', 'file', 'activity')),
  object_ref uuid NULL,
  school_id uuid NULL REFERENCES app.schools (id),
  result app.audit_result NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (meta = '{}'::jsonb)
);

CREATE ROLE app_audit_writer WITH NOLOGIN NOINHERIT NOBYPASSRLS;
REVOKE CREATE ON SCHEMA app FROM app_audit_writer;

ALTER TABLE app.schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.schools FORCE ROW LEVEL SECURITY;
ALTER TABLE app.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.teacher_school_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.teacher_school_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE app.teacher_student_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.teacher_student_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.audit_identity_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_identity_map FORCE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_events_append
  ON app.audit_events
  FOR INSERT
  TO app_audit_writer
  WITH CHECK (true);

REVOKE ALL ON ALL TABLES IN SCHEMA app
  FROM PUBLIC, anon, authenticated, service_role, app_audit_writer;

GRANT USAGE ON SCHEMA app TO authenticated, service_role, app_audit_writer;
GRANT USAGE ON TYPE
  app.account_role,
  app.account_status,
  app.deletion_state,
  app.school_approval_state,
  app.binding_state,
  app.audit_result
  TO authenticated, service_role, app_audit_writer;
GRANT SELECT ON app.schools, app.profiles, app.teacher_school_memberships, app.teacher_student_bindings
  TO authenticated;
GRANT SELECT ON app.audit_identity_map, app.audit_events TO service_role;
GRANT INSERT ON app.audit_events TO app_audit_writer;
