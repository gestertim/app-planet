BEGIN;

CREATE ROLE app_agent_run_executor NOLOGIN NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA app, auth TO app_agent_run_executor;
REVOKE CREATE ON SCHEMA app FROM app_agent_run_executor;
GRANT EXECUTE ON FUNCTION auth.uid(), app.current_account_gate(text),
  app.job_cancel(uuid) TO app_agent_run_executor;

ALTER TABLE app.projects ADD CONSTRAINT projects_id_owner_unique UNIQUE (id, owner_id);
ALTER TABLE app.jobs ADD CONSTRAINT jobs_agent_identity_unique
  UNIQUE (id, subject_id, resource_id, kind);

CREATE TABLE app.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES app.profiles(id),
  mode text NOT NULL CHECK (mode IN ('guided', 'auto')),
  state text NOT NULL DEFAULT 'awaiting_approval'
    CHECK (state IN ('awaiting_approval','running','stopping','stopped','completed','failed')),
  base_snapshot_id uuid,
  approved_plan jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, owner_id, project_id),
  FOREIGN KEY (project_id, owner_id) REFERENCES app.projects(id, owner_id) ON DELETE RESTRICT,
  -- T068 尚無可驗證的快照關聯；不接受看似有效的 UUID 或批准 JSON。
  CONSTRAINT agent_execution_unavailable CHECK (
    base_snapshot_id IS NULL AND approved_plan IS NULL
    AND state NOT IN ('running','completed')
  )
);
CREATE UNIQUE INDEX agent_runs_one_active_project ON app.agent_runs(project_id)
  WHERE state IN ('awaiting_approval','running','stopping');

-- guided 有多次逐步確認；auto 可批准任務集。不將 Run 永久限制成單一 Job。
CREATE TABLE app.agent_run_jobs (
  run_id uuid NOT NULL,
  job_id uuid NOT NULL UNIQUE,
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'agent' CHECK (kind = 'agent'),
  PRIMARY KEY (run_id, job_id),
  FOREIGN KEY (run_id, owner_id, project_id)
    REFERENCES app.agent_runs(id, owner_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, owner_id, project_id, kind)
    REFERENCES app.jobs(id, subject_id, resource_id, kind) ON DELETE RESTRICT
);
CREATE TABLE app.agent_run_create_receipts (
  owner_id uuid NOT NULL REFERENCES app.profiles(id),
  operation_scope text NOT NULL DEFAULT 'agent_run_create_v1'
    CHECK (operation_scope = 'agent_run_create_v1'),
  idempotency_key uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES app.agent_runs(id) ON DELETE RESTRICT,
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, operation_scope, idempotency_key),
  CHECK (expires_at = created_at + interval '24 hours')
);

