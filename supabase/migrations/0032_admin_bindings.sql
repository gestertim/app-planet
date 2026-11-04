BEGIN;

CREATE ROLE app_binding_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA app,auth TO app_binding_writer;
GRANT EXECUTE ON FUNCTION auth.uid(),app.specification_reason_valid(text) TO app_binding_writer;
GRANT SELECT ON app.profiles,app.schools,app.teacher_school_memberships,app.teacher_student_bindings TO app_binding_writer;
GRANT UPDATE(id) ON app.profiles,app.schools,app.teacher_school_memberships TO app_binding_writer;
GRANT INSERT ON app.teacher_student_bindings TO app_binding_writer;
GRANT UPDATE(state,ended_at,ended_by_aid,end_reason) ON app.teacher_student_bindings TO app_binding_writer;
CREATE POLICY binding_profiles_read ON app.profiles FOR SELECT TO app_binding_writer USING(true);
CREATE POLICY binding_profiles_lock ON app.profiles FOR UPDATE TO app_binding_writer USING(true) WITH CHECK(false);
CREATE POLICY binding_schools_read ON app.schools FOR SELECT TO app_binding_writer USING(true);
CREATE POLICY binding_schools_lock ON app.schools FOR UPDATE TO app_binding_writer USING(true) WITH CHECK(false);
CREATE POLICY binding_memberships_read ON app.teacher_school_memberships FOR SELECT TO app_binding_writer USING(true);
CREATE POLICY binding_memberships_lock ON app.teacher_school_memberships FOR UPDATE TO app_binding_writer USING(true) WITH CHECK(false);
CREATE POLICY binding_read ON app.teacher_student_bindings FOR SELECT TO app_binding_writer USING(true);
CREATE POLICY binding_insert ON app.teacher_student_bindings FOR INSERT TO app_binding_writer WITH CHECK(state='active');
CREATE POLICY binding_end ON app.teacher_student_bindings FOR UPDATE TO app_binding_writer
  USING(true) WITH CHECK(state='ended' AND ended_at IS NOT NULL AND ended_by_aid IS NOT NULL
    AND app.specification_reason_valid(end_reason));

CREATE TABLE app.binding_operation_receipts (
  actor_id uuid NOT NULL REFERENCES app.profiles(id),
  operation_key uuid NOT NULL,
  intent jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(actor_id,operation_key)
);
ALTER TABLE app.binding_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.binding_operation_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.binding_operation_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON app.binding_operation_receipts TO app_binding_writer;
CREATE POLICY binding_receipt_read ON app.binding_operation_receipts FOR SELECT TO app_binding_writer USING(actor_id=auth.uid());
CREATE POLICY binding_receipt_insert ON app.binding_operation_receipts FOR INSERT TO app_binding_writer WITH CHECK(actor_id=auth.uid());
GRANT SELECT,INSERT ON app.audit_identity_map TO app_binding_writer;
GRANT INSERT ON app.audit_events TO app_binding_writer;
CREATE POLICY binding_aid_read ON app.audit_identity_map FOR SELECT TO app_binding_writer USING(true);
CREATE POLICY binding_aid_insert ON app.audit_identity_map FOR INSERT TO app_binding_writer WITH CHECK(true);
CREATE POLICY binding_audit_insert ON app.audit_events FOR INSERT TO app_binding_writer
  WITH CHECK(action IN ('binding_created','binding_ended'));

-- 保留既有 whitelist，以獨立 OR 分支加入最小綁定異動（理由不進 meta）。
DO $$
DECLARE prior text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT prior FROM pg_constraint
    WHERE conrelid='app.audit_events'::regclass AND conname='audit_events_staff_shape';
  ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_staff_shape;
  EXECUTE 'ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_staff_shape CHECK (('||prior||') OR coalesce((
    action IN (''binding_created'',''binding_ended'') AND object_type=''binding''
    AND object_ref IS NOT NULL AND subject_aid IS NOT NULL AND result=''ok''
    AND jsonb_typeof(meta)=''object''
    AND meta ?& ARRAY[''from_state'',''to_state'',''teacher_aid'']
    AND (meta-ARRAY[''from_state'',''to_state'',''teacher_aid''])=''{}''::jsonb
    AND meta->>''teacher_aid'' ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''
    AND ((action=''binding_created'' AND meta->''from_state''=''null''::jsonb AND meta->>''to_state''=''active'')
      OR (action=''binding_ended'' AND meta->>''from_state''=''active'' AND meta->>''to_state''=''ended''))
  ),false))';
