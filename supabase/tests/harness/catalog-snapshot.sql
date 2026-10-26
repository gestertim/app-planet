WITH selected_roles AS (
  SELECT oid, rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolbypassrls
  FROM pg_roles
  WHERE rolname = ANY (ARRAY[
    'anon',
    'authenticated',
    'app_audit_writer',
    'postgres',
    'service_role',
    'supabase_admin'
  ])
),
app_tables AS (
  SELECT relation.oid, format('%I.%I', namespace.nspname, relation.relname) AS table_name
  FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'app'
    AND relation.relkind IN ('r', 'p')
),
table_privileges AS (
  SELECT
    'app_table_privilege'::text AS category,
    selected_roles.rolname::text AS identity,
    format('%s.%s', app_tables.table_name, privilege_name)::text AS item,
    has_table_privilege(selected_roles.rolname, app_tables.oid, privilege_name)::text AS value
  FROM selected_roles
  CROSS JOIN app_tables
  CROSS JOIN unnest(ARRAY[
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'REFERENCES',
    'TRIGGER'
  ]) AS privilege_name
),
schema_privileges AS (
  SELECT
    'schema_privilege'::text AS category,
    selected_roles.rolname::text AS identity,
    privilege_name::text AS item,
    has_schema_privilege(selected_roles.rolname, 'extensions', privilege_name)::text AS value
  FROM selected_roles
  CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']) AS privilege_name
),
role_memberships AS (
  SELECT
    'role_membership'::text AS category,
    selected_roles.rolname::text AS identity,
    'app_audit_writer'::text AS item,
    CASE
      WHEN membership.roleid IS NULL THEN 'absent'
      ELSE concat_ws(
        '|',
        membership.admin_option::text,
        membership.inherit_option::text,
        membership.set_option::text
      )
    END::text AS value
  FROM selected_roles
  LEFT JOIN pg_roles AS writer_role ON writer_role.rolname = 'app_audit_writer'
  LEFT JOIN pg_auth_members AS membership
    ON membership.roleid = writer_role.oid
   AND membership.member = selected_roles.oid
),
role_attributes AS (
  SELECT
    'role_attributes'::text AS category,
    rolname::text AS identity,
    'flags'::text AS item,
    concat_ws(
      '|',
      rolsuper,
      rolinherit,
      rolcreaterole,
      rolcreatedb,
      rolcanlogin,
      rolbypassrls
    )::text AS value
  FROM selected_roles
),
pgtap_privileges AS (
  SELECT
    'pgtap_function'::text AS category,
    selected_roles.rolname::text AS identity,
    p.oid::regprocedure::text AS item,
    has_function_privilege(selected_roles.rolname, p.oid, 'EXECUTE')::text AS value
  FROM selected_roles
  CROSS JOIN pg_proc AS p
  JOIN pg_namespace AS namespace ON namespace.oid = p.pronamespace
  WHERE namespace.nspname = 'extensions'
    AND (
      p.oid = to_regprocedure('extensions.finish(boolean)')
      OR p.oid = to_regprocedure('extensions.is(anyelement,anyelement,text)')
      OR p.oid = to_regprocedure('extensions.lives_ok(text,text)')
      OR p.oid = to_regprocedure('extensions.no_plan()')
      OR p.oid = to_regprocedure('extensions.ok(boolean,text)')
      OR p.oid = to_regprocedure('extensions.throws_ok(text,character,text,text)')
    )
)
SELECT category, identity, item, value FROM table_privileges
UNION ALL
SELECT category, identity, item, value FROM schema_privileges
UNION ALL
SELECT category, identity, item, value FROM role_memberships
UNION ALL
SELECT category, identity, item, value FROM role_attributes
UNION ALL
SELECT category, identity, item, value FROM pgtap_privileges
ORDER BY category, identity, item, value;
