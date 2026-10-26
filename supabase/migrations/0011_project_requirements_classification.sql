-- 僅 readiness §43 核准的隔離本機需求版本／分類確認子集。
BEGIN;

ALTER TABLE app.projects
  ADD COLUMN requirements_revision integer NOT NULL DEFAULT 0
    CHECK (requirements_revision >= 0),
  ADD COLUMN current_confirmation_id uuid NULL;

ALTER TABLE app.projects
  DROP CONSTRAINT projects_classification_state_supported,
  DROP CONSTRAINT projects_classification_state_consistent;

CREATE TABLE app.project_requirements (
  project_id uuid NOT NULL REFERENCES app.projects (id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  description text NOT NULL,
  runtime_needs text NOT NULL CHECK (
    runtime_needs IN ('static', 'work_data_api', 'restricted_server')
  ),
  runtime_ai_required boolean NOT NULL,
  created_by uuid NOT NULL REFERENCES app.profiles (id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, revision)
);

CREATE TABLE app.project_classification_confirmations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  requirements_revision integer NOT NULL,
  requirements_description text NOT NULL,
  requirements_runtime_needs text NOT NULL CHECK (
    requirements_runtime_needs IN ('static', 'work_data_api', 'restricted_server')
  ),
  requirements_runtime_ai_required boolean NOT NULL,
  requested_tier_at_confirmation text NULL CHECK (
    requested_tier_at_confirmation IS NULL
    OR requested_tier_at_confirmation IN ('A', 'B')
  ),
  requested_tier_acknowledgement text NOT NULL CHECK (
    requested_tier_acknowledgement IN ('no_preference', 'matches', 'explicit_change')
  ),
  tier text NOT NULL CHECK (tier IN ('A', 'B')),
  needs_visitor_identity boolean NOT NULL,
  confirmed_by uuid NOT NULL REFERENCES app.profiles (id),
  confirmed_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source = 'student_explicit_confirmation'),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, id, requirements_revision),
  FOREIGN KEY (project_id, requirements_revision)
    REFERENCES app.project_requirements (project_id, revision)
    ON DELETE RESTRICT
);

ALTER TABLE app.projects
  ADD CONSTRAINT projects_classification_state_supported
    CHECK (classification_state IN ('unconfirmed', 'legacy_unverified', 'confirmed')),
  ADD CONSTRAINT projects_classification_state_consistent
    CHECK (
      (
        classification_state = 'unconfirmed'
        AND tier IS NULL
        AND needs_visitor_identity IS NULL
        AND current_confirmation_id IS NULL
      )
      OR (
        classification_state = 'legacy_unverified'
        AND requested_tier IS NULL
        AND requirements_revision = 0
        AND current_confirmation_id IS NULL
        AND tier IS NOT NULL
        AND tier IN ('A', 'B')
        AND needs_visitor_identity IS NOT NULL
      )
      OR (
        classification_state = 'confirmed'
        AND requirements_revision > 0
        AND current_confirmation_id IS NOT NULL
        AND tier IS NOT NULL
        AND tier IN ('A', 'B')
        AND needs_visitor_identity IS NOT NULL
      )
    ),
  ADD CONSTRAINT projects_current_confirmation_fk
    FOREIGN KEY (id, current_confirmation_id, requirements_revision)
    REFERENCES app.project_classification_confirmations
      (project_id, id, requirements_revision)
    ON DELETE RESTRICT;

CREATE TABLE app.project_classification_idempotency (
  owner_id uuid NOT NULL REFERENCES app.profiles (id),
  operation_scope text NOT NULL CHECK (
    operation_scope IN ('project_requirements_save_v1', 'project_classification_confirm_v1')
  ),
  idempotency_key uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES app.projects (id) ON DELETE RESTRICT,
  request_payload jsonb NOT NULL,
  response jsonb NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, operation_scope, idempotency_key),
  CHECK (expires_at = created_at + interval '24 hours')
);

ALTER TABLE app.project_requirements OWNER TO postgres;
ALTER TABLE app.project_classification_confirmations OWNER TO postgres;
ALTER TABLE app.project_classification_idempotency OWNER TO postgres;

ALTER TABLE app.project_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_requirements FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_classification_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_classification_confirmations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_classification_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_classification_idempotency FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE app.project_requirements,
  app.project_classification_confirmations,
  app.project_classification_idempotency
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.reject_project_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'project history is immutable';
END;
$function$;

ALTER FUNCTION app.reject_project_history_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION app.reject_project_history_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER project_requirements_immutable
  BEFORE UPDATE ON app.project_requirements
  FOR EACH ROW EXECUTE FUNCTION app.reject_project_history_mutation();
