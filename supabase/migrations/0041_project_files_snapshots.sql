BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE app.blobs (
  hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  bytes integer NOT NULL CHECK (bytes BETWEEN 0 AND 262144),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (bytes = octet_length(content)),
  CHECK (hash = encode(extensions.digest(content, 'sha256'), 'hex'))
);

CREATE TABLE app.project_files (
  project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE RESTRICT,
  path text NOT NULL,
  blob_hash text NOT NULL REFERENCES app.blobs(hash) ON DELETE RESTRICT,
  bytes integer NOT NULL CHECK (bytes BETWEEN 0 AND 262144),
  row_version integer NOT NULL CHECK (row_version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, path)
);

CREATE TABLE app.project_file_receipts (
  owner_id uuid NOT NULL REFERENCES app.profiles(id),
  project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE RESTRICT,
  operation_scope text NOT NULL CHECK (operation_scope = 'project_file_put_v1'),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, project_id, operation_scope, idempotency_key),
  CHECK (expires_at = created_at + interval '24 hours')
);

CREATE TABLE app.snapshots (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE RESTRICT,
  version_no integer NOT NULL CHECK (version_no > 0),
  kind text NOT NULL CHECK (kind = 'manual'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'array'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  immutable boolean NOT NULL DEFAULT false,
  message text NULL,
  created_by uuid NOT NULL REFERENCES app.profiles(id),
  created_at timestamptz NOT NULL,
  UNIQUE (project_id, version_no),
  UNIQUE (id, project_id)
);

CREATE TABLE app.snapshot_files (
  snapshot_id uuid NOT NULL,
  project_id uuid NOT NULL,
  path text NOT NULL,
  blob_hash text NOT NULL REFERENCES app.blobs(hash) ON DELETE RESTRICT,
  bytes integer NOT NULL CHECK (bytes BETWEEN 0 AND 262144),
  PRIMARY KEY (snapshot_id, path),
  FOREIGN KEY (snapshot_id, project_id) REFERENCES app.snapshots(id, project_id) ON DELETE RESTRICT
);

CREATE TABLE app.snapshot_receipts (
  owner_id uuid NOT NULL REFERENCES app.profiles(id),
  project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE RESTRICT,
  operation_scope text NOT NULL CHECK (operation_scope = 'project_manual_snapshot_v1'),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, project_id, operation_scope, idempotency_key),
  CHECK (expires_at = created_at + interval '24 hours')
);

CREATE TABLE app.project_file_audit (
  id uuid PRIMARY KEY,
  actor_aid uuid NOT NULL REFERENCES app.audit_identity_map(aid),
  project_id uuid NOT NULL REFERENCES app.projects(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('file_created', 'file_updated', 'manual_snapshot_created')),
  object_ref text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  at timestamptz NOT NULL
);

CREATE INDEX snapshots_project_version ON app.snapshots(project_id, version_no DESC, id DESC);
CREATE INDEX snapshot_files_blob ON app.snapshot_files(blob_hash);

ALTER TABLE app.blobs OWNER TO postgres;
ALTER TABLE app.project_files OWNER TO postgres;
ALTER TABLE app.project_file_receipts OWNER TO postgres;
ALTER TABLE app.snapshots OWNER TO postgres;
ALTER TABLE app.snapshot_files OWNER TO postgres;
ALTER TABLE app.snapshot_receipts OWNER TO postgres;
ALTER TABLE app.project_file_audit OWNER TO postgres;

ALTER TABLE app.blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.blobs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_files FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_file_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_file_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE app.snapshot_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.snapshot_files FORCE ROW LEVEL SECURITY;
ALTER TABLE app.snapshot_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.snapshot_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.project_file_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_file_audit FORCE ROW LEVEL SECURITY;

REVOKE ALL ON app.blobs, app.project_files, app.project_file_receipts, app.snapshots,
  app.snapshot_files, app.snapshot_receipts, app.project_file_audit
  FROM PUBLIC, anon, authenticated, service_role;

CREATE ROLE app_project_file_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CREATE ON SCHEMA app TO app_project_file_writer;
GRANT app_project_file_writer TO supabase_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA app, auth, extensions TO app_project_file_writer;
GRANT EXECUTE ON FUNCTION auth.uid(), app.current_account_gate(text) TO app_project_file_writer;
GRANT SELECT (id, role, status, deletion_state, school_id), UPDATE (id)
  ON app.profiles TO app_project_file_writer;
GRANT SELECT (id, approval_state), UPDATE (id) ON app.schools TO app_project_file_writer;
GRANT SELECT (id, owner_id), UPDATE (id) ON app.projects TO app_project_file_writer;
GRANT SELECT, INSERT ON app.blobs TO app_project_file_writer;
GRANT SELECT, INSERT, UPDATE ON app.project_files TO app_project_file_writer;
GRANT SELECT, INSERT, DELETE ON app.project_file_receipts, app.snapshot_receipts TO app_project_file_writer;
GRANT UPDATE (response) ON app.project_file_receipts, app.snapshot_receipts TO app_project_file_writer;
GRANT SELECT, INSERT ON app.snapshots, app.snapshot_files TO app_project_file_writer;
GRANT SELECT, INSERT ON app.audit_identity_map TO app_project_file_writer;
GRANT INSERT ON app.project_file_audit TO app_project_file_writer;