END; $$;

CREATE FUNCTION app.binding_admin_valid() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM app.profiles WHERE id=auth.uid() AND role='admin'
    AND status='approved' AND deletion_state='none')
$$;
CREATE FUNCTION app.binding_eligibility(p_teacher uuid,p_student uuid) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE s app.profiles%ROWTYPE;
BEGIN
  IF p_teacher=p_student THEN RETURN 'invalid_pair'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.profiles WHERE id=p_teacher AND role='teacher'
    AND status='approved' AND deletion_state='none') THEN RETURN 'teacher_not_eligible'; END IF;
  SELECT * INTO s FROM app.profiles WHERE id=p_student AND role='student'
    AND status='approved' AND deletion_state='none';
  IF NOT FOUND THEN RETURN 'student_not_approved'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.schools WHERE id=s.school_id AND approval_state='approved'
    AND (valid_until IS NULL OR valid_until>clock_timestamp())) THEN RETURN 'school_not_eligible'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.teacher_school_memberships WHERE teacher_id=p_teacher
    AND school_id=s.school_id AND state='active') THEN RETURN 'teacher_school_mismatch'; END IF;
  RETURN NULL;
END; $$;
CREATE FUNCTION app.binding_audit(p_binding uuid,p_teacher uuid,p_student uuid,p_school uuid,p_end boolean)
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor uuid; student uuid; teacher uuid;
BEGIN
  INSERT INTO app.audit_identity_map(aid,account_id,created_at)
    SELECT gen_random_uuid(),id,clock_timestamp() FROM app.profiles
    WHERE id IN (auth.uid(),p_teacher,p_student) ORDER BY id ON CONFLICT(account_id) DO NOTHING;
  SELECT aid INTO STRICT actor FROM app.audit_identity_map WHERE account_id=auth.uid();
  SELECT aid INTO STRICT student FROM app.audit_identity_map WHERE account_id=p_student;
  SELECT aid INTO STRICT teacher FROM app.audit_identity_map WHERE account_id=p_teacher;
  INSERT INTO app.audit_events(id,at,actor_aid,subject_aid,action,object_type,object_ref,school_id,result,meta)
    VALUES(gen_random_uuid(),clock_timestamp(),actor,student,
      CASE WHEN p_end THEN 'binding_ended' ELSE 'binding_created' END,'binding',p_binding,p_school,'ok',
      jsonb_build_object('from_state',CASE WHEN p_end THEN 'active' ELSE NULL END,
        'to_state',CASE WHEN p_end THEN 'ended' ELSE 'active' END,'teacher_aid',teacher));
  RETURN actor;
END; $$;

