-- readiness §92：教師註冊申請→電郵驗證→待審的隔離本機子集（T017 主要子集）。
-- 不是正式部署 migration；未設定 teacher_signup_local_config 時申請入口一律關閉。
-- 平台不保存密碼；申請意圖只保存非秘密內容（電郵 SHA-256、顯示名稱、學校／任教說明）。
-- 外部 Auth 與平台 DB 只在 auth.users INSERT 觸發器內同交易；不承諾跨服務全面原子性。
BEGIN;

CREATE ROLE app_signup_writer NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE app_signup_intake NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA app TO app_signup_writer, app_signup_intake;

CREATE TABLE app.teacher_signup_local_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  intent_ttl_seconds integer NOT NULL CHECK (intent_ttl_seconds BETWEEN 60 AND 86400)
);

-- 顯示名稱與說明是未受信任的使用者內容：限長、單行、拒絕控制與雙向格式字元；不是身分或歸屬證明。
CREATE FUNCTION app.teacher_signup_text_ok(p_value text, p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT p_value IS NOT NULL AND p_value = btrim(p_value)
    AND char_length(p_value) BETWEEN 1 AND p_max
    AND p_value !~ '[[:cntrl:]]'
    AND p_value !~ '[\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]'
$$;
REVOKE ALL ON FUNCTION app.teacher_signup_text_ok(text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.teacher_signup_text_ok(text, integer) TO app_signup_writer, app_staff_reviewer;

CREATE TABLE app.teacher_signup_intents (
  id uuid PRIMARY KEY,
  operation_key uuid NOT NULL UNIQUE,
  email_sha256 bytea NOT NULL CHECK (octet_length(email_sha256) = 32),
  display_label text NOT NULL CHECK (app.teacher_signup_text_ok(display_label, 40)),
  school_note text NOT NULL CHECK (app.teacher_signup_text_ok(school_note, 200)),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  account_id uuid NULL UNIQUE,
  CHECK (expires_at > created_at),
  CHECK ((consumed_at IS NULL) = (account_id IS NULL))
);

CREATE TABLE app.teacher_applications (
  account_id uuid PRIMARY KEY REFERENCES app.profiles (id),
  intent_id uuid NOT NULL UNIQUE REFERENCES app.teacher_signup_intents (id),
  school_note text NOT NULL CHECK (app.teacher_signup_text_ok(school_note, 200)),
  submitted_at timestamptz NOT NULL
);

ALTER TABLE app.teacher_signup_local_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.teacher_signup_local_config FORCE ROW LEVEL SECURITY;
ALTER TABLE app.teacher_signup_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.teacher_signup_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE app.teacher_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.teacher_applications FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.teacher_signup_local_config, app.teacher_signup_intents, app.teacher_applications
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON app.teacher_signup_local_config TO app_signup_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.teacher_signup_intents TO app_signup_writer;
GRANT INSERT ON app.teacher_applications TO app_signup_writer;
GRANT SELECT (account_id, school_note) ON app.teacher_applications TO app_staff_reviewer;
CREATE POLICY signup_config_read ON app.teacher_signup_local_config FOR SELECT TO app_signup_writer USING (true);
CREATE POLICY signup_intent_all ON app.teacher_signup_intents FOR ALL TO app_signup_writer USING (true) WITH CHECK (true);
CREATE POLICY signup_application_insert ON app.teacher_applications FOR INSERT TO app_signup_writer WITH CHECK (true);
CREATE POLICY signup_application_review_read ON app.teacher_applications FOR SELECT TO app_staff_reviewer USING (true);

-- 申請建立的 profile 固定為 teacher／pending／未刪除，且不帶學校、handle 或發起人。
GRANT INSERT (id, role, status, deletion_state, school_id, handle, display_label, initiated_by, status_changed_at)
  ON app.profiles TO app_signup_writer;
CREATE POLICY signup_teacher_pending_insert ON app.profiles FOR INSERT TO app_signup_writer
  WITH CHECK (role = 'teacher' AND status = 'pending' AND deletion_state = 'none'
    AND school_id IS NULL AND handle IS NULL AND initiated_by IS NULL AND row_version = 0);

-- 批准前置：只讀受信任 Auth 的權威電郵驗證時間；不寫 Auth。
GRANT SELECT (id, email_confirmed_at, deleted_at) ON auth.users TO app_staff_reviewer;
CREATE POLICY app_staff_review_auth_read ON auth.users FOR SELECT TO app_staff_reviewer USING (true);
-- 申請意圖只需判斷 email 是否已有 Auth 帳號；不讀密碼、session 或 metadata，不寫 Auth。
GRANT USAGE ON SCHEMA auth TO app_signup_writer;
GRANT SELECT (email) ON auth.users TO app_signup_writer;
CREATE POLICY app_signup_auth_email_read ON auth.users FOR SELECT TO app_signup_writer USING (true);

CREATE FUNCTION app.register_teacher_signup_intent(
  p_operation uuid, p_email text, p_display text, p_note text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_ttl integer;
  v_hash bytea;
  v_intent app.teacher_signup_intents%ROWTYPE;
  v_id uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_operation IS NULL OR p_email IS NULL OR char_length(p_email) > 254
    OR p_email !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$'
    OR NOT app.teacher_signup_text_ok(p_display, 40) OR NOT app.teacher_signup_text_ok(p_note, 200) THEN
    RETURN jsonb_build_object('outcome','invalid_input');
  END IF;
  SELECT intent_ttl_seconds INTO v_ttl FROM app.teacher_signup_local_config;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','unavailable'); END IF;
  v_hash := sha256(convert_to(lower(p_email), 'UTF8'));
  PERFORM pg_advisory_xact_lock(hashtextextended('teacher-signup-op:' || p_operation::text, 0));
  SELECT * INTO v_intent FROM app.teacher_signup_intents WHERE operation_key = p_operation FOR UPDATE;
  IF FOUND THEN
    IF v_intent.email_sha256 <> v_hash OR v_intent.display_label <> p_display OR v_intent.school_note <> p_note THEN
      RETURN jsonb_build_object('outcome','idempotency_key_reuse');
    END IF;
    IF v_intent.consumed_at IS NOT NULL THEN RETURN jsonb_build_object('outcome','consumed'); END IF;
    IF v_intent.expires_at <= v_now THEN RETURN jsonb_build_object('outcome','expired'); END IF;
    RETURN jsonb_build_object('outcome','pending','intent',v_intent.id);
  END IF;
  -- 新操作：同 email 已有 Auth 帳號（不論是否已驗證）時不建立意圖、不呼叫 Auth signup。
  -- 上游對既有未驗證帳號的 signup 會覆寫密碼；平台以此阻止接管，只容許中性重寄。
  PERFORM pg_advisory_xact_lock(hashtextextended('teacher-signup-email:' || encode(v_hash, 'hex'), 0));
  PERFORM 1 FROM auth.users WHERE lower(email) = lower(p_email);
  IF FOUND THEN RETURN jsonb_build_object('outcome','existing'); END IF;
  -- 同 email 另一操作仍在進行（隔離測試值 120 秒）：結果不明，不並行呼叫 Auth。
  PERFORM 1 FROM app.teacher_signup_intents WHERE email_sha256 = v_hash AND consumed_at IS NULL
    AND expires_at > v_now AND created_at > v_now - interval '120 seconds';
  IF FOUND THEN RETURN jsonb_build_object('outcome','in_flight'); END IF;
  -- 過期且未使用的意圖不再有效；清除避免累積非必要內容。
  DELETE FROM app.teacher_signup_intents WHERE consumed_at IS NULL AND expires_at <= v_now;
  v_id := gen_random_uuid();
  INSERT INTO app.teacher_signup_intents(id,operation_key,email_sha256,display_label,school_note,created_at,expires_at)
    VALUES (v_id,p_operation,v_hash,p_display,p_note,v_now,v_now + make_interval(secs => v_ttl));
  RETURN jsonb_build_object('outcome','created','intent',v_id);
END;
$$;
ALTER FUNCTION app.register_teacher_signup_intent(uuid,text,text,text) OWNER TO app_signup_writer;
REVOKE ALL ON FUNCTION app.register_teacher_signup_intent(uuid,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.register_teacher_signup_intent(uuid,text,text,text) TO app_signup_intake;

-- Auth 新使用者列同交易：只有帶著伺服器隨機意圖選擇子、電郵雜湊相符、未過期未使用、且尚未驗證者
-- 才建立固定 teacher／pending profile 與申請。其餘 metadata（role、status、verified、id 等）一律忽略。
-- 未帶選擇子的原生 signup／admin 建立只留下 Auth 帳號，不建立 profile、無平台權限、不進審核清單。
CREATE FUNCTION app.attach_teacher_signup() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_selector text;
  v_intent app.teacher_signup_intents%ROWTYPE;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NEW.raw_user_meta_data IS NULL OR jsonb_typeof(NEW.raw_user_meta_data) <> 'object'
    OR NOT (NEW.raw_user_meta_data ? 'app_planet_signup_intent') THEN
    RETURN NULL;
  END IF;
  v_selector := NEW.raw_user_meta_data ->> 'app_planet_signup_intent';
  IF v_selector IS NULL OR v_selector !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR NEW.email IS NULL OR NEW.email_confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'teacher signup intent rejected' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_intent FROM app.teacher_signup_intents WHERE id = v_selector::uuid FOR UPDATE;
  IF NOT FOUND OR v_intent.consumed_at IS NOT NULL OR v_intent.expires_at <= v_now
    OR v_intent.email_sha256 <> sha256(convert_to(lower(NEW.email), 'UTF8')) THEN
    RAISE EXCEPTION 'teacher signup intent rejected' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO app.profiles(id,role,status,deletion_state,school_id,handle,display_label,initiated_by,status_changed_at)
    VALUES (NEW.id,'teacher','pending','none',NULL,NULL,v_intent.display_label,NULL,v_now);
  UPDATE app.teacher_signup_intents SET consumed_at = v_now, account_id = NEW.id WHERE id = v_intent.id;
  INSERT INTO app.teacher_applications(account_id,intent_id,school_note,submitted_at)
    VALUES (NEW.id,v_intent.id,v_intent.school_note,v_now);
  RETURN NULL;
END;
$$;
ALTER FUNCTION app.attach_teacher_signup() OWNER TO app_signup_writer;
REVOKE ALL ON FUNCTION app.attach_teacher_signup() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER app_planet_teacher_signup AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION app.attach_teacher_signup();

-- GoTrue admin 建立會先 INSERT 未確認列再於同交易直接確認；INSERT 觸發器無法區分。
-- 對已連結申請的帳號，只有曾核發確認 token（經信件驗證流程）時才允許 email_confirmed_at 由空轉為已確認；
-- 直接確認（admin email_confirm=true、未發信即確認）整筆拒絕，不留可批准的半成品。
CREATE FUNCTION app.guard_teacher_signup_confirmation() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.teacher_signup_intents WHERE account_id = NEW.id)
    AND coalesce(OLD.confirmation_token, '') = '' THEN
    RAISE EXCEPTION 'teacher signup confirmation rejected' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION app.guard_teacher_signup_confirmation() OWNER TO app_signup_writer;
REVOKE ALL ON FUNCTION app.guard_teacher_signup_confirmation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER app_planet_teacher_signup_confirmation BEFORE UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION app.guard_teacher_signup_confirmation();

-- §91 清單只列出受信任 Auth 已驗證電郵的待審教師；未驗證申請不具批准資格、不進可審清單。
CREATE OR REPLACE FUNCTION app.list_pending_teachers(p_after uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_rows jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.profiles WHERE id = auth.uid()
    AND role = 'admin' AND status = 'approved' AND deletion_state = 'none') THEN
    RETURN jsonb_build_object('outcome','denied');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.staff_approval_local_config) THEN RETURN jsonb_build_object('outcome','unavailable'); END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.id), '[]'::jsonb) INTO v_rows FROM (
    SELECT p.id, p.display_label, p.status, p.row_version, a.school_note
    FROM app.profiles p
    JOIN auth.users u ON u.id = p.id AND u.email_confirmed_at IS NOT NULL AND u.deleted_at IS NULL
    LEFT JOIN app.teacher_applications a ON a.account_id = p.id
    WHERE p.role = 'teacher' AND p.status = 'pending' AND p.deletion_state = 'none'
      AND (p_after IS NULL OR p.id > p_after) ORDER BY p.id LIMIT 51
  ) item;
  RETURN jsonb_build_object('outcome','listed','items',v_rows);
