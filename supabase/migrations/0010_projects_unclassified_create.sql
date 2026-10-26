-- 僅 readiness §41 批准的隔離本機 T051 子集；不部署至正式環境。

BEGIN;

ALTER TABLE app.projects
  ALTER COLUMN tier DROP NOT NULL,
  ALTER COLUMN needs_visitor_identity DROP NOT NULL;

ALTER TABLE app.projects
  ADD COLUMN requested_tier text NULL,
  ADD COLUMN classification_state text;

UPDATE app.projects
SET classification_state = 'legacy_unverified';

ALTER TABLE app.projects
  ALTER COLUMN classification_state SET NOT NULL,
  ADD CONSTRAINT projects_requested_tier_supported
    CHECK (requested_tier IS NULL OR requested_tier IN ('A', 'B')),
  ADD CONSTRAINT projects_classification_state_supported
    CHECK (classification_state IN ('unconfirmed', 'legacy_unverified')),
  ADD CONSTRAINT projects_classification_state_consistent
    CHECK (
      (
        classification_state = 'unconfirmed'
        AND tier IS NULL
        AND needs_visitor_identity IS NULL
      )
      OR (
        classification_state = 'legacy_unverified'
        AND requested_tier IS NULL
        AND tier IS NOT NULL
        AND tier IN ('A', 'B')
        AND needs_visitor_identity IS NOT NULL
      )
    );

CREATE TABLE app.project_create_idempotency (
  owner_id uuid NOT NULL REFERENCES app.profiles (id),
  operation_scope text NOT NULL CHECK (operation_scope = 'project_create_v1'),
  idempotency_key uuid NOT NULL,
  request_title text NOT NULL,
  requested_tier text NULL CHECK (requested_tier IS NULL OR requested_tier IN ('A', 'B')),
  tier_was_provided boolean NOT NULL,
  project_id uuid NULL REFERENCES app.projects (id),
  response jsonb NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, operation_scope, idempotency_key),
  CHECK (
    (tier_was_provided AND requested_tier IS NOT NULL AND requested_tier IN ('A', 'B'))
    OR (NOT tier_was_provided AND requested_tier IS NULL)
  ),
  CHECK ((project_id IS NULL) = (response IS NULL)),
  CHECK (expires_at = created_at + interval '24 hours')
);

ALTER TABLE app.project_create_idempotency OWNER TO postgres;
ALTER TABLE app.project_create_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_create_idempotency FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.project_create_idempotency
  FROM PUBLIC, anon, authenticated, service_role;

CREATE ROLE app_project_writer WITH NOLOGIN NOINHERIT NOBYPASSRLS;
REVOKE CREATE ON SCHEMA app FROM app_project_writer;
GRANT USAGE ON SCHEMA app, auth TO app_project_writer;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_project_writer;
GRANT EXECUTE ON FUNCTION app.current_account_gate(text) TO app_project_writer;

GRANT SELECT (
  id, owner_id, title, tier, needs_visitor_identity, requested_tier,
  classification_state, stage, created_at, row_version
) ON app.projects TO app_project_writer;
GRANT INSERT (
  id, owner_id, title, requested_tier, classification_state, stage, created_at, row_version
) ON app.projects TO app_project_writer;

GRANT SELECT ON app.project_create_idempotency TO app_project_writer;
GRANT INSERT (
  owner_id, operation_scope, idempotency_key, request_title, requested_tier,
  tier_was_provided, created_at, expires_at
) ON app.project_create_idempotency TO app_project_writer;
GRANT UPDATE (project_id, response) ON app.project_create_idempotency TO app_project_writer;
GRANT DELETE ON app.project_create_idempotency TO app_project_writer;

CREATE POLICY projects_create_writer_read_own
  ON app.projects
  FOR SELECT
  TO app_project_writer
  USING (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND owner_id = auth.uid()
  );

CREATE POLICY projects_create_writer_insert_unclassified
  ON app.projects
  FOR INSERT
  TO app_project_writer
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND owner_id = auth.uid()
    AND classification_state = 'unconfirmed'
    AND tier IS NULL
    AND needs_visitor_identity IS NULL
    AND stage = '點子'
    AND row_version = 0
  );

