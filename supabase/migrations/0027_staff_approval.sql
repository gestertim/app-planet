BEGIN;

ALTER TABLE app.profiles ADD COLUMN row_version integer NOT NULL DEFAULT 0 CHECK (row_version >= 0);

CREATE FUNCTION app.advance_profile_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.row_version = 2147483647 THEN RAISE EXCEPTION 'profile_version_exhausted'; END IF;
  NEW.row_version := OLD.row_version + 1;
  IF NEW.status IS DISTINCT FROM OLD.status THEN NEW.status_changed_at := clock_timestamp(); END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.advance_profile_version() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER profiles_version BEFORE UPDATE ON app.profiles
FOR EACH ROW EXECUTE FUNCTION app.advance_profile_version();

CREATE ROLE app_staff_reviewer NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE app_bootstrap_writer NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE app_bootstrap_executor NOLOGIN NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA app, auth TO app_staff_reviewer, app_bootstrap_writer, app_bootstrap_executor;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_staff_reviewer;

-- 空設定表示關閉；只由隔離 setup 設定，不是正式 PP 或產品可寫設定。
CREATE TABLE app.staff_approval_local_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  isolation_id uuid NOT NULL,
  receipt_ttl_seconds integer NOT NULL CHECK (receipt_ttl_seconds BETWEEN 86400 AND 604800)
);
CREATE TABLE app.first_admin_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  target_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  completed_at timestamptz NOT NULL
);
CREATE TABLE app.staff_review_receipts (
  actor_id uuid NOT NULL,
  operation_key uuid NOT NULL,
  target_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  result jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, operation_key)
);
ALTER TABLE app.staff_approval_local_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.staff_approval_local_config FORCE ROW LEVEL SECURITY;
ALTER TABLE app.first_admin_bootstrap ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.first_admin_bootstrap FORCE ROW LEVEL SECURITY;
ALTER TABLE app.staff_review_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.staff_review_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.staff_approval_local_config, app.first_admin_bootstrap, app.staff_review_receipts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON app.staff_approval_local_config TO app_staff_reviewer, app_bootstrap_writer;
GRANT SELECT, INSERT ON app.first_admin_bootstrap TO app_bootstrap_writer;
GRANT SELECT, INSERT, DELETE ON app.staff_review_receipts TO app_staff_reviewer;
CREATE POLICY staff_config_read ON app.staff_approval_local_config FOR SELECT
  TO app_staff_reviewer, app_bootstrap_writer USING (true);
CREATE POLICY bootstrap_record_read ON app.first_admin_bootstrap FOR SELECT TO app_bootstrap_writer USING (true);
CREATE POLICY bootstrap_record_insert ON app.first_admin_bootstrap FOR INSERT TO app_bootstrap_writer WITH CHECK (true);
CREATE POLICY review_receipt_read ON app.staff_review_receipts FOR SELECT TO app_staff_reviewer USING (actor_id = auth.uid());
CREATE POLICY review_receipt_insert ON app.staff_review_receipts FOR INSERT TO app_staff_reviewer WITH CHECK (actor_id = auth.uid());
CREATE POLICY review_receipt_expire ON app.staff_review_receipts FOR DELETE TO app_staff_reviewer USING (actor_id = auth.uid());

GRANT SELECT (id, role, status, deletion_state, display_label, row_version)
  ON app.profiles TO app_staff_reviewer, app_bootstrap_writer;
GRANT UPDATE (status, status_changed_at) ON app.profiles TO app_staff_reviewer;
GRANT UPDATE (role, status, status_changed_at) ON app.profiles TO app_bootstrap_writer;
CREATE POLICY staff_writer_read ON app.profiles FOR SELECT TO app_staff_reviewer, app_bootstrap_writer USING (true);
CREATE POLICY staff_reviewer_update ON app.profiles FOR UPDATE TO app_staff_reviewer
  USING (true)
  WITH CHECK (role = 'teacher' AND status IN ('approved', 'rejected') AND deletion_state = 'none');
CREATE POLICY bootstrap_writer_update ON app.profiles FOR UPDATE TO app_bootstrap_writer
  USING (role = 'teacher' AND status = 'pending' AND deletion_state = 'none')
  WITH CHECK (role = 'admin' AND status = 'approved' AND deletion_state = 'none');
GRANT SELECT (id, deleted_at) ON auth.users TO app_bootstrap_writer;
GRANT UPDATE (id) ON auth.users TO app_bootstrap_writer;
-- 原生 Auth 表有 RLS；只允許具名 bootstrap 持有未刪除列的 share lock，不允許寫入 Auth。
CREATE POLICY app_bootstrap_auth_read ON auth.users FOR SELECT TO app_bootstrap_writer
  USING (deleted_at IS NULL);