CREATE POLICY project_file_writer_blob_access ON app.blobs
  FOR ALL TO app_project_file_writer USING (true) WITH CHECK (true);
CREATE POLICY project_file_writer_profiles_read ON app.profiles
  FOR SELECT TO app_project_file_writer USING (id = auth.uid());
CREATE POLICY project_file_writer_profiles_lock ON app.profiles
  FOR UPDATE TO app_project_file_writer USING (id = auth.uid()) WITH CHECK (false);
CREATE POLICY project_file_writer_schools_read ON app.schools
  FOR SELECT TO app_project_file_writer USING (EXISTS (
    SELECT 1 FROM app.profiles p WHERE p.id = auth.uid() AND p.school_id = schools.id));
CREATE POLICY project_file_writer_schools_lock ON app.schools
  FOR UPDATE TO app_project_file_writer USING (EXISTS (
    SELECT 1 FROM app.profiles p WHERE p.id = auth.uid() AND p.school_id = schools.id))
  WITH CHECK (false);
CREATE POLICY project_file_writer_projects_read ON app.projects
  FOR SELECT TO app_project_file_writer
  USING (owner_id = auth.uid() AND app.current_account_gate('read_saved_content'));
CREATE POLICY project_file_writer_projects_lock ON app.projects
  FOR UPDATE TO app_project_file_writer
  USING (owner_id = auth.uid() AND app.current_account_gate('read_saved_content'))
  WITH CHECK (false);
CREATE POLICY project_file_writer_files_access ON app.project_files
  FOR ALL TO app_project_file_writer
  USING (app.current_account_gate('read_saved_content') AND EXISTS (
    SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid()))
  WITH CHECK (app.current_account_gate('edit_saved_content') AND EXISTS (
    SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid()));
CREATE POLICY project_file_writer_file_receipts_access ON app.project_file_receipts
  FOR ALL TO app_project_file_writer
  USING (owner_id = auth.uid() AND app.current_account_gate('edit_saved_content'))
  WITH CHECK (owner_id = auth.uid() AND app.current_account_gate('edit_saved_content'));
CREATE POLICY project_file_writer_snapshots_access ON app.snapshots
  FOR SELECT TO app_project_file_writer
  USING (app.current_account_gate('read_saved_content') AND EXISTS (
    SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid()));
CREATE POLICY project_file_writer_snapshots_insert ON app.snapshots
  FOR INSERT TO app_project_file_writer
  WITH CHECK (created_by = auth.uid() AND kind = 'manual' AND immutable = false
    AND app.current_account_gate('edit_saved_content') AND EXISTS (
      SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid()));
CREATE POLICY project_file_writer_snapshot_files_access ON app.snapshot_files
  FOR ALL TO app_project_file_writer
  USING (app.current_account_gate('read_saved_content') AND EXISTS (
    SELECT 1 FROM app.snapshots s JOIN app.projects p ON p.id = s.project_id
    WHERE s.id = snapshot_id AND p.owner_id = auth.uid()))
  WITH CHECK (app.current_account_gate('edit_saved_content') AND EXISTS (
    SELECT 1 FROM app.snapshots s JOIN app.projects p ON p.id = s.project_id
    WHERE s.id = snapshot_id AND p.owner_id = auth.uid()));
CREATE POLICY project_file_writer_snapshot_receipts_access ON app.snapshot_receipts
  FOR ALL TO app_project_file_writer
  USING (owner_id = auth.uid() AND app.current_account_gate('edit_saved_content'))
  WITH CHECK (owner_id = auth.uid() AND app.current_account_gate('edit_saved_content'));
CREATE POLICY project_file_writer_identity_access ON app.audit_identity_map
  FOR ALL TO app_project_file_writer
  USING (account_id = auth.uid())
  WITH CHECK (account_id = auth.uid());
CREATE POLICY project_file_writer_audit_insert ON app.project_file_audit
  FOR INSERT TO app_project_file_writer WITH CHECK (true);

