BEGIN;

CREATE TABLE app.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES app.projects (id) ON DELETE RESTRICT,
  "order" integer NOT NULL,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  done_snapshot_id uuid NULL,
  row_version integer NOT NULL DEFAULT 0 CHECK (row_version >= 0)
);
ALTER TABLE app.tasks OWNER TO postgres;
CREATE INDEX tasks_project_order_id ON app.tasks (project_id, "order", id);

ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.tasks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE app.tasks TO authenticated;

CREATE ROLE app_project_task_writer WITH NOLOGIN NOINHERIT NOBYPASSRLS;
REVOKE CREATE ON SCHEMA app FROM app_project_task_writer;
GRANT USAGE ON SCHEMA app, auth TO app_project_task_writer;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_project_task_writer;
GRANT EXECUTE ON FUNCTION app.current_account_gate(text) TO app_project_task_writer;
GRANT SELECT (id, owner_id) ON app.projects TO app_project_task_writer;
GRANT SELECT (id, project_id, "order", title, done, row_version)
  ON app.tasks TO app_project_task_writer;
GRANT UPDATE (done, row_version) ON app.tasks TO app_project_task_writer;

CREATE POLICY tasks_read_own_saved_content
  ON app.tasks
  FOR SELECT
  TO authenticated
  USING (
    app.current_account_gate('read_saved_content')
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id AND project.owner_id = auth.uid()
    )
  );

CREATE POLICY projects_task_writer_read_own
  ON app.projects
  FOR SELECT
  TO app_project_task_writer
  USING (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND owner_id = auth.uid()
  );

CREATE POLICY tasks_writer_read_own
  ON app.tasks
  FOR SELECT
  TO app_project_task_writer
  USING (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id AND project.owner_id = auth.uid()
    )
  );

CREATE POLICY tasks_writer_update_own_done
  ON app.tasks
  FOR UPDATE
  TO app_project_task_writer
  USING (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id AND project.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND app.current_account_gate('edit_saved_content')
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = project_id AND project.owner_id = auth.uid()
    )
  );

CREATE FUNCTION app.patch_owned_project_task_done(
  p_project_id uuid,
  p_task_id uuid,
  p_expected_row_version integer,
  p_done boolean
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_owner uuid;
  v_current record;
  v_saved record;
BEGIN
  IF p_project_id IS NULL OR p_task_id IS NULL
    OR p_expected_row_version IS NULL OR p_expected_row_version < 0
    OR p_done IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  v_owner := auth.uid();
  IF v_owner IS NULL OR NOT app.current_account_gate('edit_saved_content') THEN
    RETURN jsonb_build_object('outcome', 'denied');
  END IF;

  SELECT task.id, task.project_id, task."order", task.title, task.done, task.row_version
  INTO v_current
  FROM app.tasks AS task
  JOIN app.projects AS project ON project.id = task.project_id
  WHERE task.id = p_task_id
    AND task.project_id = p_project_id
    AND project.owner_id = v_owner
  FOR UPDATE OF task;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF NOT app.current_account_gate('edit_saved_content') THEN
    RETURN jsonb_build_object('outcome', 'denied');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.projects AS project
    WHERE project.id = p_project_id AND project.owner_id = v_owner
  ) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_current.row_version <> p_expected_row_version THEN
    RETURN jsonb_build_object(
      'outcome', 'version_conflict',
      'conflict', jsonb_build_object(
        'current', jsonb_build_object(
          'version', v_current.row_version,
          'content', jsonb_build_object('done', v_current.done)
        ),
        'submitted', jsonb_build_object(
          'version', p_expected_row_version,
          'content', jsonb_build_object('done', p_done)
        )
      )
    );
  END IF;
  IF v_current.row_version = 2147483647 THEN
    RETURN jsonb_build_object('outcome', 'version_exhausted');
  END IF;

  UPDATE app.tasks AS task
  SET done = p_done,
      row_version = task.row_version + 1
  WHERE task.id = p_task_id
    AND task.project_id = p_project_id
    AND task.row_version = p_expected_row_version
    AND auth.uid() = v_owner
    AND app.current_account_gate('edit_saved_content')
    AND EXISTS (
      SELECT 1 FROM app.projects AS project
      WHERE project.id = p_project_id AND project.owner_id = v_owner
    )
  RETURNING task.id, task.project_id, task."order", task.title, task.done, task.row_version
  INTO v_saved;

  IF NOT FOUND THEN
    IF NOT app.current_account_gate('edit_saved_content') THEN
      RETURN jsonb_build_object('outcome', 'denied');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM app.tasks AS task
      JOIN app.projects AS project ON project.id = task.project_id
      WHERE task.id = p_task_id AND task.project_id = p_project_id
        AND project.owner_id = v_owner
    ) THEN
      RETURN jsonb_build_object('outcome', 'not_found');
    END IF;
    SELECT task.id, task.project_id, task."order", task.title, task.done, task.row_version
    INTO STRICT v_current
    FROM app.tasks AS task
    WHERE task.id = p_task_id AND task.project_id = p_project_id;
    RETURN jsonb_build_object(
      'outcome', 'version_conflict',
      'conflict', jsonb_build_object(
        'current', jsonb_build_object(
          'version', v_current.row_version,
          'content', jsonb_build_object('done', v_current.done)
        ),
        'submitted', jsonb_build_object(
          'version', p_expected_row_version,
          'content', jsonb_build_object('done', p_done)
        )
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'saved',
    'task', jsonb_build_object(
      'id', v_saved.id,
      'project_id', v_saved.project_id,
      'order', v_saved."order",
      'title', v_saved.title,
      'done', v_saved.done,
      'row_version', v_saved.row_version
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION app.patch_owned_project_task_done(uuid, uuid, integer, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.patch_owned_project_task_done(uuid, uuid, integer, boolean)
  TO authenticated;

GRANT CREATE ON SCHEMA app TO app_project_task_writer;
GRANT app_project_task_writer TO supabase_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
ALTER FUNCTION app.patch_owned_project_task_done(uuid, uuid, integer, boolean)
  OWNER TO app_project_task_writer;
REVOKE app_project_task_writer FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_project_task_writer;

COMMIT;
