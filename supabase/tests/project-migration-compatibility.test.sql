BEGIN;

SELECT extensions.no_plan();

SELECT extensions.is(
  (SELECT count(*)::integer FROM app.projects WHERE id IN (
    '79000000-0000-4000-8000-000000000001',
    '79000000-0000-4000-8000-000000000002',
    '79000000-0000-4000-8000-000000000003',
    '79000000-0000-4000-8000-000000000004',
    '79000000-0000-4000-8000-000000000005',
    '79000000-0000-4000-8000-000000000006'
  )),
  6,
  '0009 historical rows remain present after applying 0010'
);

SELECT extensions.is(
  (SELECT jsonb_agg(jsonb_build_array(
    project.id::text,
    project.owner_id::text,
    project.title,
    project.tier,
    project.needs_visitor_identity,
    project.stage,
    to_char(project.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    project.row_version
  ) ORDER BY project.id)
   FROM app.projects AS project
   WHERE project.id BETWEEN
     '79000000-0000-4000-8000-000000000001'::uuid AND
     '79000000-0000-4000-8000-000000000006'::uuid),
  '[
    ["79000000-0000-4000-8000-000000000001","78000000-0000-4000-8000-000000000001","synthetic-migration-A-visitor-true-negative","A",true,"點子","2026-10-01T01:02:03.000001Z",-11],
    ["79000000-0000-4000-8000-000000000002","78000000-0000-4000-8000-000000000001","synthetic-migration-A-visitor-false-zero","A",false,"A/B","2026-10-02T02:03:04.000002Z",0],
    ["79000000-0000-4000-8000-000000000003","78000000-0000-4000-8000-000000000001","synthetic-migration-A-visitor-true-positive","A",true,"Specification","2026-10-03T03:04:05.000003Z",5],
    ["79000000-0000-4000-8000-000000000004","78000000-0000-4000-8000-000000000001","synthetic-migration-B-visitor-true-negative","B",true,"Final Pack","2026-10-04T04:05:06.000004Z",-2],
    ["79000000-0000-4000-8000-000000000005","78000000-0000-4000-8000-000000000001","synthetic-migration-B-visitor-false-zero","B",false,"Checkpoint","2026-10-05T05:06:07.000005Z",0],
    ["79000000-0000-4000-8000-000000000006","78000000-0000-4000-8000-000000000001","synthetic-migration-B-visitor-false-positive","B",false,"Technical Plan","2026-10-06T06:07:08.000006Z",8]
  ]'::jsonb,
  '0009 historical values remain unchanged, including owner, identifiers, timestamps, stages and negative/zero/positive versions'
);

SELECT extensions.is(
  (SELECT count(*)::integer
   FROM app.projects
   WHERE id BETWEEN
     '79000000-0000-4000-8000-000000000001'::uuid AND
     '79000000-0000-4000-8000-000000000006'::uuid
     AND classification_state = 'legacy_unverified'
     AND requested_tier IS NULL),
  6,
  'all migrated historical rows are legacy_unverified with no requested tier'
);

SELECT extensions.is(
  (SELECT count(*)::integer
   FROM app.projects
   WHERE id BETWEEN
     '79000000-0000-4000-8000-000000000001'::uuid AND
     '79000000-0000-4000-8000-000000000006'::uuid
     AND tier IN ('A', 'B')
     AND needs_visitor_identity IN (true, false)),
  6,
  'historical A/B and true/false values are retained only as legacy values'
);

SELECT extensions.is(
  (SELECT jsonb_build_object(
    'tier_nullable', (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='app' AND table_name='projects' AND column_name='tier'),
    'visitor_nullable', (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='app' AND table_name='projects' AND column_name='needs_visitor_identity'),
    'requested_nullable', (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='app' AND table_name='projects' AND column_name='requested_tier'),
    'classification_nullable', (SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='app' AND table_name='projects' AND column_name='classification_state'),
    'classification_default', (SELECT column_default FROM information_schema.columns
      WHERE table_schema='app' AND table_name='projects' AND column_name='classification_state')
  )),
  '{"tier_nullable":"YES","visitor_nullable":"YES","requested_nullable":"YES","classification_nullable":"NO","classification_default":null}'::jsonb,
  '0010 enforces NOT NULL without adding a classification default'
);