CREATE FUNCTION app.canonical_project_file_path(p_path text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog
AS $function$
  SELECT p_path ~ '^[A-Za-z0-9._/-]+$'
    AND octet_length(p_path) <= 512
    AND left(p_path, 1) <> '/'
    AND position('//' in p_path) = 0
    AND position(E'\\' in p_path) = 0
    AND position('%' in p_path) = 0
    AND p_path !~ '(^|/)\.\.?(/|$)'
    AND p_path !~ '(^|/)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|/|$)'
    AND p_path !~ '(^|/)[^/]*[. ](/|$)'
    AND (p_path LIKE '%.html' OR p_path LIKE '%.css' OR p_path LIKE '%.js')
$function$;
ALTER TABLE app.project_files ADD CONSTRAINT project_files_canonical_path
  CHECK (app.canonical_project_file_path(path));
ALTER TABLE app.snapshot_files ADD CONSTRAINT snapshot_files_canonical_path
  CHECK (app.canonical_project_file_path(path));

CREATE FUNCTION app.read_project_files(p_project uuid, p_path text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_owner uuid := auth.uid();
  v_role text;
  v_school uuid;
  v_result jsonb;
BEGIN
  IF p_project IS NULL OR (p_path IS NOT NULL AND NOT app.canonical_project_file_path(p_path)) THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;
  IF v_owner IS NULL THEN RETURN '{"outcome":"denied"}'; END IF;
  SELECT role::text, school_id INTO v_role, v_school
    FROM app.profiles WHERE id = v_owner FOR SHARE;
  IF NOT FOUND OR v_role <> 'student' THEN RETURN '{"outcome":"denied"}'; END IF;
  PERFORM id FROM app.schools WHERE id = v_school FOR SHARE;
  IF NOT FOUND OR NOT app.current_account_gate('read_saved_content') THEN
    RETURN '{"outcome":"denied"}';
  END IF;
  PERFORM id FROM app.projects WHERE id = p_project AND owner_id = v_owner FOR SHARE;
  IF NOT FOUND THEN RETURN '{"outcome":"not_found"}'; END IF;

  IF p_path IS NULL THEN
    SELECT jsonb_build_object('outcome','found','items',coalesce(jsonb_agg(jsonb_build_object(
      'path', f.path, 'hash', f.blob_hash, 'bytes', f.bytes,
      'updated_at', to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ) ORDER BY f.path COLLATE "C"), '[]'::jsonb))
      INTO v_result
      FROM app.project_files f WHERE f.project_id = p_project;
  ELSE
    SELECT jsonb_build_object('outcome','found','file',jsonb_build_object(
      'path', f.path, 'hash', b.hash, 'bytes', f.bytes,
      'updated_at', to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'content', convert_from(b.content,'UTF8')
    )) INTO v_result
    FROM app.project_files f JOIN app.blobs b ON b.hash = f.blob_hash
    WHERE f.project_id = p_project AND f.path = p_path;
    IF v_result IS NULL THEN RETURN '{"outcome":"not_found"}'; END IF;
  END IF;
  RETURN v_result;
END
$function$;

CREATE FUNCTION app.write_project_file(
  p_project uuid, p_path text, p_content text, p_if_match text,
  p_if_none_match text, p_idempotency_key uuid, p_replay_only boolean
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_owner uuid := auth.uid();
  v_role text;
  v_school uuid;
  v_existing app.project_files%ROWTYPE;
  v_hash text;
  v_bytes integer;
  v_now timestamptz;
  v_request_hash text;
  v_receipt app.project_file_receipts%ROWTYPE;
  v_response jsonb;
  v_aid uuid;
BEGIN
  IF p_project IS NULL OR NOT app.canonical_project_file_path(p_path) OR p_content IS NULL
    OR p_idempotency_key IS NULL OR (p_if_match IS NULL) = (p_if_none_match IS NULL)
    OR (p_if_none_match IS NOT NULL AND p_if_none_match <> '*')
    OR (p_if_match IS NOT NULL AND p_if_match !~ '^[0-9a-f]{64}$') THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;
  v_bytes := octet_length(convert_to(p_content, 'UTF8'));
  IF v_bytes > 262144 THEN RETURN '{"outcome":"too_large"}'; END IF;
  v_hash := encode(extensions.digest(convert_to(p_content,'UTF8'),'sha256'),'hex');
  v_request_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    'project_file_put_v1', p_project, p_path, p_content, p_if_match, p_if_none_match
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

  IF NOT p_replay_only THEN
    DELETE FROM app.project_file_receipts
      WHERE owner_id = v_owner AND project_id = p_project
        AND operation_scope = 'project_file_put_v1' AND idempotency_key = p_idempotency_key
        AND expires_at <= clock_timestamp();
  END IF;
  SELECT * INTO v_receipt FROM app.project_file_receipts
    WHERE owner_id = v_owner AND project_id = p_project
      AND operation_scope = 'project_file_put_v1' AND idempotency_key = p_idempotency_key
    FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.expires_at <= clock_timestamp() OR v_receipt.response IS NULL THEN
      RETURN '{"outcome":"unrecoverable"}';
    END IF;
    IF v_receipt.request_hash <> v_request_hash THEN RETURN '{"outcome":"idempotency_key_reuse"}'; END IF;
    RETURN jsonb_set(v_receipt.response,'{outcome}','"replayed"'::jsonb);
  END IF;
  IF p_replay_only THEN RETURN '{"outcome":"unrecoverable"}'; END IF;

  SELECT * INTO v_existing FROM app.project_files
    WHERE project_id = p_project AND path = p_path FOR UPDATE;
  IF p_if_none_match = '*' AND FOUND THEN RETURN '{"outcome":"already_exists"}'; END IF;
  IF p_if_match IS NOT NULL AND NOT FOUND THEN RETURN '{"outcome":"not_found"}'; END IF;
  IF p_if_match IS NOT NULL AND v_existing.blob_hash <> p_if_match THEN
    RETURN jsonb_build_object('outcome','conflict','current_hash',v_existing.blob_hash);
  END IF;

  v_now := clock_timestamp();
  INSERT INTO app.project_file_receipts(
    owner_id, project_id, operation_scope, idempotency_key, request_hash, response, created_at, expires_at
  ) VALUES (
    v_owner, p_project, 'project_file_put_v1', p_idempotency_key, v_request_hash, NULL,
    v_now, v_now + interval '24 hours'
  );
  INSERT INTO app.blobs(hash, bytes, content, created_at)
    VALUES (v_hash, v_bytes, convert_to(p_content,'UTF8'), v_now)
    ON CONFLICT (hash) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM app.blobs WHERE hash = v_hash AND bytes = v_bytes
    AND content = convert_to(p_content,'UTF8')) THEN
    RAISE EXCEPTION 'blob_integrity_failure';
  END IF;
  IF p_if_none_match = '*' THEN
    INSERT INTO app.project_files(project_id,path,blob_hash,bytes,row_version,created_at,updated_at)
      VALUES(p_project,p_path,v_hash,v_bytes,0,v_now,v_now);
  ELSE
    UPDATE app.project_files SET blob_hash=v_hash,bytes=v_bytes,row_version=row_version+1,updated_at=v_now
      WHERE project_id=p_project AND path=p_path;
  END IF;
  INSERT INTO app.audit_identity_map(aid,account_id,created_at)
    VALUES(gen_random_uuid(),v_owner,v_now) ON CONFLICT(account_id) DO NOTHING;
  SELECT aid INTO v_aid FROM app.audit_identity_map WHERE account_id=v_owner;
  INSERT INTO app.project_file_audit(id,actor_aid,project_id,action,object_ref,content_hash,at)
    VALUES(gen_random_uuid(),v_aid,p_project,
      CASE WHEN p_if_none_match = '*' THEN 'file_created' ELSE 'file_updated' END,
      p_path,v_hash,v_now);
  SELECT jsonb_build_object('outcome','saved','created',p_if_none_match IS NOT NULL,
    'file',jsonb_build_object(
    'path',path,'hash',blob_hash,'bytes',bytes,
    'updated_at',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )) INTO v_response FROM app.project_files WHERE project_id=p_project AND path=p_path;
  UPDATE app.project_file_receipts SET response=v_response
    WHERE owner_id=v_owner AND project_id=p_project AND operation_scope='project_file_put_v1'
      AND idempotency_key=p_idempotency_key;
  RETURN v_response;
END
$function$;

CREATE FUNCTION app.create_manual_project_snapshot(
  p_project uuid, p_message text, p_idempotency_key uuid, p_replay_only boolean
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_owner uuid := auth.uid();
  v_role text;
  v_school uuid;
  v_receipt app.snapshot_receipts%ROWTYPE;
  v_request_hash text;
  v_snapshot uuid;
  v_version integer;
  v_manifest jsonb;
  v_content_hash text;
  v_budget bigint;
  v_now timestamptz;
  v_aid uuid;
  v_response jsonb;
BEGIN
  IF p_project IS NULL OR p_idempotency_key IS NULL OR
    (p_message IS NOT NULL AND octet_length(convert_to(p_message,'UTF8')) > 4096) THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;
  v_request_hash := encode(extensions.digest(convert_to(jsonb_build_array(
    'project_manual_snapshot_v1',p_project,'manual',p_message
  )::text,'UTF8'),'sha256'),'hex');
  IF v_owner IS NULL THEN RETURN '{"outcome":"denied"}'; END IF;
  SELECT role::text,school_id INTO v_role,v_school FROM app.profiles WHERE id=v_owner FOR SHARE;
  IF NOT FOUND OR v_role <> 'student' THEN RETURN '{"outcome":"denied"}'; END IF;
  PERFORM id FROM app.schools WHERE id=v_school FOR SHARE;
  IF NOT FOUND OR NOT app.current_account_gate('edit_saved_content')
    OR NOT app.current_account_gate('read_saved_content') THEN RETURN '{"outcome":"denied"}'; END IF;
  PERFORM id FROM app.projects WHERE id=p_project AND owner_id=v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN '{"outcome":"not_found"}'; END IF;

  IF NOT p_replay_only THEN
    DELETE FROM app.snapshot_receipts
      WHERE owner_id=v_owner AND project_id=p_project
        AND operation_scope='project_manual_snapshot_v1' AND idempotency_key=p_idempotency_key
        AND expires_at <= clock_timestamp();
  END IF;
  SELECT * INTO v_receipt FROM app.snapshot_receipts
    WHERE owner_id=v_owner AND project_id=p_project
      AND operation_scope='project_manual_snapshot_v1' AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.expires_at <= clock_timestamp() OR v_receipt.response IS NULL THEN
      RETURN '{"outcome":"unrecoverable"}';
    END IF;
    IF v_receipt.request_hash <> v_request_hash THEN RETURN '{"outcome":"idempotency_key_reuse"}'; END IF;
    RETURN jsonb_build_object('outcome','replayed','snapshot',v_receipt.response->'snapshot');
  END IF;
  IF p_replay_only THEN RETURN '{"outcome":"unrecoverable"}'; END IF;

  SELECT coalesce(sum(f.bytes::bigint + octet_length(f.path)::bigint + 64
      + length(f.bytes::text)::bigint + 3),0)
    INTO v_budget FROM app.project_files f WHERE f.project_id=p_project;
  IF v_budget > 16777216 THEN RETURN '{"outcome":"storage_limit"}'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'path',f.path,'hash',f.blob_hash,'bytes',f.bytes) ORDER BY f.path COLLATE "C"),'[]'::jsonb)
    INTO v_manifest
    FROM app.project_files f WHERE f.project_id=p_project;
  -- The aggregate's canonical byte stream is hashed by PostgreSQL, never by the caller.
  v_content_hash := encode(extensions.digest(
    coalesce((SELECT string_agg(
      convert_to(f.path,'UTF8') || decode('00','hex') || convert_to(f.blob_hash,'UTF8')
        || decode('00','hex') || convert_to(f.bytes::text || E'\n','UTF8'),
      ''::bytea ORDER BY f.path COLLATE "C")
      FROM app.project_files f WHERE f.project_id=p_project), ''::bytea), 'sha256'), 'hex');
  v_snapshot := gen_random_uuid();
  SELECT coalesce(max(version_no),0)+1 INTO v_version FROM app.snapshots WHERE project_id=p_project;
  v_now := clock_timestamp();
  SELECT jsonb_build_object(
    'added',coalesce((SELECT jsonb_agg(current.path ORDER BY current.path COLLATE "C")
      FROM app.project_files current WHERE current.project_id=p_project
        AND NOT EXISTS (SELECT 1 FROM app.snapshot_files prior
          JOIN app.snapshots previous ON previous.id=prior.snapshot_id
          WHERE previous.project_id=p_project AND previous.version_no=v_version-1
            AND prior.path=current.path)), '[]'::jsonb),
    'changed',coalesce((SELECT jsonb_agg(current.path ORDER BY current.path COLLATE "C")
      FROM app.project_files current
      JOIN app.snapshot_files prior ON prior.path=current.path
      JOIN app.snapshots previous ON previous.id=prior.snapshot_id
        AND previous.project_id=p_project AND previous.version_no=v_version-1
      WHERE current.project_id=p_project
        AND (prior.blob_hash<>current.blob_hash OR prior.bytes<>current.bytes)), '[]'::jsonb),
    'removed',coalesce((SELECT jsonb_agg(prior.path ORDER BY prior.path COLLATE "C")
      FROM app.snapshot_files prior
      JOIN app.snapshots previous ON previous.id=prior.snapshot_id
        AND previous.project_id=p_project AND previous.version_no=v_version-1
      WHERE NOT EXISTS (SELECT 1 FROM app.project_files current
        WHERE current.project_id=p_project AND current.path=prior.path)), '[]'::jsonb)
  ) INTO v_response;
  INSERT INTO app.snapshots(id,project_id,version_no,kind,manifest,content_hash,immutable,message,created_by,created_at)
    VALUES(v_snapshot,p_project,v_version,'manual',v_manifest,v_content_hash,false,p_message,v_owner,v_now);
  INSERT INTO app.snapshot_files(snapshot_id,project_id,path,blob_hash,bytes)
    SELECT v_snapshot,p_project,path,blob_hash,bytes FROM app.project_files WHERE project_id=p_project;
  INSERT INTO app.snapshot_receipts(
    owner_id,project_id,operation_scope,idempotency_key,request_hash,response,created_at,expires_at
  ) VALUES(v_owner,p_project,'project_manual_snapshot_v1',p_idempotency_key,v_request_hash,NULL,
    v_now,v_now + interval '24 hours');
  INSERT INTO app.audit_identity_map(aid,account_id,created_at)
    VALUES(gen_random_uuid(),v_owner,v_now) ON CONFLICT(account_id) DO NOTHING;
  SELECT aid INTO v_aid FROM app.audit_identity_map WHERE account_id=v_owner;
  INSERT INTO app.project_file_audit(id,actor_aid,project_id,action,object_ref,content_hash,at)
    VALUES(gen_random_uuid(),v_aid,p_project,'manual_snapshot_created',v_snapshot::text,v_content_hash,v_now);

  v_response := jsonb_build_object('outcome','created','snapshot',jsonb_build_object(
    'id',v_snapshot,'version_no',v_version,
    'created_at',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'kind','manual','immutable',false,'content_hash',v_content_hash,'message',p_message,
    'changes',v_response
  ));
  UPDATE app.snapshot_receipts SET response=v_response
    WHERE owner_id=v_owner AND project_id=p_project AND operation_scope='project_manual_snapshot_v1'
      AND idempotency_key=p_idempotency_key;
  RETURN v_response;
