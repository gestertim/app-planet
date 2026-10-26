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

SELECT * FROM extensions.finish();
ROLLBACK;
