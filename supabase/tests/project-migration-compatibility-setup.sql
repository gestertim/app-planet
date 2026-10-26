BEGIN;

DO $pre_migration_schema$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'app'
      AND table_name = 'projects'
      AND column_name IN ('requested_tier', 'classification_state')
  ) THEN
    RAISE EXCEPTION 'migration compatibility setup requires the 0009 schema';
  END IF;
END
$pre_migration_schema$;

INSERT INTO app.schools (id, label, approval_state, approval_epoch, created_at, updated_at)
VALUES
  ('77000000-0000-4000-8000-000000000001', 'synthetic-migration-school-a', 'approved', 1, now(), now()),
  ('77000000-0000-4000-8000-000000000002', 'synthetic-migration-school-b', 'approved', 1, now(), now());

INSERT INTO auth.users (id)
VALUES
  ('78000000-0000-4000-8000-000000000001'),
  ('78000000-0000-4000-8000-000000000002'),
  ('78000000-0000-4000-8000-000000000003');

INSERT INTO app.profiles (
  id, role, status, deletion_state, school_id, display_label, status_changed_at
)
VALUES
  ('78000000-0000-4000-8000-000000000001', 'student', 'approved', 'none',
    '77000000-0000-4000-8000-000000000001', 'synthetic-migration-owner', now()),
  ('78000000-0000-4000-8000-000000000002', 'student', 'approved', 'none',
    '77000000-0000-4000-8000-000000000001', 'synthetic-migration-same-school-peer', now()),
  ('78000000-0000-4000-8000-000000000003', 'student', 'approved', 'none',
    '77000000-0000-4000-8000-000000000002', 'synthetic-migration-cross-school-peer', now());

INSERT INTO app.projects (
  id, owner_id, title, tier, needs_visitor_identity, stage, created_at, row_version
)
VALUES
  ('79000000-0000-4000-8000-000000000001', '78000000-0000-4000-8000-000000000001',
    'synthetic-migration-A-visitor-true-negative', 'A', true, '點子', '2026-10-01T01:02:03.000001Z', -11),
  ('79000000-0000-4000-8000-000000000002', '78000000-0000-4000-8000-000000000001',
    'synthetic-migration-A-visitor-false-zero', 'A', false, 'A/B', '2026-10-02T02:03:04.000002Z', 0),
  ('79000000-0000-4000-8000-000000000003', '78000000-0000-4000-8000-000000000001',
    'synthetic-migration-A-visitor-true-positive', 'A', true, 'Specification', '2026-10-03T03:04:05.000003Z', 5),
  ('79000000-0000-4000-8000-000000000004', '78000000-0000-4000-8000-000000000001',
    'synthetic-migration-B-visitor-true-negative', 'B', true, 'Final Pack', '2026-10-04T04:05:06.000004Z', -2),
  ('79000000-0000-4000-8000-000000000005', '78000000-0000-4000-8000-000000000001',
    'synthetic-migration-B-visitor-false-zero', 'B', false, 'Checkpoint', '2026-10-05T05:06:07.000005Z', 0),
  ('79000000-0000-4000-8000-000000000006', '78000000-0000-4000-8000-000000000001',
    'synthetic-migration-B-visitor-false-positive', 'B', false, 'Technical Plan', '2026-10-06T06:07:08.000006Z', 8);

COMMIT;
