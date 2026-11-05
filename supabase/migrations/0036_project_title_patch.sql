BEGIN;

CREATE ROLE app_project_rename_writer
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
REVOKE CREATE ON SCHEMA app FROM app_project_rename_writer;
GRANT USAGE ON SCHEMA app, auth TO app_project_rename_writer;
GRANT EXECUTE ON FUNCTION auth.uid(), app.current_account_gate(text)
  TO app_project_rename_writer;

GRANT SELECT (id, role, school_id), UPDATE (id)
  ON app.profiles TO app_project_rename_writer;
GRANT SELECT (id), UPDATE (id)
  ON app.schools TO app_project_rename_writer;
GRANT SELECT (id, owner_id, title, row_version),
  UPDATE (title, row_version) ON app.projects TO app_project_rename_writer;

CREATE TABLE app.project_rename_receipts (
  owner_id uuid NOT NULL REFERENCES app.profiles(id),
  operation_scope text NOT NULL CHECK (operation_scope = 'project_title_patch_v1'),
  idempotency_key uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE RESTRICT,
  request_title text NOT NULL,
  expected_row_version integer NOT NULL CHECK (expected_row_version >= 0),
  response jsonb NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, operation_scope, idempotency_key),
  CHECK (expires_at = created_at + interval '24 hours')
);

ALTER TABLE app.project_rename_receipts OWNER TO postgres;
ALTER TABLE app.project_rename_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_rename_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.project_rename_receipts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON app.project_rename_receipts TO app_project_rename_writer;
GRANT INSERT (
  owner_id, operation_scope, idempotency_key, project_id, request_title,
  expected_row_version, created_at, expires_at
) ON app.project_rename_receipts TO app_project_rename_writer;
GRANT UPDATE (response) ON app.project_rename_receipts TO app_project_rename_writer;
GRANT DELETE ON app.project_rename_receipts TO app_project_rename_writer;

CREATE POLICY project_rename_profiles_read
  ON app.profiles FOR SELECT TO app_project_rename_writer USING (true);
CREATE POLICY project_rename_profiles_lock
  ON app.profiles FOR UPDATE TO app_project_rename_writer USING (true) WITH CHECK (false);
CREATE POLICY project_rename_schools_read
  ON app.schools FOR SELECT TO app_project_rename_writer USING (true);
CREATE POLICY project_rename_schools_lock
  ON app.schools FOR UPDATE TO app_project_rename_writer USING (true) WITH CHECK (false);
CREATE POLICY project_rename_projects_read
  ON app.projects FOR SELECT TO app_project_rename_writer
  USING (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND owner_id = auth.uid()
  );
CREATE POLICY project_rename_projects_update
  ON app.projects FOR UPDATE TO app_project_rename_writer
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
CREATE POLICY project_rename_receipts_scope
  ON app.project_rename_receipts FOR ALL TO app_project_rename_writer
  USING (
    owner_id = auth.uid()
    AND operation_scope = 'project_title_patch_v1'
    AND app.current_account_gate('edit_saved_content')
  )
  WITH CHECK (
    owner_id = auth.uid()
    AND operation_scope = 'project_title_patch_v1'
    AND app.current_account_gate('edit_saved_content')
  );

