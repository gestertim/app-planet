BEGIN;

ALTER TABLE app.snapshots DROP CONSTRAINT snapshots_kind_check;
ALTER TABLE app.snapshots ADD CONSTRAINT snapshots_kind_check
  CHECK (kind IN ('manual', 'pre_restore'));

DROP POLICY project_file_writer_snapshots_insert ON app.snapshots;
CREATE POLICY project_file_writer_snapshots_insert ON app.snapshots
  FOR INSERT TO app_project_file_writer
  WITH CHECK (created_by = auth.uid() AND kind IN ('manual', 'pre_restore') AND immutable = false
    AND app.current_account_gate('edit_saved_content') AND EXISTS (
      SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid()));

ALTER TABLE app.project_file_audit DROP CONSTRAINT project_file_audit_action_check;
ALTER TABLE app.project_file_audit ADD CONSTRAINT project_file_audit_action_check
  CHECK (action IN ('file_created', 'file_updated', 'manual_snapshot_created', 'project_restored'));

CREATE TABLE app.project_restore_receipts (
  owner_id uuid NOT NULL REFERENCES app.profiles(id),
  project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE RESTRICT,
  operation_scope text NOT NULL CHECK (operation_scope = 'project_snapshot_restore_v1'),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  target_snapshot_id uuid NOT NULL,
  response jsonb NOT NULL CHECK (
    jsonb_typeof(response) = 'object'
    AND response ? 'pre_restore_snapshot_id'
    AND jsonb_typeof(response->'pre_restore_snapshot_id') = 'string'
    AND response = jsonb_build_object('pre_restore_snapshot_id', response->'pre_restore_snapshot_id')
  ),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, project_id, operation_scope, idempotency_key),
  FOREIGN KEY (target_snapshot_id, project_id) REFERENCES app.snapshots(id, project_id) ON DELETE RESTRICT,
  CHECK (expires_at = created_at + interval '24 hours')
);

ALTER TABLE app.project_restore_receipts OWNER TO postgres;
ALTER TABLE app.project_restore_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_restore_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.project_restore_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON app.project_restore_receipts TO app_project_file_writer;
GRANT DELETE ON app.project_files TO app_project_file_writer;
CREATE POLICY project_file_writer_restore_receipts_access ON app.project_restore_receipts
  FOR ALL TO app_project_file_writer
  USING (owner_id = auth.uid() AND app.current_account_gate('edit_saved_content'))
  WITH CHECK (owner_id = auth.uid() AND app.current_account_gate('edit_saved_content'));