DO $block$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_runs','agent_run_jobs','agent_run_create_receipts'] LOOP
    EXECUTE format('ALTER TABLE app.%I OWNER TO postgres', t);
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, anon, authenticated, service_role', t);
    EXECUTE format('GRANT SELECT ON app.%I TO app_agent_run_executor', t);
    EXECUTE format(
      'CREATE POLICY agent_scope ON app.%I FOR ALL TO app_agent_run_executor
       USING (owner_id = auth.uid() AND app.current_account_gate(''edit_saved_content''))
       WITH CHECK (owner_id = auth.uid() AND app.current_account_gate(''edit_saved_content''))', t);
  END LOOP;
END
$block$;
GRANT INSERT ON app.agent_runs, app.agent_run_create_receipts TO app_agent_run_executor;
GRANT UPDATE (state) ON app.agent_runs TO app_agent_run_executor;
GRANT DELETE ON app.agent_run_create_receipts TO app_agent_run_executor;
GRANT UPDATE (idempotency_key) ON app.agent_run_create_receipts TO app_agent_run_executor;
GRANT SELECT (id, owner_id), UPDATE (id) ON app.projects TO app_agent_run_executor;
GRANT SELECT (id, role, school_id), UPDATE (id) ON app.profiles TO app_agent_run_executor;
GRANT SELECT (id), UPDATE (id) ON app.schools TO app_agent_run_executor;
GRANT SELECT (id, subject_id, resource_id, kind, state, cancel_requested),
  UPDATE (id) ON app.jobs TO app_agent_run_executor;

CREATE POLICY agent_projects ON app.projects FOR SELECT TO app_agent_run_executor
  USING (owner_id = auth.uid() AND app.current_account_gate('edit_saved_content'));
CREATE POLICY agent_projects_lock ON app.projects FOR UPDATE TO app_agent_run_executor
  USING (owner_id = auth.uid()) WITH CHECK (false);
CREATE POLICY agent_profiles ON app.profiles FOR SELECT TO app_agent_run_executor USING (true);
CREATE POLICY agent_profiles_lock ON app.profiles FOR UPDATE TO app_agent_run_executor
  USING (true) WITH CHECK (false);
CREATE POLICY agent_schools ON app.schools FOR SELECT TO app_agent_run_executor USING (true);
CREATE POLICY agent_schools_lock ON app.schools FOR UPDATE TO app_agent_run_executor
  USING (true) WITH CHECK (false);
CREATE POLICY agent_jobs ON app.jobs FOR SELECT TO app_agent_run_executor
  USING (subject_id = auth.uid());
CREATE POLICY agent_jobs_lock ON app.jobs FOR UPDATE TO app_agent_run_executor
  USING (subject_id = auth.uid()) WITH CHECK (false);

CREATE FUNCTION app.guard_agent_run() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'awaiting_approval' THEN RAISE EXCEPTION 'invalid_run_transition'; END IF;
  ELSE
    IF (NEW.id,NEW.project_id,NEW.owner_id,NEW.mode,NEW.created_at,
        NEW.base_snapshot_id,NEW.approved_plan) IS DISTINCT FROM
       (OLD.id,OLD.project_id,OLD.owner_id,OLD.mode,OLD.created_at,
        OLD.base_snapshot_id,OLD.approved_plan) THEN
      RAISE EXCEPTION 'immutable_run_identity';
    END IF;
    IF NEW.state <> OLD.state AND NOT (
      OLD.state = 'awaiting_approval' AND NEW.state IN ('stopping','stopped','failed')
      OR OLD.state = 'stopping' AND NEW.state IN ('stopped','failed')
    ) THEN RAISE EXCEPTION 'invalid_run_transition'; END IF;
    IF NEW.state IN ('stopped','failed') AND EXISTS (
      SELECT 1 FROM app.agent_run_jobs r JOIN app.jobs j ON j.id=r.job_id
      WHERE r.run_id=NEW.id AND j.state IN ('queued','leased')
    ) THEN RAISE EXCEPTION 'run_jobs_not_terminal'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION app.guard_agent_run() OWNER TO postgres;
-- 觸發器需要完整關聯檢查，不給 caller 任意讀寫能力。
ALTER FUNCTION app.guard_agent_run() SECURITY DEFINER;
REVOKE ALL ON FUNCTION app.guard_agent_run() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER agent_run_transition BEFORE INSERT OR UPDATE ON app.agent_runs
  FOR EACH ROW EXECUTE FUNCTION app.guard_agent_run();

CREATE FUNCTION app.guard_agent_run_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE r app.agent_runs; j app.jobs;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'immutable_run_job'; END IF;
  SELECT * INTO r FROM app.agent_runs WHERE id=NEW.run_id FOR UPDATE;
  SELECT * INTO j FROM app.jobs WHERE id=NEW.job_id FOR UPDATE;
  IF r.id IS NULL OR j.id IS NULL
    OR r.state NOT IN ('awaiting_approval','running')
    OR j.state NOT IN ('queued','leased') OR j.cancel_requested
    OR r.owner_id IS DISTINCT FROM NEW.owner_id OR r.project_id IS DISTINCT FROM NEW.project_id
    OR j.subject_id IS DISTINCT FROM r.owner_id OR j.resource_id IS DISTINCT FROM r.project_id
    OR j.kind <> 'agent' OR NEW.kind <> 'agent' THEN
    RAISE EXCEPTION 'invalid_run_job';
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION app.guard_agent_run_job() OWNER TO postgres;
REVOKE ALL ON FUNCTION app.guard_agent_run_job() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER agent_run_job_identity BEFORE INSERT OR UPDATE ON app.agent_run_jobs
  FOR EACH ROW EXECUTE FUNCTION app.guard_agent_run_job();

CREATE FUNCTION app.agent_actor_locked() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE a app.profiles; s uuid;
BEGIN
  SELECT id,role,school_id INTO a.id,a.role,a.school_id FROM app.profiles
    WHERE id=auth.uid() FOR SHARE;
  SELECT id INTO s FROM app.schools WHERE id=a.school_id FOR SHARE;
  RETURN a.id IS NOT NULL AND a.role='student' AND s IS NOT NULL
    AND app.current_account_gate('edit_saved_content');
END
$function$;
ALTER FUNCTION app.agent_actor_locked() OWNER TO app_agent_run_executor;
REVOKE ALL ON FUNCTION app.agent_actor_locked() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.agent_run_dto(p_run uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT jsonb_build_object('run_id',r.id,'project_id',r.project_id,'mode',r.mode,'state',r.state,
    'jobs',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'job_id',j.id,'state',j.state,'cancel_requested',j.cancel_requested) ORDER BY j.id)
      FROM app.agent_run_jobs b JOIN app.jobs j ON j.id=b.job_id WHERE b.run_id=r.id),'[]'::jsonb))
  FROM app.agent_runs r WHERE r.id=p_run