END
$function$;

CREATE FUNCTION app.read_project_snapshots(
  p_project uuid, p_after_version integer, p_after_id uuid, p_limit integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_owner uuid := auth.uid();
  v_role text;
  v_school uuid;
  v_items jsonb;
  v_next jsonb;
BEGIN
  IF p_project IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
    OR ((p_after_version IS NULL) <> (p_after_id IS NULL)) THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;
  IF v_owner IS NULL THEN RETURN '{"outcome":"denied"}'; END IF;
  SELECT role::text,school_id INTO v_role,v_school FROM app.profiles WHERE id=v_owner FOR SHARE;
  IF NOT FOUND OR v_role <> 'student' THEN RETURN '{"outcome":"denied"}'; END IF;
  PERFORM id FROM app.schools WHERE id=v_school FOR SHARE;
  IF NOT FOUND OR NOT app.current_account_gate('read_saved_content') THEN RETURN '{"outcome":"denied"}'; END IF;
  PERFORM id FROM app.projects WHERE id=p_project AND owner_id=v_owner FOR SHARE;
  IF NOT FOUND THEN RETURN '{"outcome":"not_found"}'; END IF;
  WITH page AS MATERIALIZED (
    SELECT s.* FROM app.snapshots s WHERE s.project_id=p_project
      AND (p_after_version IS NULL OR (s.version_no,s.id)<(p_after_version,p_after_id))
    ORDER BY s.version_no DESC,s.id DESC LIMIT p_limit+1
  ), visible AS MATERIALIZED (
    SELECT * FROM page ORDER BY version_no DESC,id DESC LIMIT p_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',s.id,'version_no',s.version_no,
      'created_at',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'kind',s.kind,'immutable',s.immutable,'content_hash',s.content_hash,'message',s.message,
      'changes',jsonb_build_object(
        'added',coalesce((SELECT jsonb_agg(current.path ORDER BY current.path COLLATE "C")
          FROM app.snapshot_files current
          WHERE current.snapshot_id=s.id AND NOT EXISTS (
            SELECT 1 FROM app.snapshot_files prior
            WHERE prior.snapshot_id=(SELECT id FROM app.snapshots WHERE project_id=p_project AND version_no=s.version_no-1)
              AND prior.path=current.path)), '[]'::jsonb),
        'changed',coalesce((SELECT jsonb_agg(current.path ORDER BY current.path COLLATE "C")
          FROM app.snapshot_files current JOIN app.snapshots prior_snapshot
            ON prior_snapshot.project_id=p_project AND prior_snapshot.version_no=s.version_no-1
          JOIN app.snapshot_files prior ON prior.snapshot_id=prior_snapshot.id AND prior.path=current.path
          WHERE current.snapshot_id=s.id AND (prior.blob_hash<>current.blob_hash OR prior.bytes<>current.bytes)), '[]'::jsonb),
        'removed',coalesce((SELECT jsonb_agg(prior.path ORDER BY prior.path COLLATE "C")
          FROM app.snapshot_files prior JOIN app.snapshots prior_snapshot
            ON prior_snapshot.project_id=p_project AND prior_snapshot.version_no=s.version_no-1
          WHERE prior.snapshot_id=prior_snapshot.id AND NOT EXISTS (
            SELECT 1 FROM app.snapshot_files current WHERE current.snapshot_id=s.id AND current.path=prior.path)), '[]'::jsonb)
      )
    ) ORDER BY s.version_no DESC,s.id DESC), '[]'::jsonb),
    CASE WHEN (SELECT count(*) FROM page)>p_limit
      THEN (SELECT jsonb_build_object('version_no',version_no,'id',id)
        FROM visible ORDER BY version_no,id LIMIT 1) END
    FROM visible s
    INTO v_items,v_next;
  RETURN jsonb_build_object('outcome','found','items',v_items,'next',v_next);