CREATE FUNCTION app.restore_project_snapshot(
  p_project uuid, p_snapshot uuid, p_idempotency_key uuid, p_replay_only boolean
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_owner uuid := auth.uid();
  v_role text;
  v_school uuid;
  v_receipt app.project_restore_receipts%ROWTYPE;
  v_request_hash text;
  v_snapshot app.snapshots%ROWTYPE;
  v_pre_restore uuid;
  v_version integer;
  v_manifest jsonb;
  v_content_hash text;
  v_budget bigint;
  v_now timestamptz;
  v_aid uuid;
  v_changes jsonb;
  v_response jsonb;
BEGIN
  IF p_project IS NULL OR p_snapshot IS NULL OR p_idempotency_key IS NULL THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;
  v_request_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    'project_snapshot_restore_v1', p_project, p_snapshot
  )::text,'UTF8'),'sha256'),'hex');
  IF v_owner IS NULL THEN RETURN '{"outcome":"denied"}'; END IF;
  SELECT role::text, school_id INTO v_role, v_school
    FROM app.profiles WHERE id = v_owner FOR SHARE;
  IF NOT FOUND OR v_role <> 'student' THEN RETURN '{"outcome":"denied"}'; END IF;
  PERFORM id FROM app.schools WHERE id = v_school FOR SHARE;
  IF NOT FOUND OR NOT app.current_account_gate('edit_saved_content')
    OR NOT app.current_account_gate('read_saved_content') THEN
    RETURN '{"outcome":"denied"}';
  END IF;
  PERFORM id FROM app.projects WHERE id = p_project AND owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN '{"outcome":"not_found"}'; END IF;

  SELECT * INTO v_receipt FROM app.project_restore_receipts
    WHERE owner_id = v_owner AND project_id = p_project
      AND operation_scope = 'project_snapshot_restore_v1' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_receipt.request_hash <> v_request_hash THEN
      RETURN '{"outcome":"idempotency_key_reuse"}';
    END IF;
    IF v_receipt.expires_at <= clock_timestamp() THEN RETURN '{"outcome":"unrecoverable"}'; END IF;
    RETURN jsonb_build_object('outcome','replayed',
      'pre_restore_snapshot_id',v_receipt.response->'pre_restore_snapshot_id');
  END IF;
  IF p_replay_only THEN RETURN '{"outcome":"unrecoverable"}'; END IF;

  SELECT * INTO v_snapshot FROM app.snapshots
    WHERE id = p_snapshot AND project_id = p_project AND kind IN ('manual', 'pre_restore');
  IF NOT FOUND THEN RETURN '{"outcome":"not_found"}'; END IF;

  SELECT coalesce(sum(f.bytes::bigint + octet_length(f.path)::bigint + 64
      + length(f.bytes::text)::bigint + 3),0)
    INTO v_budget FROM app.project_files f WHERE f.project_id = p_project;
  IF v_budget > 16777216 THEN RETURN '{"outcome":"save_failed"}'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'path',f.path,'hash',f.blob_hash,'bytes',f.bytes) ORDER BY f.path COLLATE "C"),'[]'::jsonb)
    INTO v_manifest FROM app.project_files f WHERE f.project_id = p_project;
  v_content_hash := encode(extensions.digest(
    coalesce((SELECT string_agg(
      convert_to(f.path,'UTF8') || decode('00','hex') || convert_to(f.blob_hash,'UTF8')
        || decode('00','hex') || convert_to(f.bytes::text || E'\n','UTF8'),
      ''::bytea ORDER BY f.path COLLATE "C")
      FROM app.project_files f WHERE f.project_id = p_project), ''::bytea), 'sha256'), 'hex');
  v_now := clock_timestamp();
  SELECT coalesce(max(version_no),0)+1 INTO v_version
    FROM app.snapshots WHERE project_id = p_project;
  v_pre_restore := gen_random_uuid();

  v_changes := jsonb_build_object(
    'added',coalesce((SELECT jsonb_agg(current.path ORDER BY current.path COLLATE "C")
      FROM app.project_files current WHERE current.project_id = p_project
        AND NOT EXISTS (SELECT 1 FROM app.snapshot_files prior
          JOIN app.snapshots previous ON previous.id = prior.snapshot_id
          WHERE previous.project_id = p_project AND previous.version_no = v_version-1
            AND prior.path = current.path)), '[]'::jsonb),
    'changed',coalesce((SELECT jsonb_agg(current.path ORDER BY current.path COLLATE "C")
      FROM app.project_files current JOIN app.snapshot_files prior ON prior.path = current.path
      JOIN app.snapshots previous ON previous.id = prior.snapshot_id
        AND previous.project_id = p_project AND previous.version_no = v_version-1
      WHERE current.project_id = p_project
        AND (prior.blob_hash <> current.blob_hash OR prior.bytes <> current.bytes)), '[]'::jsonb),
    'removed',coalesce((SELECT jsonb_agg(prior.path ORDER BY prior.path COLLATE "C")
      FROM app.snapshot_files prior JOIN app.snapshots previous ON previous.id = prior.snapshot_id
        AND previous.project_id = p_project AND previous.version_no = v_version-1
      WHERE NOT EXISTS (SELECT 1 FROM app.project_files current
        WHERE current.project_id = p_project AND current.path = prior.path)), '[]'::jsonb)
  );
  BEGIN
    INSERT INTO app.snapshots(
      id,project_id,version_no,kind,manifest,content_hash,immutable,message,created_by,created_at
    ) VALUES (
      v_pre_restore,p_project,v_version,'pre_restore',v_manifest,v_content_hash,false,NULL,v_owner,v_now
    );
    INSERT INTO app.snapshot_files(snapshot_id,project_id,path,blob_hash,bytes)
      SELECT v_pre_restore,p_project,path,blob_hash,bytes
      FROM app.project_files WHERE project_id = p_project;
  EXCEPTION WHEN OTHERS THEN
    RETURN '{"outcome":"save_failed"}';
  END;

  PERFORM set_config('app.project_restore_in_progress','1',true);
  INSERT INTO app.project_files(project_id,path,blob_hash,bytes,row_version,created_at,updated_at)
    SELECT p_project,target.path,target.blob_hash,target.bytes,
      coalesce(current.row_version + 1,0),coalesce(current.created_at,v_now),v_now
    FROM app.snapshot_files target
    LEFT JOIN app.project_files current ON current.project_id = p_project AND current.path = target.path
    WHERE target.snapshot_id = p_snapshot
    ON CONFLICT (project_id,path) DO UPDATE SET
      blob_hash = EXCLUDED.blob_hash,
      bytes = EXCLUDED.bytes,
      row_version = app.project_files.row_version + 1,
      updated_at = EXCLUDED.updated_at;
  DELETE FROM app.project_files current
    WHERE current.project_id = p_project
      AND NOT EXISTS (SELECT 1 FROM app.snapshot_files target
        WHERE target.snapshot_id = p_snapshot AND target.path = current.path);

  INSERT INTO app.audit_identity_map(aid,account_id,created_at)
    VALUES(gen_random_uuid(),v_owner,v_now) ON CONFLICT(account_id) DO NOTHING;
  SELECT aid INTO v_aid FROM app.audit_identity_map WHERE account_id = v_owner;
  INSERT INTO app.project_file_audit(id,actor_aid,project_id,action,object_ref,content_hash,at)
    VALUES(gen_random_uuid(),v_aid,p_project,'project_restored',
      v_snapshot.id::text || '>' || v_pre_restore::text,v_snapshot.content_hash,v_now);

  v_response := jsonb_build_object('pre_restore_snapshot_id',v_pre_restore);
  INSERT INTO app.project_restore_receipts(
    owner_id,project_id,operation_scope,idempotency_key,request_hash,target_snapshot_id,
    response,created_at,expires_at
  ) VALUES (
    v_owner,p_project,'project_snapshot_restore_v1',p_idempotency_key,v_request_hash,p_snapshot,
    v_response,v_now,v_now + interval '24 hours'
  );
  RETURN jsonb_build_object('outcome','restored',
    'pre_restore_snapshot_id',v_response->'pre_restore_snapshot_id');