$function$;
ALTER FUNCTION app.agent_run_dto(uuid) OWNER TO app_agent_run_executor;
REVOKE ALL ON FUNCTION app.agent_run_dto(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.create_agent_run(
  p_project uuid, p_mode text, p_instruction text, p_key uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE v_owner uuid := auth.uid(); v_project uuid; v_run uuid;
  v_digest bytea; v_receipt app.agent_run_create_receipts; v_now timestamptz; v_dto jsonb;
BEGIN
  IF p_project IS NULL OR p_mode IS NULL OR p_mode NOT IN ('guided','auto')
    OR p_instruction IS NULL OR length(p_instruction)=0 OR p_key IS NULL THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;
  IF v_owner IS NULL OR NOT app.current_account_gate('edit_saved_content') THEN
    RETURN '{"outcome":"denied"}';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text||':agent_run_create_v1:'||p_key::text,0));
  SELECT id INTO v_project FROM app.projects WHERE id=p_project AND owner_id=v_owner FOR UPDATE;
  IF NOT app.agent_actor_locked() THEN RETURN '{"outcome":"denied"}'; END IF;
  IF v_project IS NULL THEN RETURN '{"outcome":"not_found"}'; END IF;
  v_digest := sha256(convert_to(jsonb_build_object(
    'project_id',p_project,'mode',p_mode,'instruction',p_instruction)::text,'UTF8'));
  v_now := clock_timestamp();
  SELECT * INTO v_receipt FROM app.agent_run_create_receipts
    WHERE owner_id=v_owner AND idempotency_key=p_key FOR UPDATE;
  IF FOUND AND v_receipt.expires_at > v_now THEN
    IF v_receipt.request_digest <> v_digest THEN RETURN '{"outcome":"idempotency_conflict"}'; END IF;
    RETURN jsonb_build_object('outcome','replayed','operation',v_receipt.response,
      'current',app.agent_run_dto(v_receipt.run_id));
  END IF;
  IF EXISTS (SELECT 1 FROM app.agent_runs WHERE project_id=p_project
      AND state IN ('awaiting_approval','running','stopping')) THEN
    RETURN '{"outcome":"active_run_conflict"}';
  END IF;
  DELETE FROM app.agent_run_create_receipts WHERE owner_id=v_owner AND idempotency_key=p_key;
  INSERT INTO app.agent_runs(project_id,owner_id,mode) VALUES(p_project,v_owner,p_mode) RETURNING id INTO v_run;
  v_dto := app.agent_run_dto(v_run);
  INSERT INTO app.agent_run_create_receipts(owner_id,idempotency_key,run_id,request_digest,response,created_at,expires_at)
    VALUES(v_owner,p_key,v_run,v_digest,v_dto,v_now,v_now+interval '24 hours');
  RETURN jsonb_build_object('outcome','created','operation',v_dto,'current',v_dto);
END
$function$;