END
$function$;

CREATE FUNCTION app.read_project_snapshot(
  p_project uuid, p_snapshot uuid, p_path text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_owner uuid := auth.uid();
  v_role text;
  v_school uuid;
  v_result jsonb;
BEGIN
  IF p_project IS NULL OR p_snapshot IS NULL
    OR (p_path IS NOT NULL AND NOT app.canonical_project_file_path(p_path)) THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;
  IF v_owner IS NULL THEN RETURN '{"outcome":"denied"}'; END IF;
  SELECT role::text,school_id INTO v_role,v_school FROM app.profiles WHERE id=v_owner FOR SHARE;
  IF NOT FOUND OR v_role <> 'student' THEN RETURN '{"outcome":"denied"}'; END IF;
  PERFORM id FROM app.schools WHERE id=v_school FOR SHARE;
  IF NOT FOUND OR NOT app.current_account_gate('read_saved_content') THEN RETURN '{"outcome":"denied"}'; END IF;
  PERFORM id FROM app.projects WHERE id=p_project AND owner_id=v_owner FOR SHARE;
  IF NOT FOUND THEN RETURN '{"outcome":"not_found"}'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.snapshots WHERE id=p_snapshot AND project_id=p_project) THEN
    RETURN '{"outcome":"not_found"}';
  END IF;
  IF p_path IS NULL THEN
    SELECT jsonb_build_object('outcome','found','snapshot',jsonb_build_object(
      'id',s.id,'version_no',s.version_no,
      'created_at',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'kind',s.kind,'immutable',s.immutable,'content_hash',s.content_hash,'message',s.message
    ),'files',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'path',f.path,'hash',f.blob_hash,'bytes',f.bytes) ORDER BY f.path COLLATE "C")
      FROM app.snapshot_files f WHERE f.snapshot_id=s.id),'[]'::jsonb))
      INTO v_result FROM app.snapshots s WHERE s.id=p_snapshot AND s.project_id=p_project;
  ELSE
    SELECT jsonb_build_object('outcome','found','file',jsonb_build_object(
      'path',f.path,'hash',b.hash,'bytes',f.bytes,'content',convert_from(b.content,'UTF8')
    )) INTO v_result
    FROM app.snapshot_files f JOIN app.blobs b ON b.hash=f.blob_hash
    WHERE f.snapshot_id=p_snapshot AND f.project_id=p_project AND f.path=p_path;
    IF v_result IS NULL THEN RETURN '{"outcome":"not_found"}'; END IF;
  END IF;
  RETURN v_result;
