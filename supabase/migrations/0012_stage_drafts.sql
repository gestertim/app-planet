-- 僅 readiness §45 的獨立未確認本機草稿；不建立批准／旅程／分類來源。
BEGIN;

CREATE TABLE app.stage_records (
  project_id uuid NOT NULL REFERENCES app.projects (id) ON DELETE RESTRICT,
  stage text NOT NULL CHECK (stage IN (
    '點子', 'A/B', 'Specification', 'Checkpoint', 'Constitution',
    'UX/UI', 'Specification Sync', 'Technical Plan', 'Final Pack'
  )),
  state text NOT NULL CHECK (state = 'ai_draft'),
  content_source text NOT NULL CHECK (content_source = 'student_input'),
  content jsonb NOT NULL CHECK (
    jsonb_typeof(content) = 'object'
    AND content ? 'text'
    AND jsonb_typeof(content->'text') = 'string'
    AND content - 'text' = '{}'::jsonb
  ),
  row_version integer NOT NULL CHECK (row_version >= 0),
  approved_by uuid NULL CHECK (approved_by IS NULL),
  approved_at timestamptz NULL CHECK (approved_at IS NULL),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, stage)
);
CREATE TABLE app.stage_draft_idempotency (
  owner_id uuid NOT NULL REFERENCES app.profiles (id),
  operation_scope text NOT NULL CHECK (operation_scope = 'stage_draft_save_v1'),
  idempotency_key uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES app.projects (id) ON DELETE RESTRICT,
  request_payload jsonb NOT NULL,
  response jsonb NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, operation_scope, idempotency_key),
  CHECK (expires_at = created_at + interval '24 hours')
);
ALTER TABLE app.stage_records OWNER TO postgres;
ALTER TABLE app.stage_draft_idempotency OWNER TO postgres;
ALTER TABLE app.stage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stage_records FORCE ROW LEVEL SECURITY;
ALTER TABLE app.stage_draft_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stage_draft_idempotency FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.stage_records, app.stage_draft_idempotency
  FROM PUBLIC, anon, authenticated, service_role;

CREATE ROLE app_stage_draft_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA app, auth TO app_stage_draft_writer;
GRANT EXECUTE ON FUNCTION auth.uid(), app.current_account_gate(text) TO app_stage_draft_writer;
GRANT SELECT (id, owner_id) ON app.projects TO app_stage_draft_writer;
CREATE POLICY projects_draft_writer_read_owner ON app.projects
  FOR SELECT TO app_stage_draft_writer
  USING (owner_id = auth.uid() AND app.current_account_gate('edit_saved_content'));

GRANT SELECT ON app.stage_records TO authenticated, app_stage_draft_writer;
GRANT INSERT (
  project_id, stage, state, content_source, content, row_version,
  created_at, updated_at
) ON app.stage_records TO app_stage_draft_writer;
GRANT UPDATE (content, row_version, updated_at) ON app.stage_records TO app_stage_draft_writer;
CREATE POLICY stage_records_read_owner ON app.stage_records
  FOR SELECT TO authenticated
  USING (
    app.current_account_gate('read_saved_content')
    AND EXISTS (SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid())
  );
CREATE POLICY stage_records_writer_owner ON app.stage_records
  FOR ALL TO app_stage_draft_writer
  USING (
    app.current_account_gate('edit_saved_content')
    AND EXISTS (SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid())
  )
  WITH CHECK (
    app.current_account_gate('edit_saved_content')
    AND state = 'ai_draft' AND content_source = 'student_input'
    AND approved_by IS NULL AND approved_at IS NULL
    AND EXISTS (SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid())
  );

GRANT SELECT, DELETE ON app.stage_draft_idempotency TO app_stage_draft_writer;
GRANT INSERT (
  owner_id, operation_scope, idempotency_key, project_id, request_payload, created_at, expires_at
) ON app.stage_draft_idempotency TO app_stage_draft_writer;
GRANT UPDATE (response) ON app.stage_draft_idempotency TO app_stage_draft_writer;
CREATE POLICY stage_draft_idempotency_writer_scope ON app.stage_draft_idempotency
  FOR ALL TO app_stage_draft_writer
  USING (owner_id = auth.uid() AND app.current_account_gate('edit_saved_content'))
  WITH CHECK (owner_id = auth.uid() AND app.current_account_gate('edit_saved_content'));