CREATE FUNCTION app.owned_agent_run(p_run uuid, p_stop boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE v_owner uuid := auth.uid(); r app.agent_runs; v_project uuid; v_active boolean;
BEGIN
  IF p_run IS NULL OR p_stop IS NULL THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  IF v_owner IS NULL OR NOT app.current_account_gate('edit_saved_content') THEN
    RETURN '{"outcome":"denied"}';
  END IF;
  SELECT * INTO r FROM app.agent_runs WHERE id=p_run AND owner_id=v_owner;
  IF r.id IS NOT NULL THEN
    SELECT id INTO v_project FROM app.projects WHERE id=r.project_id AND owner_id=v_owner FOR UPDATE;
    SELECT * INTO r FROM app.agent_runs WHERE id=p_run AND owner_id=v_owner FOR UPDATE;
    PERFORM j.id FROM app.agent_run_jobs b JOIN app.jobs j ON j.id=b.job_id
      WHERE b.run_id=p_run ORDER BY j.id FOR UPDATE OF j;
  END IF;
  -- 所有資源鎖等待結束後才鎖當下 actor／school 並重新核對；撤權可在等待期間提交。
  IF NOT app.agent_actor_locked() THEN RETURN '{"outcome":"denied"}'; END IF;
  IF r.id IS NULL OR v_project IS NULL THEN RETURN '{"outcome":"not_found"}'; END IF;
  IF p_stop AND r.state NOT IN ('completed','stopped','failed') THEN
    PERFORM app.job_cancel(j.id) FROM app.agent_run_jobs b JOIN app.jobs j ON j.id=b.job_id
      WHERE b.run_id=r.id AND j.state IN ('queued','leased');
    SELECT EXISTS (SELECT 1 FROM app.agent_run_jobs b JOIN app.jobs j ON j.id=b.job_id
      WHERE b.run_id=r.id AND j.state IN ('queued','leased')) INTO v_active;
    UPDATE app.agent_runs SET state=CASE WHEN v_active THEN 'stopping' ELSE 'stopped' END WHERE id=r.id;
  END IF;
  RETURN jsonb_build_object('outcome',CASE WHEN p_stop THEN 'stop_acknowledged' ELSE 'found' END,
    'run',app.agent_run_dto(r.id));
END
$function$;

CREATE FUNCTION app.start_agent_run(p_run uuid, p_approval jsonb, p_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE v_read jsonb; v_mode text;
BEGIN
  IF p_key IS NULL OR p_approval IS NULL OR jsonb_typeof(p_approval)<>'object' THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;
  v_read := app.owned_agent_run(p_run,false);
  IF v_read->>'outcome'<>'found' THEN RETURN v_read; END IF;
  v_mode := v_read->'run'->>'mode';
  IF (SELECT count(*) FROM jsonb_object_keys(p_approval)) <> 1 THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;
  IF v_mode='guided' THEN
    IF NOT (p_approval ? 'step_seq') OR jsonb_typeof(p_approval->'step_seq') <> 'number'
      OR (p_approval->>'step_seq') !~ '^[1-9][0-9]*$' THEN
      RETURN '{"outcome":"invalid_input"}';
    END IF;
  ELSE
    IF NOT (p_approval ? 'approved_task_ids')
      OR jsonb_typeof(p_approval->'approved_task_ids') <> 'array' THEN
      RETURN '{"outcome":"invalid_input"}';
    END IF;
    IF jsonb_array_length(p_approval->'approved_task_ids') = 0 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_approval->'approved_task_ids') e
      WHERE jsonb_typeof(e) <> 'string' OR (e #>> '{}') !~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ) THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  END IF;
  IF v_read->'run'->>'state' <> 'awaiting_approval' THEN
    RETURN '{"outcome":"state_conflict"}';
  END IF;
  RETURN '{"outcome":"unavailable","missing":["pre_agent_snapshot","agent_approval_evidence","agent_execution_authorization"]}';
END
$function$;

ALTER FUNCTION app.create_agent_run(uuid,text,text,uuid) OWNER TO app_agent_run_executor;
ALTER FUNCTION app.owned_agent_run(uuid,boolean) OWNER TO app_agent_run_executor;
ALTER FUNCTION app.start_agent_run(uuid,jsonb,uuid) OWNER TO app_agent_run_executor;
REVOKE ALL ON FUNCTION app.create_agent_run(uuid,text,text,uuid),
  app.owned_agent_run(uuid,boolean), app.start_agent_run(uuid,jsonb,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.create_agent_run(uuid,text,text,uuid),
  app.owned_agent_run(uuid,boolean), app.start_agent_run(uuid,jsonb,uuid) TO authenticated;
COMMIT;