END;
$$;

CREATE OR REPLACE FUNCTION app.review_pending_teacher(p_target uuid, p_decision text, p_version integer, p_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_profile record;
  v_receipt app.staff_review_receipts%ROWTYPE;
  v_actor_aid uuid;
  v_target_aid uuid;
  v_version integer;
  v_result jsonb;
  v_ttl integer;
BEGIN
  IF p_target IS NULL OR p_key IS NULL OR p_decision IS NULL OR p_decision NOT IN ('approved','rejected')
    OR p_version IS NULL OR p_version < 0 THEN RETURN jsonb_build_object('outcome','invalid_input'); END IF;
  IF v_actor IS NULL THEN RETURN jsonb_build_object('outcome','denied'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-review:' || v_actor::text || ':' || p_key::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('staff-review-target:' || p_target::text,0));
  PERFORM id FROM app.profiles WHERE id IN (v_actor,p_target) ORDER BY id FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM app.profiles WHERE id = v_actor
    AND role = 'admin' AND status = 'approved' AND deletion_state = 'none') OR v_actor = p_target THEN
    RETURN jsonb_build_object('outcome','denied');
  END IF;
  SELECT receipt_ttl_seconds INTO v_ttl FROM app.staff_approval_local_config;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','unavailable'); END IF;
  SELECT * INTO v_receipt FROM app.staff_review_receipts WHERE actor_id = v_actor AND operation_key = p_key;
  IF FOUND AND v_receipt.expires_at > clock_timestamp() THEN
    IF v_receipt.target_id <> p_target OR v_receipt.decision <> p_decision OR v_receipt.expected_version <> p_version THEN
      RETURN jsonb_build_object('outcome','idempotency_key_reuse');
    END IF;
    RETURN jsonb_build_object('outcome','replayed','result',v_receipt.result);
  END IF;
  DELETE FROM app.staff_review_receipts WHERE actor_id = v_actor AND operation_key = p_key;
  SELECT id, role, status, deletion_state, row_version INTO v_profile
    FROM app.profiles WHERE id = p_target FOR UPDATE;
  IF NOT FOUND OR v_profile.role <> 'teacher' OR v_profile.deletion_state <> 'none' THEN
    RETURN jsonb_build_object('outcome','invalid_target');
  END IF;
  IF v_profile.status <> 'pending' OR v_profile.row_version <> p_version THEN
    RETURN jsonb_build_object('outcome','version_conflict');
  END IF;
  -- 伺服器端強制：受信任 Auth 尚未記錄電郵驗證者不具批准／拒絕資格（不只 UI 隱藏）。
  PERFORM 1 FROM auth.users WHERE id = p_target AND email_confirmed_at IS NOT NULL AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_eligible'); END IF;
  UPDATE app.profiles SET status = p_decision::app.account_status WHERE id = p_target
    AND row_version = p_version AND status = 'pending' RETURNING row_version INTO v_version;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','version_conflict'); END IF;
  INSERT INTO app.audit_identity_map(aid,account_id,created_at)
    SELECT gen_random_uuid(), id, clock_timestamp() FROM app.profiles WHERE id IN (v_actor,p_target) ORDER BY id
    ON CONFLICT (account_id) DO NOTHING;
  SELECT aid INTO STRICT v_actor_aid FROM app.audit_identity_map WHERE account_id = v_actor;
  SELECT aid INTO STRICT v_target_aid FROM app.audit_identity_map WHERE account_id = p_target;
  INSERT INTO app.audit_events(id,at,actor_aid,subject_aid,action,object_type,result,meta)
    VALUES (gen_random_uuid(),clock_timestamp(),v_actor_aid,v_target_aid,
      CASE p_decision WHEN 'approved' THEN 'teacher_approved' ELSE 'teacher_rejected' END,'account','ok',
      jsonb_build_object('from_status','pending','to_status',p_decision,'row_version',v_version,'operation_id',p_key));
  v_result := jsonb_build_object('id',p_target,'status',p_decision,'row_version',v_version);
  INSERT INTO app.staff_review_receipts VALUES
    (v_actor,p_key,p_target,p_decision,p_version,v_result,clock_timestamp() + make_interval(secs => v_ttl));
  RETURN jsonb_build_object('outcome','reviewed','result',v_result);
END;
$$;

COMMIT;