CREATE FUNCTION app.save_stage_draft(
  p_project_id uuid, p_stage text, p_expected_row_version integer,
  p_text text, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_owner uuid;
  v_key app.stage_draft_idempotency%ROWTYPE;
  v_draft app.stage_records%ROWTYPE;
  v_request jsonb;
  v_receipt jsonb;
  v_exists boolean;
BEGIN
  IF p_project_id IS NULL OR p_stage IS NULL
    OR p_stage NOT IN ('點子','A/B','Specification','Checkpoint','Constitution',
      'UX/UI','Specification Sync','Technical Plan','Final Pack')
    OR p_expected_row_version < 0 OR p_text IS NULL OR p_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  v_owner := auth.uid();
  IF v_owner IS NULL OR NOT app.current_account_gate('edit_saved_content')
    OR NOT app.current_account_gate('read_saved_content') THEN
    RETURN jsonb_build_object('outcome', 'denied');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.projects WHERE id = p_project_id AND owner_id = v_owner) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  DELETE FROM app.stage_draft_idempotency
  WHERE owner_id = v_owner AND operation_scope = 'stage_draft_save_v1'
    AND idempotency_key = p_idempotency_key AND expires_at <= statement_timestamp();
  v_request := jsonb_build_object(
    'project_id', p_project_id, 'stage', p_stage,
    'expected_row_version', p_expected_row_version, 'content', jsonb_build_object('text', p_text)
  );
  INSERT INTO app.stage_draft_idempotency (
    owner_id, operation_scope, idempotency_key, project_id, request_payload, created_at, expires_at
  ) VALUES (
    v_owner, 'stage_draft_save_v1', p_idempotency_key, p_project_id,
    v_request, statement_timestamp(), statement_timestamp() + interval '24 hours'
  ) ON CONFLICT (owner_id, operation_scope, idempotency_key) DO NOTHING;
  SELECT * INTO STRICT v_key FROM app.stage_draft_idempotency
  WHERE owner_id = v_owner AND operation_scope = 'stage_draft_save_v1'
    AND idempotency_key = p_idempotency_key FOR UPDATE;

  -- 同一資源的首次建立也須序列化；不鎖／改動 project 版本。
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text || ':' || p_stage, 0));
  IF NOT app.current_account_gate('edit_saved_content')
    OR NOT app.current_account_gate('read_saved_content') THEN
    RAISE EXCEPTION 'stage draft authorization changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.projects WHERE id = p_project_id AND owner_id = v_owner) THEN
    RAISE EXCEPTION 'stage draft ownership changed';
  END IF;
  IF v_key.request_payload <> v_request THEN
    RETURN jsonb_build_object('outcome', 'idempotency_conflict');
  END IF;
  IF v_key.response IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'replayed', 'operation', v_key.response);
  END IF;
  SELECT * INTO v_draft FROM app.stage_records
  WHERE project_id = p_project_id AND stage = p_stage FOR UPDATE;
  v_exists := FOUND;
  IF (v_exists AND (p_expected_row_version IS NULL OR v_draft.row_version <> p_expected_row_version))
    OR (NOT v_exists AND p_expected_row_version IS NOT NULL) THEN
    DELETE FROM app.stage_draft_idempotency
    WHERE owner_id = v_owner AND operation_scope = 'stage_draft_save_v1'
      AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object(
      'outcome', 'version_conflict',
      'conflict', jsonb_build_object(
        'current', jsonb_build_object(
          'version', CASE WHEN v_exists THEN v_draft.row_version ELSE NULL END,
          'content', CASE WHEN v_exists THEN v_draft.content ELSE NULL END
        ),
        'submitted', jsonb_build_object(
          'version', p_expected_row_version, 'content', jsonb_build_object('text', p_text)
        )
      )
    );
  END IF;
  IF v_exists AND v_draft.row_version = 2147483647 THEN
    DELETE FROM app.stage_draft_idempotency
    WHERE owner_id = v_owner AND operation_scope = 'stage_draft_save_v1'
      AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('outcome', 'version_exhausted');
  END IF;
  IF v_exists THEN
    UPDATE app.stage_records
    SET content = jsonb_build_object('text', p_text),
      row_version = row_version + 1, updated_at = clock_timestamp()
    WHERE project_id = p_project_id AND stage = p_stage
      AND row_version = p_expected_row_version
    RETURNING * INTO STRICT v_draft;
  ELSE
    INSERT INTO app.stage_records (
      project_id, stage, state, content_source, content, row_version, created_at, updated_at
    ) VALUES (
      p_project_id, p_stage, 'ai_draft', 'student_input',
      jsonb_build_object('text', p_text), 0, clock_timestamp(), clock_timestamp()
    ) RETURNING * INTO v_draft;
  END IF;
  v_receipt := jsonb_build_object(
    'project_id', v_draft.project_id, 'stage', v_draft.stage,
    'state', v_draft.state, 'content_source', v_draft.content_source,
    'content', v_draft.content, 'row_version', v_draft.row_version,
    'approved_by', NULL, 'approved_at', NULL
  );
  UPDATE app.stage_draft_idempotency SET response = v_receipt
  WHERE owner_id = v_owner AND operation_scope = 'stage_draft_save_v1'
    AND idempotency_key = p_idempotency_key;
  RETURN jsonb_build_object('outcome', 'saved', 'operation', v_receipt);
END;
$function$;

GRANT CREATE ON SCHEMA app TO app_stage_draft_writer;
GRANT app_stage_draft_writer TO supabase_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
ALTER FUNCTION app.save_stage_draft(uuid, text, integer, text, uuid) OWNER TO app_stage_draft_writer;
REVOKE app_stage_draft_writer FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_stage_draft_writer;
REVOKE ALL ON FUNCTION app.save_stage_draft(uuid, text, integer, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.save_stage_draft(uuid, text, integer, text, uuid) TO authenticated;
COMMIT;