CREATE FUNCTION app.create_teacher_student_binding(p_teacher uuid,p_student uuid,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old app.binding_operation_receipts%ROWTYPE; s app.profiles%ROWTYPE;
  intent jsonb := jsonb_build_object('operation','create','teacher_id',p_teacher,'student_id',p_student);
  result jsonb; eligibility text; binding uuid := gen_random_uuid(); actor uuid; at timestamptz; membership uuid;
BEGIN
  IF NOT app.binding_admin_valid() THEN RETURN '{"outcome":"denied"}'; END IF;
  IF p_teacher IS NULL OR p_student IS NULL OR p_key IS NULL THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('binding-key:'||auth.uid()::text||':'||p_key::text,0));
  -- 與 Specification 決策相同：profiles（UUID 排序）→ school → membership → binding。
  PERFORM id FROM app.profiles WHERE id IN (auth.uid(),p_teacher,p_student) ORDER BY id FOR SHARE;
  IF NOT app.binding_admin_valid() THEN RETURN '{"outcome":"denied"}'; END IF;
  SELECT * INTO old FROM app.binding_operation_receipts WHERE actor_id=auth.uid() AND operation_key=p_key;
  IF FOUND THEN
    IF old.intent IS DISTINCT FROM intent THEN RETURN '{"outcome":"idempotency_conflict"}'; END IF;
    RETURN old.result||'{"outcome":"replayed"}'::jsonb;
  END IF;
  SELECT * INTO s FROM app.profiles WHERE id=p_student;
  PERFORM id FROM app.schools WHERE id=s.school_id FOR SHARE;
  SELECT id INTO membership FROM app.teacher_school_memberships WHERE teacher_id=p_teacher AND school_id=s.school_id
    AND state='active' ORDER BY id FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('binding-pair:'||p_teacher::text||':'||p_student::text,0));
  PERFORM id FROM app.teacher_student_bindings WHERE teacher_id=p_teacher AND student_id=p_student
    AND state='active' ORDER BY id FOR UPDATE;
  eligibility := app.binding_eligibility(p_teacher,p_student);
  IF eligibility IS NOT NULL THEN RETURN jsonb_build_object('outcome',eligibility); END IF;
  IF membership IS NULL THEN RETURN '{"outcome":"teacher_school_mismatch"}'; END IF;
  IF EXISTS(SELECT 1 FROM app.teacher_student_bindings WHERE teacher_id=p_teacher AND student_id=p_student AND state='active')
    THEN RETURN '{"outcome":"binding_exists"}'; END IF;
  actor := app.binding_audit(binding,p_teacher,p_student,s.school_id,false);
  at := clock_timestamp();
  INSERT INTO app.teacher_student_bindings(id,teacher_id,student_id,state,created_by_aid,created_at)
    VALUES(binding,p_teacher,p_student,'active',actor,at);
  result := jsonb_build_object('outcome','created','operation','create','binding_id',binding,'state','active',
    'operated_at',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  INSERT INTO app.binding_operation_receipts VALUES(auth.uid(),p_key,intent,result);
  RETURN result;
END; $$;

CREATE FUNCTION app.end_teacher_student_binding(p_binding uuid,p_reason text,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old app.binding_operation_receipts%ROWTYPE; b app.teacher_student_bindings%ROWTYPE;
  intent jsonb := jsonb_build_object('operation','end','binding_id',p_binding,'end_reason',p_reason);
  result jsonb; school uuid; actor uuid; at timestamptz;
BEGIN
  IF NOT app.binding_admin_valid() THEN RETURN '{"outcome":"denied"}'; END IF;
  IF p_binding IS NULL OR p_key IS NULL OR NOT app.specification_reason_valid(p_reason)
    THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('binding-key:'||auth.uid()::text||':'||p_key::text,0));
  SELECT * INTO b FROM app.teacher_student_bindings WHERE id=p_binding;
  PERFORM id FROM app.profiles WHERE id IN (auth.uid(),b.teacher_id,b.student_id) ORDER BY id FOR SHARE;
  IF NOT app.binding_admin_valid() THEN RETURN '{"outcome":"denied"}'; END IF;
  SELECT * INTO old FROM app.binding_operation_receipts WHERE actor_id=auth.uid() AND operation_key=p_key;
  IF FOUND THEN
    IF old.intent IS DISTINCT FROM intent THEN RETURN '{"outcome":"idempotency_conflict"}'; END IF;
    RETURN old.result||'{"outcome":"replayed"}'::jsonb;
  END IF;
  IF b.id IS NULL THEN RETURN '{"outcome":"not_found"}'; END IF;
  SELECT school_id INTO school FROM app.profiles WHERE id=b.student_id;
  PERFORM id FROM app.schools WHERE id=school FOR SHARE;
  PERFORM id FROM app.teacher_school_memberships WHERE teacher_id=b.teacher_id AND school_id=school
    AND state='active' ORDER BY id FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('binding-pair:'||b.teacher_id::text||':'||b.student_id::text,0));
  SELECT * INTO b FROM app.teacher_student_bindings WHERE id=p_binding FOR UPDATE;
  IF b.state<>'active' THEN RETURN '{"outcome":"binding_ended"}'; END IF;
  actor := app.binding_audit(b.id,b.teacher_id,b.student_id,school,true);
  at := clock_timestamp();
  UPDATE app.teacher_student_bindings SET state='ended',ended_at=at,ended_by_aid=actor,end_reason=p_reason WHERE id=b.id;
  result := jsonb_build_object('outcome','ended','operation','end','binding_id',b.id,'state','ended',
    'operated_at',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  INSERT INTO app.binding_operation_receipts VALUES(auth.uid(),p_key,intent,result);
  RETURN result;
END; $$;

CREATE FUNCTION app.list_binding_options(p_kind text,p_after uuid,p_teacher uuid,p_school uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE items jsonb; cursor uuid;
BEGIN
  IF NOT app.binding_admin_valid() THEN RETURN '{"outcome":"denied"}'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('teachers','students','bindings')
    OR (p_kind='students' AND (p_teacher IS NULL OR p_school IS NULL))
    THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  IF p_kind='teachers' THEN
    WITH candidates AS MATERIALIZED (
      SELECT m.id,t.id account_id,left(coalesce(t.display_label,'未設定標籤'),120) label,
        sc.id school_id,left(sc.label,120) school_label
      FROM app.teacher_school_memberships m JOIN app.profiles t ON t.id=m.teacher_id
      JOIN app.schools sc ON sc.id=m.school_id
      WHERE t.role='teacher' AND t.status='approved' AND t.deletion_state='none' AND m.state='active'
        AND sc.approval_state='approved' AND (sc.valid_until IS NULL OR sc.valid_until>clock_timestamp())
        AND (p_after IS NULL OR m.id>p_after) ORDER BY m.id LIMIT 21
    ), page AS (SELECT * FROM candidates ORDER BY id LIMIT 20)
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'account_id',account_id,'label',label,
      'role','teacher','qualified',true,'school_id',school_id,'school_label',school_label) ORDER BY id),'[]'::jsonb),
      CASE WHEN (SELECT count(*) FROM candidates)>20 THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END
      INTO items,cursor FROM page;
  ELSIF p_kind='students' THEN
    WITH candidates AS MATERIALIZED (
      SELECT s.id,s.id account_id,left(coalesce(s.display_label,'未設定標籤'),120) label,
        sc.id school_id,left(sc.label,120) school_label
      FROM app.profiles s JOIN app.schools sc ON sc.id=s.school_id
      WHERE s.school_id=p_school AND app.binding_eligibility(p_teacher,s.id) IS NULL
        AND (p_after IS NULL OR s.id>p_after) ORDER BY s.id LIMIT 21
    ), page AS (SELECT * FROM candidates ORDER BY id LIMIT 20)
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'account_id',account_id,'label',label,
      'role','student','qualified',true,'school_id',school_id,'school_label',school_label) ORDER BY id),'[]'::jsonb),
      CASE WHEN (SELECT count(*) FROM candidates)>20 THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END
      INTO items,cursor FROM page;
  ELSE
    WITH candidates AS MATERIALIZED (
      SELECT b.id,b.teacher_id,b.student_id,b.state,
        left(coalesce(t.display_label,'未設定標籤'),120) teacher_label,
        left(coalesce(s.display_label,'未設定標籤'),120) student_label,
        s.school_id,left(sc.label,120) school_label
      FROM app.teacher_student_bindings b JOIN app.profiles t ON t.id=b.teacher_id
      JOIN app.profiles s ON s.id=b.student_id JOIN app.schools sc ON sc.id=s.school_id
      WHERE (p_after IS NULL OR b.id>p_after) ORDER BY b.id LIMIT 21
    ), page AS (SELECT * FROM candidates ORDER BY id LIMIT 20)
    SELECT coalesce(jsonb_agg(to_jsonb(page) ORDER BY id),'[]'::jsonb),
      CASE WHEN (SELECT count(*) FROM candidates)>20 THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END
      INTO items,cursor FROM page;
  END IF;
  RETURN jsonb_build_object('outcome','found','kind',p_kind,'items',items,'next_cursor',cursor);
