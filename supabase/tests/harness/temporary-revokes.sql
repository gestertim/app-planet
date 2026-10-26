DO $revoke_runner_grants$
DECLARE
  granted_privilege record;
BEGIN
  IF to_regclass('pgtap_runner.temporary_grants') IS NOT NULL THEN
    FOR granted_privilege IN
      SELECT grant_kind, grantee, object_identity
      FROM pgtap_runner.temporary_grants
      WHERE granted_by_runner
    LOOP
      IF granted_privilege.grant_kind = 'schema_usage' THEN
        EXECUTE format('REVOKE USAGE ON SCHEMA extensions FROM %I', granted_privilege.grantee);
      ELSIF granted_privilege.grant_kind = 'function_execute' THEN
        EXECUTE format(
          'REVOKE EXECUTE ON FUNCTION %s FROM %I',
          granted_privilege.object_identity::oid::regprocedure,
          granted_privilege.grantee
        );
      ELSIF granted_privilege.grant_kind = 'role_membership' THEN
        EXECUTE format('REVOKE app_audit_writer FROM %I', granted_privilege.grantee);
        IF granted_privilege.object_identity <> 'absent' THEN
          EXECUTE format(
            'GRANT app_audit_writer TO %I WITH ADMIN %s, INHERIT %s, SET %s',
            granted_privilege.grantee,
            split_part(granted_privilege.object_identity, '|', 1),
            split_part(granted_privilege.object_identity, '|', 2),
            split_part(granted_privilege.object_identity, '|', 3)
          );
        END IF;
      ELSE
        RAISE EXCEPTION 'unknown temporary grant kind: %', granted_privilege.grant_kind;
      END IF;
    END LOOP;

    DROP SCHEMA pgtap_runner CASCADE;
  END IF;
END
$revoke_runner_grants$;
