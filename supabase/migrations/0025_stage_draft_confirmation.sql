BEGIN;

-- 本人學生對「伺服器已保存的確切草稿版本」的明確確認證據（readiness §87）。
-- 證據不可改寫；現行有效性由 (project_id, stage, record_row_version, content_hash) 與
-- 當前 stage_records 比對推導，因此任何後續保存（含改回相同文字）都會使舊確認自動失效。
-- 不改 stage_records／projects／既有函式；不是教師／管理員批准、Checkpoint 或分類證據。
CREATE TABLE app.stage_draft_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  stage text NOT NULL,
  record_row_version integer NOT NULL CHECK (record_row_version >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  confirmed_by uuid NOT NULL REFERENCES app.profiles (id),
  confirmed_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source = 'student_explicit_confirmation'),
  idempotency_key uuid NOT NULL,
  FOREIGN KEY (project_id, stage) REFERENCES app.stage_records (project_id, stage) ON DELETE RESTRICT,
  UNIQUE (project_id, stage, record_row_version),
  UNIQUE (confirmed_by, idempotency_key)
);
ALTER TABLE app.stage_draft_confirmations OWNER TO postgres;
ALTER TABLE app.stage_draft_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stage_draft_confirmations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.stage_draft_confirmations FROM PUBLIC, anon, authenticated, service_role;

CREATE ROLE app_stage_confirmer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA app, auth TO app_stage_confirmer;
GRANT EXECUTE ON FUNCTION auth.uid(), app.current_account_gate(text) TO app_stage_confirmer;
GRANT SELECT (id, owner_id) ON app.projects TO app_stage_confirmer;
GRANT SELECT (project_id, stage, content, row_version) ON app.stage_records TO app_stage_confirmer;
GRANT SELECT, INSERT ON app.stage_draft_confirmations TO app_stage_confirmer;
GRANT SELECT ON app.stage_draft_confirmations TO authenticated;

CREATE POLICY projects_stage_confirmer_read_owner ON app.projects
  FOR SELECT TO app_stage_confirmer
  USING (owner_id = auth.uid() AND app.current_account_gate('edit_saved_content'));
CREATE POLICY stage_records_confirmer_read_owner ON app.stage_records
  FOR SELECT TO app_stage_confirmer
  USING (
    app.current_account_gate('edit_saved_content')
    AND EXISTS (SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid())
  );
CREATE POLICY stage_confirmations_read_owner ON app.stage_draft_confirmations
  FOR SELECT TO authenticated
  USING (
    confirmed_by = auth.uid()
    AND app.current_account_gate('read_saved_content')
    AND EXISTS (SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid())
  );
CREATE POLICY stage_confirmations_confirmer_read ON app.stage_draft_confirmations
  FOR SELECT TO app_stage_confirmer
  USING (confirmed_by = auth.uid() AND app.current_account_gate('edit_saved_content'));
CREATE POLICY stage_confirmations_confirmer_insert ON app.stage_draft_confirmations
  FOR INSERT TO app_stage_confirmer
  WITH CHECK (
    confirmed_by = auth.uid()
    AND source = 'student_explicit_confirmation'
    AND app.current_account_gate('edit_saved_content')
    AND EXISTS (SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid())
  );

CREATE FUNCTION app.confirm_stage_draft(
  p_project_id uuid, p_stage text, p_expected_row_version integer, p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_owner uuid;
  v_draft record;
  v_existing app.stage_draft_confirmations%ROWTYPE;
  v_current_hash text;
  v_row app.stage_draft_confirmations%ROWTYPE;
BEGIN
  IF p_project_id IS NULL OR p_stage IS NULL
    OR p_stage NOT IN ('點子','A/B','Specification','Checkpoint','Constitution',
      'UX/UI','Specification Sync','Technical Plan','Final Pack')
    OR p_expected_row_version IS NULL OR p_expected_row_version < 0
    OR p_idempotency_key IS NULL THEN
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

  -- 與 app.save_stage_draft 使用同一把資源鎖，保存與確認互相序列化。
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::text || ':' || p_stage, 0));
  IF auth.uid() IS DISTINCT FROM v_owner
    OR NOT app.current_account_gate('edit_saved_content')
    OR NOT app.current_account_gate('read_saved_content') THEN
    RAISE EXCEPTION 'stage confirmation authorization changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.projects WHERE id = p_project_id AND owner_id = v_owner) THEN
    RAISE EXCEPTION 'stage confirmation ownership changed';
  END IF;

  SELECT d.row_version, encode(sha256(convert_to(d.content->>'text', 'UTF8')), 'hex') AS hash
  INTO v_draft
  FROM app.stage_records d WHERE d.project_id = p_project_id AND d.stage = p_stage;
  v_current_hash := CASE WHEN FOUND THEN v_draft.hash ELSE NULL END;

  SELECT * INTO v_existing FROM app.stage_draft_confirmations
  WHERE confirmed_by = v_owner AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.project_id <> p_project_id OR v_existing.stage <> p_stage
      OR v_existing.record_row_version <> p_expected_row_version THEN
      RETURN jsonb_build_object('outcome', 'idempotency_conflict');
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'replayed',
      'confirmation', jsonb_build_object(
        'project_id', v_existing.project_id, 'stage', v_existing.stage,
        'row_version', v_existing.record_row_version, 'content_hash', v_existing.content_hash,
        'confirmed_at', v_existing.confirmed_at
      ),
      'current', coalesce(
        v_current_hash = v_existing.content_hash
        AND v_draft.row_version = v_existing.record_row_version, false)
    );
  END IF;

  IF v_current_hash IS NULL THEN
    RETURN jsonb_build_object('outcome', 'no_draft');
  END IF;
  IF v_draft.row_version <> p_expected_row_version THEN
    RETURN jsonb_build_object('outcome', 'version_mismatch', 'current_row_version', v_draft.row_version);
  END IF;

  SELECT * INTO v_existing FROM app.stage_draft_confirmations
  WHERE project_id = p_project_id AND stage = p_stage AND record_row_version = v_draft.row_version;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'outcome', 'already_confirmed',
      'confirmation', jsonb_build_object(
        'project_id', v_existing.project_id, 'stage', v_existing.stage,
        'row_version', v_existing.record_row_version, 'content_hash', v_existing.content_hash,
        'confirmed_at', v_existing.confirmed_at
      )
    );
  END IF;

  INSERT INTO app.stage_draft_confirmations (
    project_id, stage, record_row_version, content_hash, confirmed_by, confirmed_at, source,
    idempotency_key
  ) VALUES (
    p_project_id, p_stage, v_draft.row_version, v_current_hash, v_owner, clock_timestamp(),
    'student_explicit_confirmation', p_idempotency_key
  ) RETURNING * INTO v_row;
  RETURN jsonb_build_object(
    'outcome', 'confirmed',
    'confirmation', jsonb_build_object(
      'project_id', v_row.project_id, 'stage', v_row.stage,
      'row_version', v_row.record_row_version, 'content_hash', v_row.content_hash,
      'confirmed_at', v_row.confirmed_at
    )
  );
END;
$function$;

GRANT CREATE ON SCHEMA app TO app_stage_confirmer;
GRANT app_stage_confirmer TO supabase_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
ALTER FUNCTION app.confirm_stage_draft(uuid, text, integer, uuid) OWNER TO app_stage_confirmer;
REVOKE app_stage_confirmer FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_stage_confirmer;
REVOKE ALL ON FUNCTION app.confirm_stage_draft(uuid, text, integer, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.confirm_stage_draft(uuid, text, integer, uuid) TO authenticated;
COMMIT;