CREATE TRIGGER project_classification_confirmations_immutable
  BEFORE UPDATE ON app.project_classification_confirmations
  FOR EACH ROW EXECUTE FUNCTION app.reject_project_history_mutation();

GRANT USAGE ON SCHEMA app, auth TO app_project_writer;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_project_writer;
GRANT EXECUTE ON FUNCTION app.current_account_gate(text) TO app_project_writer;
GRANT SELECT (
  id, owner_id, title, tier, needs_visitor_identity, requested_tier,
  classification_state, stage, created_at, row_version,
  requirements_revision, current_confirmation_id
) ON app.projects TO app_project_writer;
GRANT UPDATE (
  tier, needs_visitor_identity, classification_state, row_version,
  requirements_revision, current_confirmation_id
) ON app.projects TO app_project_writer;
GRANT SELECT, INSERT ON app.project_requirements TO app_project_writer;
GRANT SELECT, INSERT ON app.project_classification_confirmations TO app_project_writer;
GRANT SELECT ON app.project_classification_idempotency TO app_project_writer;
GRANT INSERT (
  owner_id, operation_scope, idempotency_key, project_id,
  request_payload, created_at, expires_at
) ON app.project_classification_idempotency TO app_project_writer;
GRANT UPDATE (response) ON app.project_classification_idempotency TO app_project_writer;
GRANT DELETE ON app.project_classification_idempotency TO app_project_writer;

GRANT SELECT ON app.project_requirements, app.project_classification_confirmations
  TO authenticated;

CREATE POLICY project_requirements_read_owner
  ON app.project_requirements
  FOR SELECT TO authenticated
  USING (
    app.current_account_gate('read_saved_content')
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id AND project.owner_id = auth.uid()
    )
  );
CREATE POLICY project_requirements_writer_owner
  ON app.project_requirements
  FOR SELECT TO app_project_writer
  USING (
    app.current_account_gate('edit_saved_content')
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id AND project.owner_id = auth.uid()
    )
  );
CREATE POLICY project_requirements_writer_insert
  ON app.project_requirements
  FOR INSERT TO app_project_writer
  WITH CHECK (
    created_by = auth.uid()
    AND app.current_account_gate('edit_saved_content')
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id
        AND project.owner_id = auth.uid()
        AND revision = project.requirements_revision + 1
    )
  );

CREATE POLICY project_confirmations_read_owner
  ON app.project_classification_confirmations
  FOR SELECT TO authenticated
  USING (
    app.current_account_gate('read_saved_content')
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id AND project.owner_id = auth.uid()
    )
  );
CREATE POLICY project_confirmations_writer_owner
  ON app.project_classification_confirmations
  FOR SELECT TO app_project_writer
  USING (
    app.current_account_gate('edit_saved_content')
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id AND project.owner_id = auth.uid()
    )
  );
CREATE POLICY project_confirmations_writer_insert
  ON app.project_classification_confirmations
  FOR INSERT TO app_project_writer
  WITH CHECK (
    confirmed_by = auth.uid()
    AND source = 'student_explicit_confirmation'
    AND app.current_account_gate('edit_saved_content')
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id
        AND project.owner_id = auth.uid()
        AND project.requirements_revision = requirements_revision
    )
  );

CREATE POLICY project_classification_idempotency_writer_scope
  ON app.project_classification_idempotency
  FOR ALL TO app_project_writer
  USING (
    owner_id = auth.uid()
    AND app.current_account_gate('edit_saved_content')
  )
  WITH CHECK (
    owner_id = auth.uid()
    AND app.current_account_gate('edit_saved_content')
  );

CREATE POLICY projects_update_writer_own
  ON app.projects
  FOR UPDATE TO app_project_writer
  USING (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND owner_id = auth.uid()
  )
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND owner_id = auth.uid()
  );

