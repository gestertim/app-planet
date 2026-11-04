-- §92.4：一次性持久派送；不由時間、重啟或新鍵釋放未知操作。
BEGIN;

ALTER TABLE app.teacher_signup_intents ADD COLUMN dispatch_state text NOT NULL DEFAULT 'dispatch_unknown'
  CHECK (dispatch_state IN ('dispatch_unknown','completed','not_applied'));
-- 0028 未消耗的列可能已送往 Auth；即使已過期也不可當成未派送。
UPDATE app.teacher_signup_intents SET dispatch_state='completed' WHERE consumed_at IS NOT NULL;
ALTER TABLE app.teacher_signup_intents ADD CONSTRAINT teacher_signup_dispatch_completion
  CHECK ((dispatch_state='completed') = (consumed_at IS NOT NULL));

CREATE OR REPLACE FUNCTION app.register_teacher_signup_intent(
  p_operation uuid, p_email text, p_display text, p_note text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_ttl integer;
  v_hash bytea;
  v_intent app.teacher_signup_intents%ROWTYPE;
  v_id uuid;
  v_existing boolean;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_operation IS NULL OR p_email IS NULL OR char_length(p_email)>254
    OR p_email !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$'
    OR NOT app.teacher_signup_text_ok(p_display,40) OR NOT app.teacher_signup_text_ok(p_note,200) THEN
    RETURN jsonb_build_object('outcome','invalid_input');
  END IF;
  SELECT intent_ttl_seconds INTO v_ttl FROM app.teacher_signup_local_config;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','unavailable'); END IF;
  v_hash := sha256(convert_to(lower(p_email),'UTF8'));
  PERFORM pg_advisory_xact_lock(hashtextextended('teacher-signup-op:' || p_operation::text,0));
  SELECT * INTO v_intent FROM app.teacher_signup_intents WHERE operation_key=p_operation FOR UPDATE;
  IF FOUND THEN
    IF v_intent.email_sha256<>v_hash OR v_intent.display_label<>p_display OR v_intent.school_note<>p_note THEN
      RETURN jsonb_build_object('outcome','idempotency_key_reuse');
    END IF;
    IF v_intent.dispatch_state='completed' THEN RETURN jsonb_build_object('outcome','consumed'); END IF;
    IF v_intent.dispatch_state='not_applied' THEN RETURN jsonb_build_object('outcome','existing'); END IF;
    RETURN jsonb_build_object('outcome','in_flight');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('teacher-signup-email:' || encode(v_hash,'hex'),0));
  PERFORM 1 FROM app.teacher_signup_intents WHERE email_sha256=v_hash AND dispatch_state='dispatch_unknown';
  IF FOUND THEN RETURN jsonb_build_object('outcome','in_flight'); END IF;
  SELECT EXISTS (SELECT 1 FROM auth.users WHERE lower(email)=lower(p_email)) INTO v_existing;
  v_id := gen_random_uuid();
  -- COMMIT 成功後呼叫端才取得 created；回應遺失也只允許回看，不再核發派送資格。
  INSERT INTO app.teacher_signup_intents
    (id,operation_key,email_sha256,display_label,school_note,created_at,expires_at,dispatch_state)
    VALUES (v_id,p_operation,v_hash,p_display,p_note,v_now,v_now+make_interval(secs=>v_ttl),
      CASE WHEN v_existing THEN 'not_applied' ELSE 'dispatch_unknown' END);
  IF v_existing THEN RETURN jsonb_build_object('outcome','existing'); END IF;
  RETURN jsonb_build_object('outcome','created','intent',v_id);
END;
$$;

CREATE OR REPLACE FUNCTION app.attach_teacher_signup() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_selector text;
  v_intent app.teacher_signup_intents%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NEW.raw_user_meta_data IS NULL OR jsonb_typeof(NEW.raw_user_meta_data)<>'object'
    OR NOT (NEW.raw_user_meta_data ? 'app_planet_signup_intent') THEN RETURN NULL; END IF;
  v_selector := NEW.raw_user_meta_data ->> 'app_planet_signup_intent';
  IF v_selector IS NULL OR v_selector !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NEW.email IS NULL OR NEW.email_confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'teacher signup intent rejected' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_intent FROM app.teacher_signup_intents WHERE id=v_selector::uuid FOR UPDATE;
  IF NOT FOUND OR v_intent.dispatch_state<>'dispatch_unknown' OR v_intent.consumed_at IS NOT NULL
    OR v_intent.email_sha256<>sha256(convert_to(lower(NEW.email),'UTF8')) THEN
    RAISE EXCEPTION 'teacher signup intent rejected' USING ERRCODE='P0001';
  END IF;
  INSERT INTO app.profiles(id,role,status,deletion_state,school_id,handle,display_label,initiated_by,status_changed_at)
    VALUES (NEW.id,'teacher','pending','none',NULL,NULL,v_intent.display_label,NULL,v_now);
  UPDATE app.teacher_signup_intents SET consumed_at=v_now,account_id=NEW.id,dispatch_state='completed' WHERE id=v_intent.id;
  INSERT INTO app.teacher_applications(account_id,intent_id,school_note,submitted_at)
    VALUES (NEW.id,v_intent.id,v_intent.school_note,v_now);
  RETURN NULL;
END;
$$;

-- Auth INSERT 的首次密碼不受影響；未驗證平台申請不可由公開重複 signup 改密碼。
-- 不新增密碼重設能力，也不限制電郵確認／confirmation token 更新。
CREATE FUNCTION app.guard_teacher_signup_password() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.teacher_signup_intents WHERE account_id=OLD.id
    OR (email_sha256=sha256(convert_to(lower(OLD.email),'UTF8')) AND dispatch_state='dispatch_unknown')) THEN
    RAISE EXCEPTION 'teacher signup credential change rejected' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION app.guard_teacher_signup_password() OWNER TO app_signup_writer;
REVOKE ALL ON FUNCTION app.guard_teacher_signup_password() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER app_planet_teacher_signup_password BEFORE UPDATE OF encrypted_password ON auth.users
  FOR EACH ROW WHEN (OLD.email_confirmed_at IS NULL AND OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password)
  EXECUTE FUNCTION app.guard_teacher_signup_password();

COMMIT;