END
$function$;

GRANT SELECT (id, project_id, version_no, kind, manifest, content_hash, immutable, message, created_by, created_at)
  ON app.snapshots TO app_teacher_resource_reader;
GRANT SELECT (snapshot_id, project_id, path, blob_hash, bytes)
  ON app.snapshot_files TO app_teacher_resource_reader;
GRANT SELECT (hash, bytes, content) ON app.blobs TO app_teacher_resource_reader;
CREATE POLICY teacher_resource_snapshots_read ON app.snapshots
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_snapshot_files_read ON app.snapshot_files
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_blobs_read ON app.blobs
  FOR SELECT TO app_teacher_resource_reader USING (true);
GRANT CREATE ON SCHEMA app TO app_teacher_resource_reader;
GRANT app_teacher_resource_reader TO supabase_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT EXECUTE ON FUNCTION app.canonical_project_file_path(text) TO app_teacher_resource_reader;

CREATE FUNCTION app.read_teacher_project_snapshots(
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
  PERFORM id FROM app.projects WHERE id=p_project AND owner_id=p_student FOR SHARE;
  IF NOT FOUND THEN RETURN '{"outcome":"not_found"}'; END IF;

  IF p_snapshot IS NULL THEN
    WITH page AS MATERIALIZED (
      SELECT s.* FROM app.snapshots s WHERE s.project_id=p_project
        AND (p_after_version IS NULL OR (s.version_no,s.id)<(p_after_version,p_after_id))
      ORDER BY s.version_no DESC,s.id DESC LIMIT p_limit+1
    ), visible AS MATERIALIZED (
      SELECT * FROM page ORDER BY version_no DESC,id DESC LIMIT p_limit
    )
    SELECT jsonb_build_object('outcome','found',
      'items',coalesce(jsonb_agg(jsonb_build_object(
        'id',s.id,'version_no',s.version_no,
        'created_at',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'kind',s.kind,'immutable',s.immutable,'content_hash',s.content_hash,'message',s.message,
        'changes',jsonb_build_object(
          'added',coalesce((SELECT jsonb_agg(current.path ORDER BY current.path COLLATE "C")
            FROM app.snapshot_files current WHERE current.snapshot_id=s.id AND NOT EXISTS (
              SELECT 1 FROM app.snapshot_files prior JOIN app.snapshots previous ON previous.id=prior.snapshot_id
              WHERE previous.project_id=p_project AND previous.version_no=s.version_no-1 AND prior.path=current.path)),
            '[]'::jsonb),
          'changed',coalesce((SELECT jsonb_agg(current.path ORDER BY current.path COLLATE "C")
            FROM app.snapshot_files current JOIN app.snapshots previous
              ON previous.project_id=p_project AND previous.version_no=s.version_no-1
            JOIN app.snapshot_files prior ON prior.snapshot_id=previous.id AND prior.path=current.path
            WHERE current.snapshot_id=s.id AND (prior.blob_hash<>current.blob_hash OR prior.bytes<>current.bytes)),
            '[]'::jsonb),
          'removed',coalesce((SELECT jsonb_agg(prior.path ORDER BY prior.path COLLATE "C")
            FROM app.snapshots previous JOIN app.snapshot_files prior ON prior.snapshot_id=previous.id
            WHERE previous.project_id=p_project AND previous.version_no=s.version_no-1
              AND NOT EXISTS (SELECT 1 FROM app.snapshot_files current
                WHERE current.snapshot_id=s.id AND current.path=prior.path)), '[]'::jsonb)
        )
      ) ORDER BY s.version_no DESC,s.id DESC),'[]'::jsonb),
      'next',CASE WHEN (SELECT count(*) FROM page)>p_limit
        THEN (SELECT jsonb_build_object('version_no',version_no,'id',id)
          FROM visible ORDER BY version_no,id LIMIT 1) END)
      INTO v_result FROM visible s;
  ELSIF p_path IS NULL THEN
    SELECT jsonb_build_object('outcome','found','snapshot',jsonb_build_object(
      'id',s.id,'version_no',s.version_no,
      'created_at',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'kind',s.kind,'immutable',s.immutable,'content_hash',s.content_hash,'message',s.message
    ),'files',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'path',f.path,'hash',f.blob_hash,'bytes',f.bytes) ORDER BY f.path COLLATE "C")
      FROM app.snapshot_files f WHERE f.snapshot_id=s.id),'[]'::jsonb))
      INTO v_result FROM app.snapshots s WHERE s.id=p_snapshot AND s.project_id=p_project;
    IF v_result IS NULL THEN RETURN '{"outcome":"not_found"}'; END IF;
  ELSE
    SELECT jsonb_build_object('outcome','found','file',jsonb_build_object(
      'path',f.path,'hash',b.hash,'bytes',f.bytes,'content',convert_from(b.content,'UTF8')
    )) INTO v_result FROM app.snapshot_files f JOIN app.blobs b ON b.hash=f.blob_hash
    WHERE f.snapshot_id=p_snapshot AND f.project_id=p_project AND f.path=p_path;
    IF v_result IS NULL THEN RETURN '{"outcome":"not_found"}'; END IF;
  END IF;
  IF NOT app.teacher_resource_eligible(p_student) THEN RETURN '{"outcome":"not_found"}'; END IF;
  PERFORM app.teacher_resource_audit(p_student,v_school,p_project);
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION app.reject_immutable_project_content() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'immutable_project_content';
END
$function$;
ALTER FUNCTION app.reject_immutable_project_content() OWNER TO postgres;
CREATE TRIGGER blobs_immutable BEFORE UPDATE OR DELETE ON app.blobs
  FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_project_content();