CREATE FUNCTION app.patch_project_title(
  p_project uuid,
  p_title text,
  p_expected_row_version integer,
  p_idempotency_key uuid,
  p_replay_only boolean
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_owner uuid := auth.uid();
  v_profile_role text;
  v_school_id uuid;
  v_project_id uuid;
  v_project_owner uuid;
  v_project_title text;
  v_project_row_version integer;
  v_receipt app.project_rename_receipts%ROWTYPE;
  v_operation jsonb;
  v_current jsonb;
  v_now timestamptz;
  v_has_receipt boolean := false;
BEGIN
  IF p_project IS NULL OR p_title IS NULL OR p_expected_row_version IS NULL
    OR p_expected_row_version < 0 OR p_idempotency_key IS NULL OR p_replay_only IS NULL THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;
  IF v_owner IS NULL OR NOT app.current_account_gate('edit_saved_content') THEN
    RETURN '{"outcome":"denied"}';
  END IF;
  SELECT profile.role INTO v_profile_role
    FROM app.profiles AS profile WHERE profile.id = v_owner;
  IF NOT FOUND OR v_profile_role <> 'student' THEN
    RETURN '{"outcome":"denied"}';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_owner::text || ':project_title_patch_v1:' || p_idempotency_key::text, 0
  ));

  SELECT profile.role, profile.school_id INTO v_profile_role, v_school_id
    FROM app.profiles AS profile WHERE profile.id = v_owner FOR SHARE;
  IF NOT FOUND OR v_profile_role <> 'student'
    OR NOT app.current_account_gate('edit_saved_content') THEN
    RETURN '{"outcome":"denied"}';
  END IF;
  PERFORM school.id
    FROM app.schools AS school WHERE school.id = v_school_id FOR SHARE;
  IF NOT FOUND OR NOT app.current_account_gate('edit_saved_content') THEN
    RETURN '{"outcome":"denied"}';
  END IF;

  SELECT project.id, project.owner_id, project.title, project.row_version
    INTO v_project_id, v_project_owner, v_project_title, v_project_row_version
    FROM app.projects AS project
    WHERE project.id = p_project AND project.owner_id = v_owner
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN '{"outcome":"not_found"}';
  END IF;
  IF auth.uid() IS DISTINCT FROM v_owner
    OR v_profile_role <> 'student'
    OR NOT app.current_account_gate('edit_saved_content')
    OR v_project_owner IS DISTINCT FROM v_owner THEN
    RETURN '{"outcome":"denied"}';
  END IF;

  v_now := clock_timestamp();
  SELECT receipt.* INTO v_receipt
    FROM app.project_rename_receipts AS receipt
    WHERE receipt.owner_id = v_owner
      AND receipt.operation_scope = 'project_title_patch_v1'
      AND receipt.idempotency_key = p_idempotency_key
    FOR UPDATE;
  v_has_receipt := FOUND;
  IF auth.uid() IS DISTINCT FROM v_owner
    OR v_profile_role <> 'student'
    OR NOT app.current_account_gate('edit_saved_content')
    OR v_project_owner IS DISTINCT FROM v_owner THEN
    RETURN '{"outcome":"denied"}';
  END IF;
  IF v_has_receipt AND v_receipt.expires_at <= v_now THEN
    IF p_replay_only THEN
      RETURN '{"outcome":"unrecoverable"}';
    END IF;
    DELETE FROM app.project_rename_receipts
      WHERE owner_id = v_owner
        AND operation_scope = 'project_title_patch_v1'
        AND idempotency_key = p_idempotency_key;
    v_has_receipt := false;
  END IF;

  IF v_has_receipt THEN
    IF v_receipt.project_id IS DISTINCT FROM p_project
      OR pg_catalog.convert_to(v_receipt.request_title, 'UTF8')
        IS DISTINCT FROM pg_catalog.convert_to(p_title, 'UTF8')
      OR v_receipt.expected_row_version IS DISTINCT FROM p_expected_row_version THEN
      RETURN '{"outcome":"idempotency_conflict"}';
    END IF;
    v_current := pg_catalog.jsonb_build_object(
      'id', v_project_id, 'title', v_project_title, 'row_version', v_project_row_version
    );
    IF v_receipt.response IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'outcome', 'version_conflict',
        'conflict', pg_catalog.jsonb_build_object(
          'current', pg_catalog.jsonb_build_object(
            'version', v_project_row_version,
            'content', pg_catalog.jsonb_build_object('title', v_project_title)
          ),
          'submitted', pg_catalog.jsonb_build_object(
            'version', p_expected_row_version, 'content', pg_catalog.jsonb_build_object('title', p_title)
          )
        )
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'replayed', 'operation', v_receipt.response, 'current', v_current
    );
  END IF;

  IF p_replay_only THEN
    RETURN '{"outcome":"unrecoverable"}';
  END IF;

  INSERT INTO app.project_rename_receipts (
    owner_id, operation_scope, idempotency_key, project_id, request_title,
    expected_row_version, created_at, expires_at
  ) VALUES (
    v_owner, 'project_title_patch_v1', p_idempotency_key, p_project, p_title,
    p_expected_row_version, v_now, v_now + interval '24 hours'
  );

  IF v_project_row_version IS DISTINCT FROM p_expected_row_version
    OR v_project_row_version = 2147483647 THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'version_conflict',
      'conflict', pg_catalog.jsonb_build_object(
        'current', pg_catalog.jsonb_build_object(
          'version', v_project_row_version, 'content', pg_catalog.jsonb_build_object('title', v_project_title)
        ),
        'submitted', pg_catalog.jsonb_build_object(
          'version', p_expected_row_version, 'content', pg_catalog.jsonb_build_object('title', p_title)
        )
      )
    );
  END IF;

  UPDATE app.projects AS project
    SET title = p_title, row_version = project.row_version + 1
    WHERE project.id = p_project
      AND project.owner_id = v_owner
      AND project.row_version = p_expected_row_version
    RETURNING pg_catalog.jsonb_build_object(
      'id', project.id, 'title', project.title, 'row_version', project.row_version
    ) INTO v_operation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project title compare-and-swap failed';
  END IF;

  UPDATE app.project_rename_receipts
    SET response = v_operation
    WHERE owner_id = v_owner
      AND operation_scope = 'project_title_patch_v1'
      AND idempotency_key = p_idempotency_key;
  RETURN pg_catalog.jsonb_build_object(
    'outcome', 'saved', 'operation', v_operation, 'current', v_operation
  );
END
$function$;

ALTER FUNCTION app.patch_project_title(uuid, text, integer, uuid, boolean)
  OWNER TO app_project_rename_writer;
REVOKE ALL ON FUNCTION app.patch_project_title(uuid, text, integer, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.patch_project_title(uuid, text, integer, uuid, boolean)
  TO authenticated;

COMMIT;