END; $$;

GRANT CREATE ON SCHEMA app TO app_binding_writer;
GRANT app_binding_writer TO supabase_admin WITH ADMIN FALSE,INHERIT FALSE,SET TRUE;
ALTER FUNCTION app.binding_admin_valid() OWNER TO app_binding_writer;
ALTER FUNCTION app.binding_eligibility(uuid,uuid) OWNER TO app_binding_writer;
ALTER FUNCTION app.binding_audit(uuid,uuid,uuid,uuid,boolean) OWNER TO app_binding_writer;
ALTER FUNCTION app.create_teacher_student_binding(uuid,uuid,uuid) OWNER TO app_binding_writer;
ALTER FUNCTION app.end_teacher_student_binding(uuid,text,uuid) OWNER TO app_binding_writer;
ALTER FUNCTION app.list_binding_options(text,uuid,uuid,uuid) OWNER TO app_binding_writer;
REVOKE app_binding_writer FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_binding_writer;
REVOKE ALL ON FUNCTION app.binding_admin_valid(),app.binding_eligibility(uuid,uuid),
  app.binding_audit(uuid,uuid,uuid,uuid,boolean),app.create_teacher_student_binding(uuid,uuid,uuid),
  app.end_teacher_student_binding(uuid,text,uuid),app.list_binding_options(text,uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.create_teacher_student_binding(uuid,uuid,uuid),
  app.end_teacher_student_binding(uuid,text,uuid),app.list_binding_options(text,uuid,uuid,uuid) TO authenticated;

-- 既有 A-4 投影加上持久歸屬與有效期限；不另建通知／已讀／Realtime 模型。
CREATE OR REPLACE FUNCTION app.current_account_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject uuid:=auth.uid(); a app.profiles%ROWTYPE; sc app.schools%ROWTYPE;
  school_found boolean:=false; teachers jsonb:='[]';
BEGIN
  IF subject IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO a FROM app.profiles WHERE id=subject;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF a.role='student' THEN
    SELECT * INTO sc FROM app.schools WHERE id=a.school_id;
    school_found:=FOUND;
  END IF;
  IF a.role='student' AND a.status='approved' AND a.deletion_state='none'
    AND sc.approval_state='approved' AND (sc.valid_until IS NULL OR sc.valid_until>clock_timestamp()) THEN
    SELECT coalesce(jsonb_agg(to_jsonb(t.display_label) ORDER BY b.created_at,b.id),'[]'::jsonb)
    INTO teachers FROM app.teacher_student_bindings b JOIN app.profiles t ON t.id=b.teacher_id
    JOIN app.teacher_school_memberships m ON m.teacher_id=t.id AND m.school_id=a.school_id AND m.state='active'
    WHERE b.student_id=subject AND b.state='active' AND t.role='teacher'
      AND t.status='approved' AND t.deletion_state='none' AND t.id<>subject;
  END IF;
  RETURN jsonb_build_object('subject',subject,'role',a.role,'status',a.status,'deletion_state',a.deletion_state,
    'school_found',school_found,'school_state',CASE WHEN school_found THEN to_jsonb(sc.approval_state) ELSE 'null'::jsonb END,
    'login_gate',app.account_gate(subject,'login'),'public_deploy_gate',app.account_gate(subject,'public_deploy'),
    'ai_call_gate',app.account_gate(subject,'ai_call'),'teacher_labels',teachers);
END; $$;
COMMIT;