CREATE POLICY app_bootstrap_auth_lock ON auth.users FOR UPDATE TO app_bootstrap_writer
  USING (deleted_at IS NULL) WITH CHECK (false);

ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_object_type_check;
ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_meta_check;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_staff_shape CHECK (
  (action = 'teacher_view' AND object_type IN ('project', 'conversation', 'file', 'activity') AND meta = '{}'::jsonb)
  OR coalesce((
    action IN ('first_admin_bootstrap', 'teacher_approved', 'teacher_rejected')
    AND object_type = 'account' AND object_ref IS NULL AND school_id IS NULL
    AND subject_aid IS NOT NULL AND result = 'ok'
    AND jsonb_typeof(meta) = 'object'
    AND meta ?& ARRAY['from_status','to_status','row_version','operation_id']
    AND (meta - ARRAY['from_status','to_status','row_version','operation_id']) = '{}'::jsonb
    AND meta->>'from_status' = 'pending'
    AND meta->>'to_status' = CASE WHEN action = 'teacher_rejected' THEN 'rejected' ELSE 'approved' END
    AND jsonb_typeof(meta->'row_version') = 'number'
    AND (meta->>'row_version') ~ '^[1-9][0-9]*$'
    AND (meta->>'operation_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), false)
);
GRANT SELECT, INSERT ON app.audit_identity_map TO app_staff_reviewer, app_bootstrap_writer;
GRANT INSERT ON app.audit_events TO app_staff_reviewer, app_bootstrap_writer;
CREATE POLICY staff_identity_read ON app.audit_identity_map FOR SELECT TO app_staff_reviewer, app_bootstrap_writer USING (true);
CREATE POLICY staff_identity_insert ON app.audit_identity_map FOR INSERT TO app_staff_reviewer, app_bootstrap_writer WITH CHECK (true);
CREATE POLICY staff_audit_append ON app.audit_events FOR INSERT TO app_staff_reviewer, app_bootstrap_writer
  WITH CHECK (action IN ('first_admin_bootstrap', 'teacher_approved', 'teacher_rejected'));

CREATE FUNCTION app.bootstrap_first_admin(p_target uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_record app.first_admin_bootstrap%ROWTYPE;
  v_profile record;
  v_aid uuid;
  v_operation uuid := gen_random_uuid();
  v_version integer;
BEGIN
  IF p_target IS NULL OR NOT EXISTS (
    SELECT 1 FROM app.staff_approval_local_config
    WHERE isolation_id::text = current_setting('app.bootstrap_isolation_id', true)
  ) THEN RETURN jsonb_build_object('outcome','unavailable'); END IF;
  PERFORM pg_advisory_xact_lock(27001, 1);
  SELECT * INTO v_record FROM app.first_admin_bootstrap;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', CASE WHEN v_record.target_id = p_target THEN 'already_completed' ELSE 'consumed' END);
  END IF;
  IF EXISTS (SELECT 1 FROM app.profiles WHERE role = 'admin') THEN
    RETURN jsonb_build_object('outcome','existing_admin');
  END IF;
  -- Auth 身分與 profile 在同交易鎖定；不讀 email、密碼或 token。
  PERFORM 1 FROM auth.users WHERE id = p_target AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','invalid_target'); END IF;
  SELECT id, role, status, deletion_state INTO v_profile FROM app.profiles WHERE id = p_target FOR UPDATE;
  IF NOT FOUND OR v_profile.role <> 'teacher' OR v_profile.status <> 'pending'
    OR v_profile.deletion_state <> 'none' THEN
    RETURN jsonb_build_object('outcome','invalid_target');
  END IF;
  UPDATE app.profiles SET role = 'admin', status = 'approved' WHERE id = p_target RETURNING row_version INTO v_version;
  INSERT INTO app.audit_identity_map(aid,account_id,created_at)
    VALUES (gen_random_uuid(),p_target,clock_timestamp()) ON CONFLICT (account_id) DO NOTHING;
  SELECT aid INTO STRICT v_aid FROM app.audit_identity_map WHERE account_id = p_target;
  INSERT INTO app.audit_events(id,at,actor_aid,subject_aid,action,object_type,result,meta)
    VALUES (gen_random_uuid(),clock_timestamp(),v_aid,v_aid,'first_admin_bootstrap','account','ok',
      jsonb_build_object('from_status','pending','to_status','approved','row_version',v_version,'operation_id',v_operation));
  INSERT INTO app.first_admin_bootstrap VALUES (true,p_target,v_operation,clock_timestamp());
  RETURN jsonb_build_object('outcome','completed');
END;
$$;
ALTER FUNCTION app.bootstrap_first_admin(uuid) OWNER TO app_bootstrap_writer;
REVOKE ALL ON FUNCTION app.bootstrap_first_admin(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.bootstrap_first_admin(uuid) TO app_bootstrap_executor;

CREATE FUNCTION app.list_pending_teachers(p_after uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_rows jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.profiles WHERE id = auth.uid()
    AND role = 'admin' AND status = 'approved' AND deletion_state = 'none') THEN
    RETURN jsonb_build_object('outcome','denied');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.staff_approval_local_config) THEN RETURN jsonb_build_object('outcome','unavailable'); END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.id), '[]'::jsonb) INTO v_rows FROM (
    SELECT id, display_label, status, row_version FROM app.profiles
    WHERE role = 'teacher' AND status = 'pending' AND deletion_state = 'none'
      AND (p_after IS NULL OR id > p_after) ORDER BY id LIMIT 51
  ) item;
  RETURN jsonb_build_object('outcome','listed','items',v_rows);
END;
$$;
ALTER FUNCTION app.list_pending_teachers(uuid) OWNER TO app_staff_reviewer;
REVOKE ALL ON FUNCTION app.list_pending_teachers(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.list_pending_teachers(uuid) TO authenticated;

CREATE FUNCTION app.review_pending_teacher(p_target uuid, p_decision text, p_version integer, p_key uuid)
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
  -- 所有審核先以 UUID 一致順序鎖 profile；FOR SHARE 阻止操作者在提交前失權，也不要求對 admin 的 UPDATE policy。
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
ALTER FUNCTION app.review_pending_teacher(uuid,text,integer,uuid) OWNER TO app_staff_reviewer;
REVOKE ALL ON FUNCTION app.review_pending_teacher(uuid,text,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.review_pending_teacher(uuid,text,integer,uuid) TO authenticated;

COMMIT;
