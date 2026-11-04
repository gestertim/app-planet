BEGIN;

CREATE OR REPLACE FUNCTION app.create_teacher_student_binding(p_teacher uuid,p_student uuid,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old app.binding_operation_receipts%ROWTYPE; s app.profiles%ROWTYPE;
  intent jsonb := jsonb_build_object('operation','create','teacher_id',p_teacher,'student_id',p_student);
  result jsonb; eligibility text; binding uuid := gen_random_uuid(); actor uuid; at timestamptz; membership uuid;
BEGIN
  IF NOT app.binding_admin_valid() THEN RETURN '{"outcome":"denied"}'; END IF;
  IF p_teacher IS NULL OR p_student IS NULL OR p_key IS NULL THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('binding-key:'||auth.uid()::text||':'||p_key::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('binding-id:'||binding::text,0));
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

CREATE OR REPLACE FUNCTION app.end_teacher_student_binding(p_binding uuid,p_reason text,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old app.binding_operation_receipts%ROWTYPE; b app.teacher_student_bindings%ROWTYPE;
  intent jsonb := jsonb_build_object('operation','end','binding_id',p_binding,'end_reason',p_reason);
  result jsonb; school uuid; actor uuid; at timestamptz;
BEGIN
  IF NOT app.binding_admin_valid() THEN RETURN '{"outcome":"denied"}'; END IF;
  IF p_binding IS NULL OR p_key IS NULL OR NOT app.specification_reason_valid(p_reason)
    THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('binding-key:'||auth.uid()::text||':'||p_key::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('binding-id:'||p_binding::text,0));
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

COMMIT;
