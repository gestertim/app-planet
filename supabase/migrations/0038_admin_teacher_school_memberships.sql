BEGIN;

CREATE ROLE app_membership_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA app,auth TO app_membership_writer;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_membership_writer;
GRANT SELECT(id,role,status,deletion_state,display_label) ON app.profiles TO app_membership_writer;
GRANT SELECT(id,label,approval_state,valid_until) ON app.schools TO app_membership_writer;
GRANT UPDATE(id) ON app.profiles,app.schools TO app_membership_writer;
GRANT SELECT,INSERT ON app.teacher_school_memberships TO app_membership_writer;
GRANT UPDATE(state,ended_at,ended_by_aid) ON app.teacher_school_memberships TO app_membership_writer;
CREATE POLICY membership_profiles_read ON app.profiles FOR SELECT TO app_membership_writer USING(true);
CREATE POLICY membership_profiles_lock ON app.profiles FOR UPDATE TO app_membership_writer USING(true) WITH CHECK(false);
CREATE POLICY membership_schools_read ON app.schools FOR SELECT TO app_membership_writer USING(true);
CREATE POLICY membership_schools_lock ON app.schools FOR UPDATE TO app_membership_writer USING(true) WITH CHECK(false);
CREATE POLICY membership_read ON app.teacher_school_memberships FOR SELECT TO app_membership_writer USING(true);
CREATE POLICY membership_insert ON app.teacher_school_memberships FOR INSERT TO app_membership_writer
  WITH CHECK(state='active' AND ended_at IS NULL AND ended_by_aid IS NULL);
CREATE POLICY membership_end ON app.teacher_school_memberships FOR UPDATE TO app_membership_writer
  USING(true) WITH CHECK(state='ended' AND ended_at IS NOT NULL AND ended_by_aid IS NOT NULL);

-- 0034 reader 呼叫 0030 的 invoker helper 所需的唯一缺漏欄位；不新增對外投影。
GRANT SELECT(specification_review_epoch) ON app.schools TO app_teacher_resource_reader;

-- 不回填或改寫既有歷史；新異動只允許 active → ended，既有 0030 trigger 遞增 epoch。
CREATE FUNCTION app.guard_membership_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.state<>'active' OR NEW.state<>'ended' OR NEW.ended_at IS NULL OR NEW.ended_by_aid IS NULL
    OR (to_jsonb(NEW)-ARRAY['state','ended_at','ended_by_aid','specification_review_epoch'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','ended_at','ended_by_aid','specification_review_epoch'])
    THEN RAISE EXCEPTION 'membership_history_immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION app.guard_membership_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER membership_history_immutable BEFORE UPDATE ON app.teacher_school_memberships
  FOR EACH ROW EXECUTE FUNCTION app.guard_membership_history();

CREATE TABLE app.membership_operation_receipts (
  actor_id uuid NOT NULL REFERENCES app.profiles(id),
  operation_key uuid NOT NULL,
  intent jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(actor_id,operation_key)
);
ALTER TABLE app.membership_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.membership_operation_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.membership_operation_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON app.membership_operation_receipts TO app_membership_writer;
CREATE POLICY membership_receipt_read ON app.membership_operation_receipts FOR SELECT TO app_membership_writer
  USING(actor_id=auth.uid());
CREATE POLICY membership_receipt_insert ON app.membership_operation_receipts FOR INSERT TO app_membership_writer
  WITH CHECK(actor_id=auth.uid());
GRANT SELECT,INSERT ON app.audit_identity_map TO app_membership_writer;
GRANT INSERT ON app.audit_events TO app_membership_writer;
CREATE POLICY membership_aid_read ON app.audit_identity_map FOR SELECT TO app_membership_writer USING(true);
CREATE POLICY membership_aid_insert ON app.audit_identity_map FOR INSERT TO app_membership_writer WITH CHECK(true);
CREATE POLICY membership_audit_insert ON app.audit_events FOR INSERT TO app_membership_writer
  WITH CHECK(action IN ('membership_created','membership_ended'));
DO $$
DECLARE prior text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT prior FROM pg_constraint
    WHERE conrelid='app.audit_events'::regclass AND conname='audit_events_staff_shape';
  ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_staff_shape;
  EXECUTE 'ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_staff_shape CHECK (('||prior||') OR coalesce((
    action IN (''membership_created'',''membership_ended'') AND object_type=''membership''
    AND object_ref IS NOT NULL AND school_id IS NOT NULL AND subject_aid IS NOT NULL AND result=''ok''
    AND jsonb_typeof(meta)=''object'' AND meta ?& ARRAY[''from_state'',''to_state'']
    AND (meta-ARRAY[''from_state'',''to_state''])=''{}''::jsonb
    AND ((action=''membership_created'' AND meta->''from_state''=''null''::jsonb AND meta->>''to_state''=''active'')
      OR (action=''membership_ended'' AND meta->>''from_state''=''active'' AND meta->>''to_state''=''ended''))
  ),false))';
END; $$;