SELECT extensions.is(
  (SELECT relrowsecurity AND relforcerowsecurity
   FROM pg_class WHERE oid='app.projects'::regclass),
  true,
  'projects keeps RLS enabled and forced'
);

SELECT extensions.is(
  (SELECT relrowsecurity AND relforcerowsecurity
   FROM pg_class WHERE oid='app.project_create_idempotency'::regclass),
  true,
  'idempotency table has RLS enabled and forced'
);

SELECT extensions.is(
  (SELECT owner.rolname
   FROM pg_class AS relation
   JOIN pg_roles AS owner ON owner.oid=relation.relowner
   WHERE relation.oid='app.project_create_idempotency'::regclass),
  'postgres',
  'idempotency table retains the existing migration owner'
);

SELECT extensions.is(
  (SELECT count(*)::integer
   FROM unnest(ARRAY['anon', 'authenticated']::name[]) AS actor(role_name)
   WHERE has_table_privilege(actor.role_name, 'app.projects', 'INSERT')
      OR has_table_privilege(actor.role_name, 'app.projects', 'UPDATE')
      OR has_table_privilege(actor.role_name, 'app.projects', 'DELETE')
      OR has_table_privilege(actor.role_name, 'app.project_create_idempotency', 'SELECT')
      OR has_table_privilege(actor.role_name, 'app.project_create_idempotency', 'INSERT')
      OR has_table_privilege(actor.role_name, 'app.project_create_idempotency', 'UPDATE')
      OR has_table_privilege(actor.role_name, 'app.project_create_idempotency', 'DELETE')),
  0,
  'general actors receive no direct project or idempotency DML'
);

SELECT extensions.is(
  (SELECT count(*)::integer
   FROM pg_auth_members AS membership
   JOIN pg_roles AS writer ON writer.oid = membership.roleid
   JOIN pg_roles AS member ON member.oid = membership.member
   WHERE writer.rolname='app_project_writer' AND member.rolname='supabase_admin'),
  0,
  'migration role handoff membership is revoked after ownership transfer'
);

SELECT extensions.is(
  (SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin
   FROM pg_roles WHERE rolname='app_project_writer'),
  true,
  'project writer remains non-login and non-bypass'
);

SELECT extensions.is(
  (SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin
   FROM pg_roles WHERE rolname='app_project_replayer'),
  true,
  'project replayer remains non-login and non-bypass'
);

