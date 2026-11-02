BEGIN;

-- 本人手動任務清單首次匯入：確認紀錄與任務同交易保存；不改寫 0022／0023 既有物件。
CREATE TABLE app.project_task_imports (
  project_id uuid PRIMARY KEY REFERENCES app.projects (id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  task_ids uuid[] NOT NULL CHECK (cardinality(task_ids) BETWEEN 1 AND 50),
  source text NOT NULL DEFAULT 'student_manual' CHECK (source = 'student_manual'),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, idempotency_key)
);
ALTER TABLE app.project_task_imports OWNER TO postgres;
ALTER TABLE app.project_task_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_task_imports FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.project_task_imports FROM PUBLIC, anon, authenticated, service_role;

CREATE ROLE app_project_task_importer WITH NOLOGIN NOINHERIT NOBYPASSRLS;
REVOKE CREATE ON SCHEMA app FROM app_project_task_importer;
GRANT USAGE ON SCHEMA app, auth TO app_project_task_importer;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_project_task_importer;
GRANT EXECUTE ON FUNCTION app.current_account_gate(text) TO app_project_task_importer;
GRANT SELECT (id, owner_id) ON app.projects TO app_project_task_importer;
GRANT SELECT (id, project_id, "order", title, done, row_version)
  ON app.tasks TO app_project_task_importer;
GRANT INSERT (project_id, "order", title) ON app.tasks TO app_project_task_importer;
GRANT SELECT, INSERT ON app.project_task_imports TO app_project_task_importer;

CREATE POLICY projects_task_importer_read_own
  ON app.projects
  FOR SELECT
  TO app_project_task_importer
  USING (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND owner_id = auth.uid()
  );

CREATE POLICY tasks_importer_read_own
  ON app.tasks
  FOR SELECT
  TO app_project_task_importer
  USING (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id AND project.owner_id = auth.uid()
    )
  );

CREATE POLICY tasks_importer_insert_own
  ON app.tasks
  FOR INSERT
  TO app_project_task_importer
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND done = false
    AND done_snapshot_id IS NULL
    AND row_version = 0
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id AND project.owner_id = auth.uid()
    )
  );

CREATE POLICY task_imports_importer_read_own
  ON app.project_task_imports
  FOR SELECT
  TO app_project_task_importer
  USING (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND owner_id = auth.uid()
  );

CREATE POLICY task_imports_importer_insert_own
  ON app.project_task_imports
  FOR INSERT
  TO app_project_task_importer
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND owner_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id AND project.owner_id = auth.uid()
    )
  );

CREATE FUNCTION app.import_owned_project_tasks(
  p_project_id uuid,
  p_idempotency_key uuid,
  p_titles jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_owner uuid;
  v_hash text;
  v_import record;
  v_by_key record;
  v_ids uuid[];
  v_tasks jsonb;
BEGIN
  IF p_project_id IS NULL OR p_idempotency_key IS NULL OR p_titles IS NULL
    OR jsonb_typeof(p_titles) <> 'array'
    OR jsonb_array_length(p_titles) NOT BETWEEN 1 AND 50
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_titles) AS item(value)
      WHERE jsonb_typeof(item.value) <> 'string'
        OR btrim(item.value #>> '{}') = ''
        OR char_length(item.value #>> '{}') > 200
        OR (item.value #>> '{}') ~ '[[:cntrl:]]'
    ) THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  v_owner := auth.uid();
  IF v_owner IS NULL OR NOT app.current_account_gate('edit_saved_content') THEN
    RETURN jsonb_build_object('outcome', 'denied');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.projects AS project
    WHERE project.id = p_project_id AND project.owner_id = v_owner
  ) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- 同一專案的首次匯入序列化；後到者鎖釋放後重新讀取已提交結果。
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended('app.project_task_import:' || p_project_id::text, 0)
  );
  IF auth.uid() IS DISTINCT FROM v_owner OR NOT app.current_account_gate('edit_saved_content') THEN
    RETURN jsonb_build_object('outcome', 'denied');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.projects AS project
    WHERE project.id = p_project_id AND project.owner_id = v_owner
  ) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  v_hash := encode(pg_catalog.sha256(convert_to(p_titles::text, 'UTF8')), 'hex');

  SELECT i.project_id, i.idempotency_key, i.request_hash, i.task_ids
  INTO v_import
  FROM app.project_task_imports AS i
  WHERE i.project_id = p_project_id AND i.owner_id = v_owner;

  IF FOUND THEN
    IF v_import.idempotency_key <> p_idempotency_key THEN
      RETURN jsonb_build_object('outcome', 'tasks_exist');
    END IF;
    IF v_import.request_hash <> v_hash THEN
      RETURN jsonb_build_object('outcome', 'key_reuse');
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', task.id, 'project_id', task.project_id, 'order', task."order",
      'title', task.title, 'done', task.done, 'row_version', task.row_version
    ) ORDER BY task."order", task.id), '[]'::jsonb)
    INTO v_tasks
    FROM app.tasks AS task
    WHERE task.project_id = p_project_id;
    RETURN jsonb_build_object('outcome', 'replayed', 'tasks', v_tasks);
  END IF;

  SELECT i.project_id INTO v_by_key
  FROM app.project_task_imports AS i
  WHERE i.owner_id = v_owner AND i.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'key_reuse');
  END IF;

  IF EXISTS (SELECT 1 FROM app.tasks AS task WHERE task.project_id = p_project_id) THEN
    RETURN jsonb_build_object('outcome', 'tasks_exist');
  END IF;

  WITH inserted AS (
    INSERT INTO app.tasks (project_id, "order", title)
    SELECT p_project_id, item.position::integer, item.value #>> '{}'
    FROM jsonb_array_elements(p_titles) WITH ORDINALITY AS item(value, position)
    RETURNING id, project_id, "order", title, done, row_version
  )
  SELECT array_agg(inserted.id ORDER BY inserted."order"),
    jsonb_agg(jsonb_build_object(
      'id', inserted.id, 'project_id', inserted.project_id, 'order', inserted."order",
      'title', inserted.title, 'done', inserted.done, 'row_version', inserted.row_version
    ) ORDER BY inserted."order")
  INTO v_ids, v_tasks
  FROM inserted;

  INSERT INTO app.project_task_imports (project_id, owner_id, idempotency_key, request_hash, task_ids)
  VALUES (p_project_id, v_owner, p_idempotency_key, v_hash, v_ids);

  RETURN jsonb_build_object('outcome', 'created', 'tasks', v_tasks);
END;
$function$;

REVOKE ALL ON FUNCTION app.import_owned_project_tasks(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.import_owned_project_tasks(uuid, uuid, jsonb)
  TO authenticated;

GRANT CREATE ON SCHEMA app TO app_project_task_importer;
GRANT app_project_task_importer TO supabase_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
ALTER FUNCTION app.import_owned_project_tasks(uuid, uuid, jsonb)
  OWNER TO app_project_task_importer;
REVOKE app_project_task_importer FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_project_task_importer;

COMMIT;
