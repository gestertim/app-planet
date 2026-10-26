BEGIN;

CREATE SCHEMA pgtap_runner;
REVOKE ALL ON SCHEMA pgtap_runner FROM PUBLIC;

CREATE TABLE pgtap_runner.temporary_grants (
  grant_kind text NOT NULL,
  grantee name NOT NULL,
  object_identity text NOT NULL,
  granted_by_runner boolean NOT NULL,
  PRIMARY KEY (grant_kind, grantee, object_identity)
);
REVOKE ALL ON TABLE pgtap_runner.temporary_grants FROM PUBLIC;

DO $grant_membership$
DECLARE
  prior_membership pg_auth_members%ROWTYPE;
  membership_exists boolean;
  prior_options text;
BEGIN
  SELECT membership.*
  INTO prior_membership
  FROM pg_auth_members AS membership
  JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
  JOIN pg_roles AS member_role ON member_role.oid = membership.member
  WHERE granted_role.rolname = 'app_audit_writer'
    AND member_role.rolname = 'postgres';
  membership_exists := FOUND;

  IF membership_exists AND prior_membership.set_option THEN
    RAISE EXCEPTION 'postgres already has SET ability for app_audit_writer';
  END IF;

  prior_options := CASE
    WHEN membership_exists THEN format(
      '%s|%s|%s',
      CASE WHEN prior_membership.admin_option THEN 'TRUE' ELSE 'FALSE' END,
      CASE WHEN prior_membership.inherit_option THEN 'TRUE' ELSE 'FALSE' END,
      CASE WHEN prior_membership.set_option THEN 'TRUE' ELSE 'FALSE' END
    )
    ELSE 'absent'
  END;
  INSERT INTO pgtap_runner.temporary_grants
    (grant_kind, grantee, object_identity, granted_by_runner)
  VALUES ('role_membership', 'postgres', prior_options, true);

  IF membership_exists THEN
    EXECUTE format(
      'GRANT app_audit_writer TO postgres WITH ADMIN %s, INHERIT %s, SET TRUE',
      CASE WHEN prior_membership.admin_option THEN 'TRUE' ELSE 'FALSE' END,
      CASE WHEN prior_membership.inherit_option THEN 'TRUE' ELSE 'FALSE' END
    );
  ELSE
    EXECUTE 'GRANT app_audit_writer TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE';
  END IF;
END
$grant_membership$;

INSERT INTO pgtap_runner.temporary_grants
  (grant_kind, grantee, object_identity, granted_by_runner)
SELECT
  'schema_usage',
  r.rolname,
  'extensions',
  NOT has_schema_privilege(r.rolname, 'extensions', 'USAGE')
FROM pg_roles AS r
WHERE r.rolname = ANY (ARRAY['authenticated', 'app_audit_writer']);

DO $grant_schema$
DECLARE
  missing_grant record;
BEGIN
  FOR missing_grant IN
    SELECT grantee
    FROM pgtap_runner.temporary_grants
    WHERE grant_kind = 'schema_usage'
      AND granted_by_runner
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA extensions TO %I', missing_grant.grantee);
  END LOOP;
END
$grant_schema$;

INSERT INTO pgtap_runner.temporary_grants
  (grant_kind, grantee, object_identity, granted_by_runner)
SELECT
  'function_execute',
  r.rolname,
  p.oid::text,
  NOT has_function_privilege(r.rolname, p.oid, 'EXECUTE')
FROM pg_roles AS r
CROSS JOIN pg_proc AS p
JOIN pg_namespace AS namespace ON namespace.oid = p.pronamespace
WHERE r.rolname = ANY (ARRAY['authenticated', 'app_audit_writer'])
  AND namespace.nspname = 'extensions'
  AND (
    p.oid = to_regprocedure('extensions.finish(boolean)')
    OR p.oid = to_regprocedure('extensions.is(anyelement,anyelement,text)')
    OR p.oid = to_regprocedure('extensions.lives_ok(text,text)')
    OR p.oid = to_regprocedure('extensions.no_plan()')
    OR p.oid = to_regprocedure('extensions.ok(boolean,text)')
    OR p.oid = to_regprocedure('extensions.throws_ok(text,character,text,text)')
  );

DO $grant_pgtap$
DECLARE
  missing_grant record;
BEGIN
  FOR missing_grant IN
    SELECT grantee, object_identity
    FROM pgtap_runner.temporary_grants
    WHERE grant_kind = 'function_execute'
      AND granted_by_runner
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO %I',
      missing_grant.object_identity::oid::regprocedure,
      missing_grant.grantee
    );
  END LOOP;
END
$grant_pgtap$;

COMMIT;