CREATE FUNCTION app.membership_admin_valid() RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM app.profiles WHERE id=auth.uid() AND role='admin'
    AND status='approved' AND deletion_state='none')
$$;
CREATE FUNCTION app.membership_audit(p_id uuid,p_teacher uuid,p_school uuid,p_end boolean) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor uuid; teacher uuid;
BEGIN
  INSERT INTO app.audit_identity_map(aid,account_id,created_at)
    SELECT gen_random_uuid(),id,clock_timestamp() FROM app.profiles
    WHERE id IN (auth.uid(),p_teacher) ORDER BY id ON CONFLICT(account_id) DO NOTHING;
  SELECT aid INTO STRICT actor FROM app.audit_identity_map WHERE account_id=auth.uid();
  SELECT aid INTO STRICT teacher FROM app.audit_identity_map WHERE account_id=p_teacher;
  INSERT INTO app.audit_events(id,at,actor_aid,subject_aid,action,object_type,object_ref,school_id,result,meta)
    VALUES(gen_random_uuid(),clock_timestamp(),actor,teacher,
      CASE WHEN p_end THEN 'membership_ended' ELSE 'membership_created' END,'membership',p_id,p_school,'ok',
      jsonb_build_object('from_state',CASE WHEN p_end THEN 'active' ELSE NULL END,
        'to_state',CASE WHEN p_end THEN 'ended' ELSE 'active' END));
  RETURN actor;
END; $$;