CREATE FUNCTION app.save_project_requirements(
  p_project_id uuid,
  p_expected_row_version integer,
  p_expected_requirements_revision integer,
  p_description text,
  p_runtime_needs text,
  p_runtime_ai_required boolean,
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
  v_project app.projects%ROWTYPE;
  v_existing app.project_requirements%ROWTYPE;
  v_idempotency app.project_classification_idempotency%ROWTYPE;
  v_request jsonb;
  v_response jsonb;
  v_revision integer;
  v_row_version integer;
  v_changed boolean;
BEGIN
  IF p_project_id IS NULL
    OR p_expected_row_version IS NULL
    OR p_expected_requirements_revision IS NULL
    OR p_expected_requirements_revision < 0
    OR p_description IS NULL
    OR p_runtime_needs IS NULL
    OR p_runtime_needs NOT IN ('static', 'work_data_api', 'restricted_server')
    OR p_runtime_ai_required IS NULL
    OR p_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  v_owner := auth.uid();
  IF v_owner IS NULL OR NOT app.current_account_gate('edit_saved_content') THEN
    RETURN jsonb_build_object('outcome', 'denied');
  END IF;

  SELECT project.* INTO v_project
  FROM app.projects AS project
  WHERE project.id = p_project_id AND project.owner_id = v_owner
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  DELETE FROM app.project_classification_idempotency
  WHERE owner_id = v_owner
    AND operation_scope = 'project_requirements_save_v1'
    AND idempotency_key = p_idempotency_key
    AND expires_at <= statement_timestamp();

  v_request := jsonb_build_object(
    'project_id', p_project_id,
    'expected_row_version', p_expected_row_version,
    'expected_requirements_revision', p_expected_requirements_revision,
    'description', p_description,
    'runtime_needs', p_runtime_needs,
    'runtime_ai_required', p_runtime_ai_required
  );
  INSERT INTO app.project_classification_idempotency (
    owner_id, operation_scope, idempotency_key, project_id,
    request_payload, created_at, expires_at
  ) VALUES (
    v_owner, 'project_requirements_save_v1', p_idempotency_key, p_project_id,
    v_request, statement_timestamp(), statement_timestamp() + interval '24 hours'
  )
  ON CONFLICT (owner_id, operation_scope, idempotency_key) DO NOTHING;

  SELECT entry.* INTO STRICT v_idempotency
  FROM app.project_classification_idempotency AS entry
  WHERE entry.owner_id = v_owner
    AND entry.operation_scope = 'project_requirements_save_v1'
    AND entry.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF v_idempotency.project_id <> p_project_id
    OR v_idempotency.request_payload <> v_request THEN
    RETURN jsonb_build_object('outcome', 'idempotency_conflict');
  END IF;
  IF v_idempotency.response IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'replayed', 'operation', v_idempotency.response);
  END IF;
  IF v_project.row_version <> p_expected_row_version
    OR v_project.requirements_revision <> p_expected_requirements_revision THEN
    DELETE FROM app.project_classification_idempotency
    WHERE owner_id = v_owner
      AND operation_scope = 'project_requirements_save_v1'
      AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('outcome', 'version_conflict');
  END IF;

  v_changed := true;
  IF v_project.requirements_revision > 0 THEN
    SELECT requirement.* INTO STRICT v_existing
    FROM app.project_requirements AS requirement
    WHERE requirement.project_id = p_project_id
      AND requirement.revision = v_project.requirements_revision;
    v_changed :=
      convert_to(v_existing.description, 'UTF8') <> convert_to(p_description, 'UTF8')
      OR v_existing.runtime_needs <> p_runtime_needs
      OR v_existing.runtime_ai_required <> p_runtime_ai_required;
  END IF;

  IF NOT v_changed THEN
    v_revision := v_project.requirements_revision;
    v_row_version := v_project.row_version;
  ELSE
    IF v_project.requirements_revision = 2147483647
      OR v_project.row_version = 2147483647 THEN
      DELETE FROM app.project_classification_idempotency
      WHERE owner_id = v_owner
        AND operation_scope = 'project_requirements_save_v1'
        AND idempotency_key = p_idempotency_key;
      RETURN jsonb_build_object('outcome', 'version_exhausted');
    END IF;
    v_revision := v_project.requirements_revision + 1;
    INSERT INTO app.project_requirements (
      project_id, revision, description, runtime_needs,
      runtime_ai_required, created_by, created_at
    ) VALUES (
      p_project_id, v_revision, p_description, p_runtime_needs,
      p_runtime_ai_required, v_owner, clock_timestamp()
    );
    UPDATE app.projects
    SET requirements_revision = v_revision,
        classification_state = 'unconfirmed',
        tier = NULL,
        needs_visitor_identity = NULL,
        current_confirmation_id = NULL,
        row_version = row_version + 1
    WHERE id = p_project_id AND owner_id = v_owner
      AND row_version = p_expected_row_version
    RETURNING row_version INTO v_row_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'project requirements compare-and-swap failed';
    END IF;
  END IF;

  v_response := jsonb_build_object(
    'outcome', 'saved',
    'requirements_revision', v_revision,
    'requirements', jsonb_build_object(
      'description', p_description,
      'runtime_needs', p_runtime_needs,
      'runtime_ai_required', p_runtime_ai_required
    ),
    'row_version', v_row_version,
    'changed', v_changed
  );
  UPDATE app.project_classification_idempotency
  SET response = v_response
  WHERE owner_id = v_owner
    AND operation_scope = 'project_requirements_save_v1'
    AND idempotency_key = p_idempotency_key;
  RETURN jsonb_build_object('outcome', 'saved', 'operation', v_response);