SELECT extensions.is(
  (SELECT owner.rolname='app_project_replayer'
      AND procedure.prosecdef
      AND procedure.proconfig @> ARRAY['search_path=pg_catalog']
      AND has_function_privilege('authenticated',procedure.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',procedure.oid,'EXECUTE')
      AND NOT has_function_privilege('service_role',procedure.oid,'EXECUTE')
   FROM pg_proc AS procedure
   JOIN pg_roles AS owner ON owner.oid=procedure.proowner
   WHERE procedure.oid='app.replay_unclassified_project(text,text,boolean,uuid)'::regprocedure),
  true,
  'replay-only function uses a restricted owner, fixed search path and authenticated grant'
);

SELECT extensions.is(
  (SELECT NOT has_table_privilege('app_project_replayer','app.projects','INSERT')
      AND NOT has_table_privilege('app_project_replayer','app.project_create_idempotency','INSERT')
      AND NOT has_table_privilege('app_project_replayer','app.project_create_idempotency','UPDATE')
      AND NOT has_table_privilege('app_project_replayer','app.project_create_idempotency','DELETE')
      AND NOT has_function_privilege('authenticated','app.lock_project_create_operation(uuid,uuid)','EXECUTE')
      AND NOT has_function_privilege('anon','app.lock_project_create_operation(uuid,uuid)','EXECUTE')
      AND NOT pg_has_role('authenticated','app_project_replayer','MEMBER')),
  true,
  'replay path cannot write projects or receipts and internal key lock is not actor-callable'
);

SELECT extensions.is(
  (SELECT position('insert into app.projects' in lower(pg_get_functiondef(
      'app.replay_unclassified_project(text,text,boolean,uuid)'::regprocedure
    ))) = 0
      AND position('delete from app.project_create_idempotency' in lower(pg_get_functiondef(
        'app.replay_unclassified_project(text,text,boolean,uuid)'::regprocedure
      ))) = 0),
  true,
  'replay-only function has no project INSERT or receipt DELETE branch'
);

SELECT extensions.lives_ok(
  $$INSERT INTO app.projects (
    id, owner_id, title, requested_tier, classification_state, stage, created_at, row_version
  ) VALUES (
    '79100000-0000-4000-8000-000000000001',
    '78000000-0000-4000-8000-000000000001',
    'synthetic-migration-new-unclassified',
    'B',
    'unconfirmed',
    '點子',
    '2026-10-24T00:00:00Z',
    0
  )$$,
  'valid new unclassified row satisfies scheme B constraints'
);

SELECT extensions.is(
  (SELECT jsonb_build_array(tier, needs_visitor_identity, requested_tier, classification_state)
   FROM app.projects WHERE id='79100000-0000-4000-8000-000000000001'),
  '[null,null,"B","unconfirmed"]'::jsonb,
  'new row keeps formal tier and visitor identity NULL'
);

SELECT extensions.throws_ok(
  $$INSERT INTO app.projects (
    id, owner_id, title, tier, needs_visitor_identity, requested_tier,
    classification_state, stage, created_at, row_version
  ) VALUES (
    '79100000-0000-4000-8000-000000000002',
    '78000000-0000-4000-8000-000000000001',
    'synthetic-migration-invalid-classification',
    'A', false, NULL, 'unconfirmed', '點子', now(), 0
  )$$,
  '23514',
  NULL,
  'unconfirmed rows cannot carry formal classification values'
);

SELECT extensions.throws_ok(
  $$INSERT INTO app.projects (
    id, owner_id, title, tier, needs_visitor_identity, requested_tier,
    classification_state, stage, created_at, row_version
  ) VALUES (
    '79100000-0000-4000-8000-000000000003',
    '78000000-0000-4000-8000-000000000001',
    'synthetic-migration-invalid-legacy',
    'B', true, 'A', 'legacy_unverified', '點子', now(), 0
  )$$,
  '23514',
  NULL,
  'legacy rows cannot have a requested tier'
);

SELECT extensions.is(
  (SELECT relrowsecurity AND relforcerowsecurity
   FROM pg_class WHERE oid='app.tasks'::regclass),
  true,
  'project tasks keep RLS enabled and forced'
);

SELECT extensions.is(
  (SELECT has_table_privilege('authenticated', 'app.tasks', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'app.tasks', 'INSERT')
      AND NOT has_table_privilege('authenticated', 'app.tasks', 'UPDATE')
      AND NOT has_table_privilege('authenticated', 'app.tasks', 'DELETE')
      AND NOT has_table_privilege('anon', 'app.tasks', 'SELECT')
      AND NOT has_table_privilege('service_role', 'app.tasks', 'UPDATE')),
  true,
  'task rows are readable by authenticated actors but cannot be directly changed'
);

SELECT extensions.is(
  (SELECT owner.rolname='app_project_task_writer'
      AND procedure.prosecdef
      AND procedure.proconfig @> ARRAY['search_path=pg_catalog']
      AND has_function_privilege('authenticated',procedure.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',procedure.oid,'EXECUTE')
      AND NOT has_function_privilege('service_role',procedure.oid,'EXECUTE')
   FROM pg_proc AS procedure
   JOIN pg_roles AS owner ON owner.oid=procedure.proowner
   WHERE procedure.oid='app.patch_owned_project_task_done(uuid,uuid,integer,boolean)'::regprocedure),
  true,
  'task done writer uses a restricted owner, fixed search path and minimal actor grant'
);

SELECT extensions.is(
  (SELECT NOT role.rolsuper AND NOT role.rolbypassrls
      AND NOT role.rolcanlogin AND NOT role.rolinherit
      AND NOT has_schema_privilege(role.rolname,'app','CREATE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_auth_members AS membership
        JOIN pg_roles AS member ON member.oid=membership.member
        WHERE membership.roleid=role.oid AND member.rolname='supabase_admin'
      )
   FROM pg_roles AS role WHERE role.rolname='app_project_task_writer'),
  true,
  'task writer is non-login, non-inheriting, non-bypass and loses migration handoff privileges'
);

SELECT extensions.is(
  (SELECT has_column_privilege('app_project_task_writer','app.tasks','id','SELECT')
      AND has_column_privilege('app_project_task_writer','app.tasks','project_id','SELECT')
      AND has_column_privilege('app_project_task_writer','app.tasks','order','SELECT')
      AND has_column_privilege('app_project_task_writer','app.tasks','title','SELECT')
      AND has_column_privilege('app_project_task_writer','app.tasks','done','SELECT')
      AND has_column_privilege('app_project_task_writer','app.tasks','row_version','SELECT')
      AND NOT has_column_privilege('app_project_task_writer','app.tasks','done_snapshot_id','SELECT')
      AND has_column_privilege('app_project_task_writer','app.tasks','done','UPDATE')
      AND has_column_privilege('app_project_task_writer','app.tasks','row_version','UPDATE')
      AND NOT has_table_privilege('app_project_task_writer','app.tasks','INSERT')
      AND NOT has_table_privilege('app_project_task_writer','app.tasks','DELETE')
      AND NOT has_column_privilege('app_project_task_writer','app.tasks','project_id','UPDATE')
      AND NOT has_column_privilege('app_project_task_writer','app.tasks','title','UPDATE')
      AND has_column_privilege('app_project_task_writer','app.projects','id','SELECT')
      AND has_column_privilege('app_project_task_writer','app.projects','owner_id','SELECT')
      AND NOT has_column_privilege('app_project_task_writer','app.projects','title','SELECT')
      AND NOT has_table_privilege('app_project_task_writer','app.projects','UPDATE')),
  true,
  'task writer can read ownership and change only done plus row_version'
);

SELECT extensions.is(
  (SELECT count(*)::integer FROM pg_policies
   WHERE (schemaname='app' AND tablename='tasks' AND roles @> ARRAY['app_project_task_writer']::name[]
          AND cmd IN ('SELECT','UPDATE'))
      OR (schemaname='app' AND tablename='projects' AND roles @> ARRAY['app_project_task_writer']::name[]
          AND cmd='SELECT')),
  3,
  'task writer RLS is limited to owned project and task reads plus owned task updates'
);

SELECT extensions.is(
  (SELECT owner.rolname='app_project_task_importer'
      AND procedure.prosecdef
      AND procedure.proconfig @> ARRAY['search_path=pg_catalog']
      AND has_function_privilege('authenticated',procedure.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',procedure.oid,'EXECUTE')
      AND NOT has_function_privilege('service_role',procedure.oid,'EXECUTE')
      AND NOT has_function_privilege('public',procedure.oid,'EXECUTE')
   FROM pg_proc AS procedure
   JOIN pg_roles AS owner ON owner.oid=procedure.proowner
   WHERE procedure.oid='app.import_owned_project_tasks(uuid,uuid,jsonb)'::regprocedure),
  true,
  'task importer function uses a restricted owner, fixed search path and minimal actor grant'
);

SELECT extensions.is(
  (SELECT NOT role.rolsuper AND NOT role.rolbypassrls
      AND NOT role.rolcanlogin AND NOT role.rolinherit
      AND NOT has_schema_privilege(role.rolname,'app','CREATE')
      AND NOT EXISTS (
        SELECT 1 FROM pg_auth_members AS membership
        JOIN pg_roles AS member ON member.oid=membership.member
        WHERE membership.roleid=role.oid AND member.rolname='supabase_admin'
      )
   FROM pg_roles AS role WHERE role.rolname='app_project_task_importer'),
  true,
  'task importer is non-login, non-inheriting, non-bypass and loses migration handoff privileges'
);

SELECT extensions.is(
  (SELECT c.relrowsecurity AND c.relforcerowsecurity
      AND NOT has_table_privilege('authenticated','app.project_task_imports','SELECT')
      AND NOT has_table_privilege('authenticated','app.project_task_imports','INSERT')
      AND NOT has_table_privilege('anon','app.project_task_imports','SELECT')
      AND NOT has_table_privilege('service_role','app.project_task_imports','INSERT')
      AND has_table_privilege('app_project_task_importer','app.project_task_imports','INSERT')
      AND NOT has_table_privilege('app_project_task_importer','app.project_task_imports','UPDATE')
      AND NOT has_table_privilege('app_project_task_importer','app.project_task_imports','DELETE')
      AND has_column_privilege('app_project_task_importer','app.tasks','title','INSERT')
      AND NOT has_column_privilege('app_project_task_importer','app.tasks','done','INSERT')
      AND NOT has_column_privilege('app_project_task_importer','app.tasks','done_snapshot_id','INSERT')
      AND NOT has_column_privilege('app_project_task_importer','app.tasks','row_version','INSERT')
      AND NOT has_table_privilege('app_project_task_importer','app.tasks','UPDATE')
      AND NOT has_table_privilege('app_project_task_importer','app.tasks','DELETE')
      AND NOT has_table_privilege('app_project_task_importer','app.projects','UPDATE')
   FROM pg_class AS c WHERE c.oid='app.project_task_imports'::regclass),
  true,
  'task import table is forced-RLS and only the importer can insert import and task rows'
);

INSERT INTO app.tasks (id, project_id, "order", title)
VALUES (
  '79200000-0000-4000-8000-000000000001',
  '79100000-0000-4000-8000-000000000001',
  1,
  'synthetic-task-done-save'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '78000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"78000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

SELECT extensions.is(
  app.patch_owned_project_task_done(
    '79100000-0000-4000-8000-000000000001',
    '79200000-0000-4000-8000-000000000001',
    0,
    true
  ),
  jsonb_build_object(
    'outcome', 'saved',
    'task', jsonb_build_object(
      'id', '79200000-0000-4000-8000-000000000001',
      'project_id', '79100000-0000-4000-8000-000000000001',
      'order', 1,
      'title', 'synthetic-task-done-save',
      'done', true,
      'row_version', 1
    )
  ),
  'controlled task writer persists done and advances its version'
);

SELECT extensions.is(
  app.patch_owned_project_task_done(
    '79100000-0000-4000-8000-000000000001',
    '79200000-0000-4000-8000-000000000001',
    0,
    false
  )->>'outcome',
  'version_conflict',
  'stale task row_version cannot overwrite the saved state'
);

SELECT extensions.is(
  (SELECT jsonb_build_array(done, row_version)
   FROM app.tasks WHERE id='79200000-0000-4000-8000-000000000001'),
  '[true,1]'::jsonb,
  'stale conflict leaves task state and version unchanged'
);

SELECT extensions.throws_ok(
  $$UPDATE app.tasks SET done=false WHERE id='79200000-0000-4000-8000-000000000001'$$,
  '42501',
  NULL,
  'authenticated actor cannot directly update project tasks'
);

SELECT * FROM extensions.finish();
ROLLBACK;