CREATE POLICY project_create_idempotency_writer_scope
  ON app.project_create_idempotency
  FOR ALL
  TO app_project_writer
  USING (
    owner_id = auth.uid()
    AND operation_scope = 'project_create_v1'
    AND app.current_account_gate('edit_saved_content')
  )
  WITH CHECK (
    owner_id = auth.uid()
    AND operation_scope = 'project_create_v1'
    AND app.current_account_gate('edit_saved_content')
  );

CREATE FUNCTION app.create_unclassified_project(
  p_title text,
  p_requested_tier text,
  p_tier_was_provided boolean,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_owner uuid;
  v_created_at timestamptz;
  v_idempotency app.project_create_idempotency%ROWTYPE;
  v_project app.projects%ROWTYPE;
  v_response jsonb;
BEGIN
  IF p_title IS NULL
    OR p_tier_was_provided IS NULL
    OR p_idempotency_key IS NULL
    OR (p_tier_was_provided AND (
      p_requested_tier IS NULL OR p_requested_tier NOT IN ('A', 'B')
    ))
    OR (NOT p_tier_was_provided AND p_requested_tier IS NOT NULL) THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  v_owner := auth.uid();
  IF v_owner IS NULL OR NOT app.current_account_gate('edit_saved_content') THEN
    RETURN jsonb_build_object('outcome', 'denied');
  END IF;

  DELETE FROM app.project_create_idempotency
  WHERE owner_id = v_owner
    AND operation_scope = 'project_create_v1'
    AND idempotency_key = p_idempotency_key
    AND expires_at <= statement_timestamp();

  INSERT INTO app.project_create_idempotency (
    owner_id, operation_scope, idempotency_key, request_title,
    requested_tier, tier_was_provided, created_at, expires_at
  ) VALUES (
    v_owner, 'project_create_v1', p_idempotency_key, p_title,
    p_requested_tier, p_tier_was_provided,
    statement_timestamp(), statement_timestamp() + interval '24 hours'
  )
  ON CONFLICT (owner_id, operation_scope, idempotency_key) DO NOTHING;

  SELECT entry.*
  INTO STRICT v_idempotency
  FROM app.project_create_idempotency AS entry
  WHERE entry.owner_id = v_owner
    AND entry.operation_scope = 'project_create_v1'
    AND entry.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF convert_to(v_idempotency.request_title, 'UTF8') <> convert_to(p_title, 'UTF8')
    OR v_idempotency.requested_tier IS DISTINCT FROM p_requested_tier
    OR v_idempotency.tier_was_provided <> p_tier_was_provided THEN
    RETURN jsonb_build_object('outcome', 'idempotency_conflict');
  END IF;

  IF v_idempotency.project_id IS NOT NULL AND v_idempotency.response IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'created', 'project', v_idempotency.response);
  END IF;
  IF v_idempotency.project_id IS NOT NULL OR v_idempotency.response IS NOT NULL THEN
    RAISE EXCEPTION 'incomplete project creation idempotency result';
  END IF;

  v_created_at := statement_timestamp();
  INSERT INTO app.projects (
    id, owner_id, title, requested_tier, classification_state, stage, created_at, row_version
  ) VALUES (
    gen_random_uuid(), v_owner, p_title, p_requested_tier, 'unconfirmed', '點子', v_created_at, 0
  )
  RETURNING * INTO v_project;

  v_response := jsonb_build_object(
    'id', v_project.id::text,
    'title', v_project.title,
    'requested_tier', v_project.requested_tier,
    'classification_state', v_project.classification_state,
    'tier', v_project.tier,
    'needs_visitor_identity', v_project.needs_visitor_identity,
    'stage', v_project.stage,
    'created_at', to_char(v_project.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'row_version', v_project.row_version
  );

  UPDATE app.project_create_idempotency
  SET project_id = v_project.id, response = v_response
  WHERE owner_id = v_owner
    AND operation_scope = 'project_create_v1'
    AND idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object('outcome', 'created', 'project', v_response);
END;
$function$;

-- 為移交函式所有權暫授 schema CREATE，完成後立即撤銷。
GRANT CREATE ON SCHEMA app TO app_project_writer;
GRANT app_project_writer TO supabase_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
ALTER FUNCTION app.create_unclassified_project(text, text, boolean, uuid)
  OWNER TO app_project_writer;
REVOKE app_project_writer FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_project_writer;
REVOKE ALL ON FUNCTION app.create_unclassified_project(text, text, boolean, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.create_unclassified_project(text, text, boolean, uuid)
  TO authenticated;

COMMIT;