CREATE TRIGGER snapshots_immutable BEFORE UPDATE OR DELETE ON app.snapshots
  FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_project_content();
CREATE TRIGGER snapshot_files_immutable BEFORE UPDATE OR DELETE ON app.snapshot_files
  FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_project_content();

ALTER FUNCTION app.read_project_files(uuid,text) OWNER TO app_project_file_writer;
ALTER FUNCTION app.write_project_file(uuid,text,text,text,text,uuid,boolean) OWNER TO app_project_file_writer;
ALTER FUNCTION app.create_manual_project_snapshot(uuid,text,uuid,boolean) OWNER TO app_project_file_writer;
ALTER FUNCTION app.read_project_snapshots(uuid,integer,uuid,integer) OWNER TO app_project_file_writer;
ALTER FUNCTION app.read_project_snapshot(uuid,uuid,text) OWNER TO app_project_file_writer;
ALTER FUNCTION app.read_teacher_project_snapshots(uuid,uuid,integer,uuid,integer,uuid,text)
  OWNER TO app_teacher_resource_reader;
REVOKE app_project_file_writer FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_project_file_writer;
REVOKE app_teacher_resource_reader FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_teacher_resource_reader;
REVOKE ALL ON FUNCTION app.canonical_project_file_path(text),
  app.read_project_files(uuid,text), app.write_project_file(uuid,text,text,text,text,uuid,boolean),
  app.create_manual_project_snapshot(uuid,text,uuid,boolean),
  app.read_project_snapshots(uuid,integer,uuid,integer), app.read_project_snapshot(uuid,uuid,text),
  app.read_teacher_project_snapshots(uuid,uuid,integer,uuid,integer,uuid,text),
  app.reject_immutable_project_content()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.canonical_project_file_path(text) TO app_project_file_writer;
GRANT EXECUTE ON FUNCTION app.read_project_files(uuid,text),
  app.write_project_file(uuid,text,text,text,text,uuid,boolean),
  app.create_manual_project_snapshot(uuid,text,uuid,boolean),
  app.read_project_snapshots(uuid,integer,uuid,integer), app.read_project_snapshot(uuid,uuid,text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION app.read_teacher_project_snapshots(uuid,uuid,integer,uuid,integer,uuid,text)
  TO authenticated;

COMMIT;
