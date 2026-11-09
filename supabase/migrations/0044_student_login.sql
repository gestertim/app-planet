-- AP-A1-ISO-20261109：僅隔離合成驗收，不是正式核發／重發。
BEGIN;

CREATE ROLE app_student_login_lookup_owner
  NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE app_student_login_runtime
  LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

CREATE TABLE app.student_login_credentials (
  student_id uuid PRIMARY KEY REFERENCES app.profiles(id),
  auth_email_alias text NOT NULL UNIQUE CHECK (
    auth_email_alias ~ '^ap-[0-9a-f-]{36}@example[.]invalid$'
  ),
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('active', 'revoked'))
);
ALTER TABLE app.student_login_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.student_login_credentials FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.student_login_credentials FROM PUBLIC, anon, authenticated, service_role,
  app_student_login_lookup_owner, app_student_login_runtime;
REVOKE ALL ON SCHEMA app FROM app_student_login_runtime;
GRANT USAGE ON SCHEMA app, extensions TO app_student_login_lookup_owner;
GRANT USAGE ON TYPE app.account_role, extensions.citext TO app_student_login_lookup_owner;
GRANT SELECT (id, handle, role) ON app.profiles TO app_student_login_lookup_owner;
GRANT SELECT (student_id, auth_email_alias, version, state)
  ON app.student_login_credentials TO app_student_login_lookup_owner;

CREATE POLICY student_login_lookup_profiles ON app.profiles FOR SELECT
  TO app_student_login_lookup_owner USING (role = 'student');
CREATE POLICY student_login_lookup_credentials ON app.student_login_credentials FOR SELECT
  TO app_student_login_lookup_owner USING (
    EXISTS (SELECT 1 FROM app.profiles p WHERE p.id = student_id AND p.role = 'student')
  );

CREATE FUNCTION app.lookup_student_login(lookup_handle text)
RETURNS TABLE(student_id uuid, auth_email_alias text, version integer, state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT c.student_id, c.auth_email_alias, c.version, c.state
  FROM app.profiles p
  JOIN app.student_login_credentials c ON c.student_id = p.id
  WHERE p.handle OPERATOR(extensions.=) lookup_handle::extensions.citext
    AND p.role = 'student'
$$;
ALTER FUNCTION app.lookup_student_login(text) OWNER TO app_student_login_lookup_owner;
REVOKE ALL ON FUNCTION app.lookup_student_login(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA app TO app_student_login_runtime;
GRANT EXECUTE ON FUNCTION app.lookup_student_login(text) TO app_student_login_runtime;
DO $$
BEGIN
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO app_student_login_runtime',
    pg_catalog.current_database());
END
$$;
COMMIT;
