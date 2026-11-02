-- P-1 stays reusable after receipt expiry; browser recovery must use this read-only path.

BEGIN;

CREATE ROLE app_project_replayer WITH NOLOGIN NOINHERIT NOBYPASSRLS;
REVOKE CREATE ON SCHEMA app FROM app_project_replayer;
GRANT USAGE ON SCHEMA app, auth TO app_project_replayer;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_project_replayer;
GRANT EXECUTE ON FUNCTION app.current_account_gate(text) TO app_project_replayer;
GRANT SELECT (id, owner_id, created_at) ON app.projects TO app_project_replayer;
GRANT SELECT ON app.project_create_idempotency TO app_project_replayer;

CREATE POLICY projects_create_replayer_read_own
  ON app.projects
  FOR SELECT
  TO app_project_replayer
  USING (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND owner_id = auth.uid()
  );

CREATE POLICY project_create_idempotency_replayer_read_own
  ON app.project_create_idempotency
  FOR SELECT
  TO app_project_replayer
  USING (
    owner_id = auth.uid()
    AND operation_scope = 'project_create_v1'
    AND app.current_account_gate('edit_saved_content')
  );

CREATE FUNCTION app.lock_project_create_operation(p_owner uuid, p_idempotency_key uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_owner::text || ':project_create_v1:' || p_idempotency_key::text, 0
  ));
$function$;

REVOKE ALL ON FUNCTION app.lock_project_create_operation(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.lock_project_create_operation(uuid, uuid)
  TO app_project_writer, app_project_replayer;

CREATE OR REPLACE FUNCTION app.create_unclassified_project(
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
  v_now timestamptz;
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

  PERFORM app.lock_project_create_operation(v_owner, p_idempotency_key);
  IF NOT app.current_account_gate('edit_saved_content') THEN
    RETURN jsonb_build_object('outcome', 'denied');
  END IF;
  v_now := clock_timestamp();

  DELETE FROM app.project_create_idempotency
  WHERE owner_id = v_owner
    AND operation_scope = 'project_create_v1'
    AND idempotency_key = p_idempotency_key
    AND expires_at <= v_now;

  INSERT INTO app.project_create_idempotency (
    owner_id, operation_scope, idempotency_key, request_title,
    requested_tier, tier_was_provided, created_at, expires_at
  ) VALUES (
    v_owner, 'project_create_v1', p_idempotency_key, p_title,
    p_requested_tier, p_tier_was_provided,
    v_now, v_now + interval '24 hours'
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

  INSERT INTO app.projects (
    id, owner_id, title, requested_tier, classification_state, stage, created_at, row_version
  ) VALUES (
    gen_random_uuid(), v_owner, p_title, p_requested_tier, 'unconfirmed', '點子', v_now, 0
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

CREATE FUNCTION app.replay_unclassified_project(
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
  v_now timestamptz;
  v_idempotency app.project_create_idempotency%ROWTYPE;
  v_project_created_at timestamptz;
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

  PERFORM app.lock_project_create_operation(v_owner, p_idempotency_key);
  IF NOT app.current_account_gate('edit_saved_content') THEN
    RETURN jsonb_build_object('outcome', 'denied');
  END IF;

  SELECT entry.*
  INTO v_idempotency
  FROM app.project_create_idempotency AS entry
  WHERE entry.owner_id = v_owner
    AND entry.operation_scope = 'project_create_v1'
    AND entry.idempotency_key = p_idempotency_key;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'unrecoverable');
  END IF;

  IF convert_to(v_idempotency.request_title, 'UTF8') <> convert_to(p_title, 'UTF8')
    OR v_idempotency.requested_tier IS DISTINCT FROM p_requested_tier
    OR v_idempotency.tier_was_provided <> p_tier_was_provided THEN
    RETURN jsonb_build_object('outcome', 'idempotency_conflict');
  END IF;

  IF v_idempotency.project_id IS NULL OR v_idempotency.response IS NULL THEN
    RETURN jsonb_build_object('outcome', 'unrecoverable');
  END IF;

  SELECT project.created_at
  INTO v_project_created_at
  FROM app.projects AS project
  WHERE project.id = v_idempotency.project_id
    AND project.owner_id = v_owner;
  IF NOT FOUND OR NOT app.current_account_gate('edit_saved_content') THEN
    RETURN jsonb_build_object('outcome', 'denied');
  END IF;

  v_now := clock_timestamp();
  IF v_idempotency.expires_at <= v_now THEN
    RETURN jsonb_build_object('outcome', 'unrecoverable');
  END IF;

  IF jsonb_typeof(v_idempotency.response) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(v_idempotency.response)) <> 9
    OR NOT (v_idempotency.response ?& ARRAY[
      'id', 'title', 'requested_tier', 'classification_state', 'tier',
      'needs_visitor_identity', 'stage', 'created_at', 'row_version'
    ])
    OR v_idempotency.response->>'id' IS DISTINCT FROM v_idempotency.project_id::text
    OR v_idempotency.response->>'title' IS DISTINCT FROM v_idempotency.request_title
    OR v_idempotency.response->'requested_tier' IS DISTINCT FROM
      COALESCE(to_jsonb(v_idempotency.requested_tier), 'null'::jsonb)
    OR v_idempotency.response->>'classification_state' IS DISTINCT FROM 'unconfirmed'
    OR v_idempotency.response->'tier' IS DISTINCT FROM 'null'::jsonb
    OR v_idempotency.response->'needs_visitor_identity' IS DISTINCT FROM 'null'::jsonb
    OR v_idempotency.response->>'stage' IS DISTINCT FROM '點子'
    OR v_idempotency.response->>'created_at' IS DISTINCT FROM
      to_char(v_project_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    OR v_idempotency.response->'row_version' IS DISTINCT FROM to_jsonb(0) THEN
    RETURN jsonb_build_object('outcome', 'unrecoverable');
  END IF;

  RETURN jsonb_build_object('outcome', 'replayed', 'project', v_idempotency.response);
END;
$function$;

GRANT CREATE ON SCHEMA app TO app_project_replayer;
GRANT app_project_replayer TO supabase_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
ALTER FUNCTION app.replay_unclassified_project(text, text, boolean, uuid)
  OWNER TO app_project_replayer;
REVOKE app_project_replayer FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_project_replayer;
REVOKE ALL ON FUNCTION app.replay_unclassified_project(text, text, boolean, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.replay_unclassified_project(text, text, boolean, uuid)
  TO authenticated;

COMMIT;
