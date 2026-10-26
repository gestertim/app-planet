-- 僅 readiness §38 隔離本機 projects 子集；stage_records／tasks 尚未建立。
-- 非正式保存或部署授權；必要欄位由控制 fixture 明示，不核定階段／版本初始值。
CREATE TABLE app.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES app.profiles (id),
  title text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('A', 'B')),
  needs_visitor_identity boolean NOT NULL,
  stage text NOT NULL CHECK (stage IN (
    '點子', 'A/B', 'Specification', 'Checkpoint', 'Constitution',
    'UX/UI', 'Specification Sync', 'Technical Plan', 'Final Pack'
  )),
  created_at timestamptz NOT NULL,
  row_version int NOT NULL
);

CREATE INDEX projects_owner_id ON app.projects (owner_id);

ALTER TABLE app.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.projects FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.projects FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE app.projects TO authenticated;

CREATE POLICY projects_read_own_saved_content
  ON app.projects
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('read_saved_content')
    AND owner_id = auth.uid()
  );