END
$function$;

CREATE OR REPLACE FUNCTION app.read_teacher_project_snapshots(
  p_student uuid, p_project uuid, p_after_version integer, p_after_id uuid,
  p_limit integer, p_snapshot uuid, p_path text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_school uuid;
  v_result jsonb;
BEGIN
  IF p_student IS NULL OR p_project IS NULL
    OR (p_snapshot IS NULL AND (p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
      OR ((p_after_version IS NULL) <> (p_after_id IS NULL))))
    OR (p_snapshot IS NOT NULL AND (p_after_version IS NOT NULL OR p_after_id IS NOT NULL
      OR p_limit IS NOT NULL))
    OR (p_path IS NOT NULL AND NOT app.canonical_project_file_path(p_path)) THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;
  v_school := app.lock_teacher_student_resource(p_student);
  IF v_school IS NULL THEN RETURN '{"outcome":"not_found"}'; END IF;
  PERFORM id FROM app.projects WHERE id = p_project AND owner_id = p_student FOR SHARE;
  IF NOT FOUND THEN RETURN '{"outcome":"not_found"}'; END IF;

  IF p_snapshot IS NULL THEN
    WITH page AS MATERIALIZED (
      SELECT s.* FROM app.snapshots s WHERE s.project_id = p_project AND s.kind = 'manual'
        AND (p_after_version IS NULL OR (s.version_no,s.id) < (p_after_version,p_after_id))
      ORDER BY s.version_no DESC,s.id DESC LIMIT p_limit+1
    ), visible AS MATERIALIZED (
      SELECT * FROM page ORDER BY version_no DESC,id DESC LIMIT p_limit
    )
    SELECT jsonb_build_object('outcome','found',
      'items',coalesce(jsonb_agg(jsonb_build_object(
        'id',s.id,'version_no',s.version_no,
        'created_at',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'kind','manual','immutable',s.immutable,'content_hash',s.content_hash,'message',s.message,
        'changes',jsonb_build_object(
          'added',coalesce((SELECT jsonb_agg(current.path ORDER BY current.path COLLATE "C")
            FROM app.snapshot_files current WHERE current.snapshot_id = s.id
              AND NOT EXISTS (SELECT 1 FROM app.snapshot_files prior
                JOIN app.snapshots previous ON previous.id = prior.snapshot_id
                WHERE previous.project_id = p_project AND previous.kind = 'manual'
                  AND (previous.version_no,previous.id) = (
                    SELECT prior_snapshot.version_no,prior_snapshot.id FROM app.snapshots prior_snapshot
                    WHERE prior_snapshot.project_id = p_project AND prior_snapshot.kind = 'manual'
                      AND (prior_snapshot.version_no,prior_snapshot.id) < (s.version_no,s.id)
                    ORDER BY prior_snapshot.version_no DESC,prior_snapshot.id DESC LIMIT 1
                  ) AND prior.path = current.path)), '[]'::jsonb),
          'changed',coalesce((SELECT jsonb_agg(current.path ORDER BY current.path COLLATE "C")
            FROM app.snapshot_files current JOIN app.snapshot_files prior ON prior.path = current.path
            WHERE current.snapshot_id = s.id AND prior.snapshot_id = (
              SELECT prior_snapshot.id FROM app.snapshots prior_snapshot
              WHERE prior_snapshot.project_id = p_project AND prior_snapshot.kind = 'manual'
                AND (prior_snapshot.version_no,prior_snapshot.id) < (s.version_no,s.id)
              ORDER BY prior_snapshot.version_no DESC,prior_snapshot.id DESC LIMIT 1
            ) AND (prior.blob_hash <> current.blob_hash OR prior.bytes <> current.bytes)), '[]'::jsonb),
          'removed',coalesce((SELECT jsonb_agg(prior.path ORDER BY prior.path COLLATE "C")
            FROM app.snapshot_files prior WHERE prior.snapshot_id = (
              SELECT prior_snapshot.id FROM app.snapshots prior_snapshot
              WHERE prior_snapshot.project_id = p_project AND prior_snapshot.kind = 'manual'
                AND (prior_snapshot.version_no,prior_snapshot.id) < (s.version_no,s.id)
              ORDER BY prior_snapshot.version_no DESC,prior_snapshot.id DESC LIMIT 1
            ) AND NOT EXISTS (SELECT 1 FROM app.snapshot_files current
              WHERE current.snapshot_id = s.id AND current.path = prior.path)), '[]'::jsonb)
        )
      ) ORDER BY s.version_no DESC,s.id DESC),'[]'::jsonb),
      'next',CASE WHEN (SELECT count(*) FROM page) > p_limit
        THEN (SELECT jsonb_build_object('version_no',version_no,'id',id)
          FROM visible ORDER BY version_no,id LIMIT 1) END)
      INTO v_result FROM visible s;
  ELSIF p_path IS NULL THEN
    SELECT jsonb_build_object('outcome','found','snapshot',jsonb_build_object(
      'id',s.id,'version_no',s.version_no,
      'created_at',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'kind','manual','immutable',s.immutable,'content_hash',s.content_hash,'message',s.message
    ),'files',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'path',f.path,'hash',f.blob_hash,'bytes',f.bytes) ORDER BY f.path COLLATE "C")
      FROM app.snapshot_files f WHERE f.snapshot_id = s.id),'[]'::jsonb))
      INTO v_result FROM app.snapshots s
      WHERE s.id = p_snapshot AND s.project_id = p_project AND s.kind = 'manual';
    IF v_result IS NULL THEN RETURN '{"outcome":"not_found"}'; END IF;
  ELSE
    SELECT jsonb_build_object('outcome','found','file',jsonb_build_object(
      'path',f.path,'hash',b.hash,'bytes',f.bytes,'content',convert_from(b.content,'UTF8')
    )) INTO v_result
    FROM app.snapshot_files f JOIN app.blobs b ON b.hash = f.blob_hash
    JOIN app.snapshots s ON s.id = f.snapshot_id AND s.project_id = f.project_id
    WHERE f.snapshot_id = p_snapshot AND f.project_id = p_project AND f.path = p_path
      AND s.kind = 'manual';
    IF v_result IS NULL THEN RETURN '{"outcome":"not_found"}'; END IF;
  END IF;
  IF NOT app.teacher_resource_eligible(p_student) THEN RETURN '{"outcome":"not_found"}'; END IF;
  PERFORM app.teacher_resource_audit(p_student,v_school,p_project);
  RETURN v_result;
END
$function$;

ALTER FUNCTION app.restore_project_snapshot(uuid,uuid,uuid,boolean) OWNER TO app_project_file_writer;
REVOKE ALL ON FUNCTION app.restore_project_snapshot(uuid,uuid,uuid,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.restore_project_snapshot(uuid,uuid,uuid,boolean) TO authenticated;

COMMIT;