END;
$function$;

CREATE FUNCTION app.confirm_project_classification(
  p_project_id uuid,
  p_expected_row_version integer,
  p_expected_requirements_revision integer,
  p_tier text,
  p_needs_visitor_identity boolean,
  p_requested_tier_acknowledgement text,
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
  v_project app.projects%ROWTYPE;
  v_requirement app.project_requirements%ROWTYPE;
  v_confirmation app.project_classification_confirmations%ROWTYPE;
  v_idempotency app.project_classification_idempotency%ROWTYPE;
  v_request jsonb;
  v_response jsonb;
  v_expected_acknowledgement text;
  v_row_version integer;
BEGIN
  IF p_project_id IS NULL
    OR p_expected_row_version IS NULL
    OR p_expected_requirements_revision IS NULL
    OR p_expected_requirements_revision <= 0
    OR p_tier IS NULL OR p_tier NOT IN ('A', 'B')
    OR p_needs_visitor_identity IS NULL
    OR p_requested_tier_acknowledgement IS NULL
    OR p_requested_tier_acknowledgement NOT IN ('no_preference', 'matches', 'explicit_change')
    OR p_idempotency_key IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  v_owner := auth.uid();
  IF v_owner IS NULL OR NOT app.current_account_gate('edit_saved_content') THEN
    RETURN jsonb_build_object('outcome', 'denied');
  END IF;

  SELECT project.* INTO v_project
  FROM app.projects AS project
  WHERE project.id = p_project_id AND project.owner_id = v_owner
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  DELETE FROM app.project_classification_idempotency
  WHERE owner_id = v_owner
    AND operation_scope = 'project_classification_confirm_v1'
    AND idempotency_key = p_idempotency_key
    AND expires_at <= statement_timestamp();

  v_request := jsonb_build_object(
    'project_id', p_project_id,
    'expected_row_version', p_expected_row_version,
    'expected_requirements_revision', p_expected_requirements_revision,
    'tier', p_tier,
    'needs_visitor_identity', p_needs_visitor_identity,
    'requested_tier_acknowledgement', p_requested_tier_acknowledgement
  );
  INSERT INTO app.project_classification_idempotency (
    owner_id, operation_scope, idempotency_key, project_id,
    request_payload, created_at, expires_at
  ) VALUES (
    v_owner, 'project_classification_confirm_v1', p_idempotency_key, p_project_id,
    v_request, statement_timestamp(), statement_timestamp() + interval '24 hours'
  )
  ON CONFLICT (owner_id, operation_scope, idempotency_key) DO NOTHING;

  SELECT entry.* INTO STRICT v_idempotency
  FROM app.project_classification_idempotency AS entry
  WHERE entry.owner_id = v_owner
    AND entry.operation_scope = 'project_classification_confirm_v1'
    AND entry.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF v_idempotency.project_id <> p_project_id
    OR v_idempotency.request_payload <> v_request THEN
    RETURN jsonb_build_object('outcome', 'idempotency_conflict');
  END IF;
  IF v_idempotency.response IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'replayed', 'operation', v_idempotency.response);
  END IF;
  IF v_project.row_version <> p_expected_row_version
    OR v_project.requirements_revision <> p_expected_requirements_revision THEN
    DELETE FROM app.project_classification_idempotency
    WHERE owner_id = v_owner
      AND operation_scope = 'project_classification_confirm_v1'
      AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('outcome', 'version_conflict');
  END IF;
  IF v_project.requirements_revision <= 0 THEN
    DELETE FROM app.project_classification_idempotency
    WHERE owner_id = v_owner
      AND operation_scope = 'project_classification_confirm_v1'
      AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('outcome', 'requirements_missing');
  END IF;

  SELECT requirement.* INTO STRICT v_requirement
  FROM app.project_requirements AS requirement
  WHERE requirement.project_id = p_project_id
    AND requirement.revision = v_project.requirements_revision;

  IF v_requirement.runtime_ai_required THEN
    DELETE FROM app.project_classification_idempotency
    WHERE owner_id = v_owner
      AND operation_scope = 'project_classification_confirm_v1'
      AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('outcome', 'unsupported_runtime_ai');
  END IF;
  IF v_requirement.runtime_needs = 'restricted_server' THEN
    DELETE FROM app.project_classification_idempotency
    WHERE owner_id = v_owner
      AND operation_scope = 'project_classification_confirm_v1'
      AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('outcome', 'unsupported_runtime');
  END IF;
  IF (p_tier = 'A' AND v_requirement.runtime_needs <> 'static')
    OR (p_tier = 'B' AND v_requirement.runtime_needs <> 'work_data_api') THEN
    DELETE FROM app.project_classification_idempotency
    WHERE owner_id = v_owner
      AND operation_scope = 'project_classification_confirm_v1'
      AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('outcome', 'inconsistent_input');
  END IF;

  v_expected_acknowledgement := CASE
    WHEN v_project.requested_tier IS NULL THEN 'no_preference'
    WHEN v_project.requested_tier = p_tier THEN 'matches'
    ELSE 'explicit_change'
  END;
  IF p_requested_tier_acknowledgement <> v_expected_acknowledgement THEN
    DELETE FROM app.project_classification_idempotency
    WHERE owner_id = v_owner
      AND operation_scope = 'project_classification_confirm_v1'
      AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('outcome', 'requested_tier_acknowledgement_required');
  END IF;
  IF v_project.row_version = 2147483647 THEN
    DELETE FROM app.project_classification_idempotency
    WHERE owner_id = v_owner
      AND operation_scope = 'project_classification_confirm_v1'
      AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object('outcome', 'version_exhausted');
  END IF;

  INSERT INTO app.project_classification_confirmations (
    project_id, requirements_revision, requirements_description,
    requirements_runtime_needs, requirements_runtime_ai_required,
    requested_tier_at_confirmation, requested_tier_acknowledgement,
    tier, needs_visitor_identity, confirmed_by, confirmed_at, source
  ) VALUES (
    p_project_id, v_requirement.revision, v_requirement.description,
    v_requirement.runtime_needs, v_requirement.runtime_ai_required,
    v_project.requested_tier, v_expected_acknowledgement,
    p_tier, p_needs_visitor_identity, v_owner, clock_timestamp(),
    'student_explicit_confirmation'
  )
  RETURNING * INTO v_confirmation;

  UPDATE app.projects
  SET classification_state = 'confirmed',
      tier = p_tier,
      needs_visitor_identity = p_needs_visitor_identity,
      current_confirmation_id = v_confirmation.id,
      row_version = row_version + 1
  WHERE id = p_project_id AND owner_id = v_owner
    AND row_version = p_expected_row_version
    AND requirements_revision = p_expected_requirements_revision
  RETURNING row_version INTO v_row_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project classification compare-and-swap failed';
  END IF;

  v_response := jsonb_build_object(
    'outcome', 'confirmed',
    'requirements_revision', v_requirement.revision,
    'tier', p_tier,
    'needs_visitor_identity', p_needs_visitor_identity,
    'confirmation', jsonb_build_object(
      'id', v_confirmation.id::text,
      'requirements_revision', v_confirmation.requirements_revision,
      'confirmed_by', v_confirmation.confirmed_by::text,
      'confirmed_at', to_char(v_confirmation.confirmed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'source', v_confirmation.source
    ),
    'row_version', v_row_version
  );
  UPDATE app.project_classification_idempotency
  SET response = v_response
  WHERE owner_id = v_owner
    AND operation_scope = 'project_classification_confirm_v1'
    AND idempotency_key = p_idempotency_key;
  RETURN jsonb_build_object('outcome', 'confirmed', 'operation', v_response);
END;
$function$;

GRANT CREATE ON SCHEMA app TO app_project_writer;
GRANT app_project_writer TO supabase_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
ALTER FUNCTION app.save_project_requirements(uuid, integer, integer, text, text, boolean, uuid)
  OWNER TO app_project_writer;
ALTER FUNCTION app.confirm_project_classification(uuid, integer, integer, text, boolean, text, uuid)
  OWNER TO app_project_writer;
REVOKE app_project_writer FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_project_writer;
REVOKE ALL ON FUNCTION app.save_project_requirements(uuid, integer, integer, text, text, boolean, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app.confirm_project_classification(uuid, integer, integer, text, boolean, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.save_project_requirements(uuid, integer, integer, text, text, boolean, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION app.confirm_project_classification(uuid, integer, integer, text, boolean, text, uuid)
  TO authenticated;

COMMIT;