CREATE FUNCTION app.create_teacher_school_membership(p_teacher uuid,p_school uuid,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old app.membership_operation_receipts%ROWTYPE;
  intent jsonb:=jsonb_build_object('operation','create','teacher_id',p_teacher,'school_id',p_school);
  result jsonb; membership uuid:=gen_random_uuid(); actor uuid; at timestamptz;
BEGIN
  IF NOT app.membership_admin_valid() THEN RETURN '{"outcome":"denied"}'; END IF;
  IF p_teacher IS NULL OR p_school IS NULL OR p_key IS NULL THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('membership-key:'||auth.uid()::text||':'||p_key::text,0));
  -- 與 reader／決策一致：profiles（UUID 排序）→ school → membership；pair 鎖在 membership 之前。
  PERFORM id FROM app.profiles WHERE id IN (auth.uid(),p_teacher) ORDER BY id FOR SHARE;
  IF NOT app.membership_admin_valid() THEN RETURN '{"outcome":"denied"}'; END IF;
  SELECT * INTO old FROM app.membership_operation_receipts WHERE actor_id=auth.uid() AND operation_key=p_key;
  IF FOUND THEN
    IF old.intent IS DISTINCT FROM intent THEN RETURN '{"outcome":"idempotency_conflict"}'; END IF;
    RETURN old.result||'{"outcome":"replayed"}'::jsonb;
  END IF;
  PERFORM id FROM app.schools WHERE id=p_school FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('membership-pair:'||p_teacher::text||':'||p_school::text,0));
  PERFORM id FROM app.teacher_school_memberships WHERE teacher_id=p_teacher AND school_id=p_school
    AND state='active' ORDER BY id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM app.profiles WHERE id=p_teacher AND role='teacher'
    AND status='approved' AND deletion_state='none') THEN RETURN '{"outcome":"teacher_not_eligible"}'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.schools WHERE id=p_school AND approval_state='approved'
    AND (valid_until IS NULL OR valid_until>clock_timestamp()))
    THEN RETURN '{"outcome":"membership_school_not_supported"}'; END IF;
  IF EXISTS(SELECT 1 FROM app.teacher_school_memberships WHERE teacher_id=p_teacher AND school_id=p_school AND state='active')
    THEN RETURN '{"outcome":"membership_exists"}'; END IF;
  actor:=app.membership_audit(membership,p_teacher,p_school,false);
  at:=clock_timestamp();
  INSERT INTO app.teacher_school_memberships(id,teacher_id,school_id,state,created_by_aid,created_at)
    VALUES(membership,p_teacher,p_school,'active',actor,at);
  result:=jsonb_build_object('outcome','created','operation','create','membership_id',membership,
    'teacher_id',p_teacher,'school_id',p_school,'state','active',
    'operated_at',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  INSERT INTO app.membership_operation_receipts VALUES(auth.uid(),p_key,intent,result);
  RETURN result;
END; $$;

CREATE FUNCTION app.end_teacher_school_membership(p_membership uuid,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old app.membership_operation_receipts%ROWTYPE; m app.teacher_school_memberships%ROWTYPE;
  intent jsonb:=jsonb_build_object('operation','end','membership_id',p_membership);
  result jsonb; actor uuid; at timestamptz;
BEGIN
  IF NOT app.membership_admin_valid() THEN RETURN '{"outcome":"denied"}'; END IF;
  IF p_membership IS NULL OR p_key IS NULL THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('membership-key:'||auth.uid()::text||':'||p_key::text,0));
  SELECT * INTO m FROM app.teacher_school_memberships WHERE id=p_membership;
  PERFORM id FROM app.profiles WHERE id IN (auth.uid(),m.teacher_id) ORDER BY id FOR SHARE;
  IF NOT app.membership_admin_valid() THEN RETURN '{"outcome":"denied"}'; END IF;
  SELECT * INTO old FROM app.membership_operation_receipts WHERE actor_id=auth.uid() AND operation_key=p_key;
  IF FOUND THEN
    IF old.intent IS DISTINCT FROM intent THEN RETURN '{"outcome":"idempotency_conflict"}'; END IF;
    RETURN old.result||'{"outcome":"replayed"}'::jsonb;
  END IF;
  IF m.id IS NULL THEN RETURN '{"outcome":"not_found"}'; END IF;
  PERFORM id FROM app.schools WHERE id=m.school_id FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('membership-pair:'||m.teacher_id::text||':'||m.school_id::text,0));
  SELECT * INTO m FROM app.teacher_school_memberships WHERE id=p_membership FOR UPDATE;
  IF NOT FOUND OR m.state<>'active' THEN RETURN '{"outcome":"membership_ended"}'; END IF;
  actor:=app.membership_audit(m.id,m.teacher_id,m.school_id,true);
  at:=clock_timestamp();
  UPDATE app.teacher_school_memberships SET state='ended',ended_at=at,ended_by_aid=actor WHERE id=m.id;
  result:=jsonb_build_object('outcome','ended','operation','end','membership_id',m.id,
    'teacher_id',m.teacher_id,'school_id',m.school_id,'state','ended',
    'operated_at',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  INSERT INTO app.membership_operation_receipts VALUES(auth.uid(),p_key,intent,result);
  RETURN result;
END; $$;

CREATE FUNCTION app.list_membership_options(p_kind text,p_after uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE items jsonb; cursor uuid;
BEGIN
  PERFORM id FROM app.profiles WHERE id=auth.uid() FOR SHARE;
  IF NOT app.membership_admin_valid() THEN RETURN '{"outcome":"denied"}'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('teachers','schools','memberships') THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  WITH candidates AS MATERIALIZED (
    SELECT t.id,jsonb_build_object('id',t.id,'display_label',left(coalesce(t.display_label,'未設定標籤'),120),
      'qualified',true) item FROM app.profiles t
    WHERE p_kind='teachers' AND t.role='teacher' AND t.status='approved' AND t.deletion_state='none'
      AND (p_after IS NULL OR t.id>p_after)
    UNION ALL
    SELECT s.id,jsonb_build_object('id',s.id,'display_label',left(s.label,120),'qualified',true)
    FROM app.schools s WHERE p_kind='schools' AND s.approval_state='approved'
      AND (s.valid_until IS NULL OR s.valid_until>clock_timestamp()) AND (p_after IS NULL OR s.id>p_after)
    UNION ALL
    SELECT m.id,jsonb_build_object('id',m.id,'teacher_id',m.teacher_id,'school_id',m.school_id,'state',m.state,
      'teacher_label',left(coalesce(t.display_label,'未設定標籤'),120),'school_label',left(s.label,120))
    FROM app.teacher_school_memberships m JOIN app.profiles t ON t.id=m.teacher_id JOIN app.schools s ON s.id=m.school_id
    WHERE p_kind='memberships' AND (p_after IS NULL OR m.id>p_after)
    ORDER BY id LIMIT 21
  ), page AS (SELECT * FROM candidates ORDER BY id LIMIT 20)
  SELECT coalesce(jsonb_agg(item ORDER BY id),'[]'::jsonb),
    CASE WHEN (SELECT count(*) FROM candidates)>20 THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END
    INTO items,cursor FROM page;
  RETURN jsonb_build_object('outcome','found','kind',p_kind,'items',items,'next_cursor',cursor);
END; $$;

GRANT CREATE ON SCHEMA app TO app_membership_writer;
GRANT app_membership_writer TO supabase_admin WITH ADMIN FALSE,INHERIT FALSE,SET TRUE;
ALTER FUNCTION app.membership_admin_valid() OWNER TO app_membership_writer;
ALTER FUNCTION app.membership_audit(uuid,uuid,uuid,boolean) OWNER TO app_membership_writer;
ALTER FUNCTION app.create_teacher_school_membership(uuid,uuid,uuid) OWNER TO app_membership_writer;
ALTER FUNCTION app.end_teacher_school_membership(uuid,uuid) OWNER TO app_membership_writer;
ALTER FUNCTION app.list_membership_options(text,uuid) OWNER TO app_membership_writer;
REVOKE app_membership_writer FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_membership_writer;
REVOKE ALL ON FUNCTION app.membership_admin_valid(),app.membership_audit(uuid,uuid,uuid,boolean),
  app.create_teacher_school_membership(uuid,uuid,uuid),app.end_teacher_school_membership(uuid,uuid),
  app.list_membership_options(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.create_teacher_school_membership(uuid,uuid,uuid),
  app.end_teacher_school_membership(uuid,uuid),app.list_membership_options(text,uuid) TO authenticated;
COMMIT;
