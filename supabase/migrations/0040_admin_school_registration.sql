BEGIN;

CREATE ROLE app_school_manager NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA app,auth TO app_school_manager;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_school_manager;
GRANT SELECT(id,role,status,deletion_state),UPDATE(id) ON app.profiles TO app_school_manager;
CREATE POLICY school_manager_profiles_read ON app.profiles FOR SELECT TO app_school_manager USING(true);
CREATE POLICY school_manager_profiles_lock ON app.profiles FOR UPDATE TO app_school_manager
  USING(true) WITH CHECK(false);
GRANT SELECT(id,label,approval_state,approval_epoch,valid_until,current_doc_version),
  INSERT(id,label,approval_state,approval_epoch,valid_until,current_doc_version,created_at,updated_at)
  ON app.schools TO app_school_manager;
CREATE POLICY school_manager_read ON app.schools FOR SELECT TO app_school_manager USING(true);
CREATE POLICY school_manager_register ON app.schools FOR INSERT TO app_school_manager
  WITH CHECK(approval_state='unconfirmed' AND approval_epoch=0
    AND valid_until IS NULL AND current_doc_version IS NULL);

CREATE TABLE app.school_registration_receipts (
  actor_id uuid NOT NULL REFERENCES app.profiles(id),
  operation_key uuid NOT NULL,
  intent jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(actor_id,operation_key)
);
ALTER TABLE app.school_registration_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.school_registration_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.school_registration_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON app.school_registration_receipts TO app_school_manager;
CREATE POLICY school_receipt_read ON app.school_registration_receipts FOR SELECT TO app_school_manager
  USING(actor_id=auth.uid());
CREATE POLICY school_receipt_insert ON app.school_registration_receipts FOR INSERT TO app_school_manager
  WITH CHECK(actor_id=auth.uid());
GRANT SELECT,INSERT ON app.audit_identity_map TO app_school_manager;
GRANT INSERT ON app.audit_events TO app_school_manager;
CREATE POLICY school_aid_read ON app.audit_identity_map FOR SELECT TO app_school_manager USING(account_id=auth.uid());
CREATE POLICY school_aid_insert ON app.audit_identity_map FOR INSERT TO app_school_manager
  WITH CHECK(account_id=auth.uid());
CREATE POLICY school_audit_insert ON app.audit_events FOR INSERT TO app_school_manager
  WITH CHECK(action IN ('school_registered','school_registration_denied'));
DO $$
DECLARE prior text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT prior FROM pg_constraint
    WHERE conrelid='app.audit_events'::regclass AND conname='audit_events_staff_shape';
  ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_staff_shape;
  EXECUTE 'ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_staff_shape CHECK (('||prior||') OR coalesce((
    object_type=''school'' AND subject_aid IS NULL AND meta=''{}''::jsonb
    AND ((action=''school_registered'' AND result=''ok'' AND object_ref IS NOT NULL AND school_id=object_ref)
      OR (action=''school_registration_denied'' AND result=''denied'' AND object_ref IS NULL AND school_id IS NULL))
  ),false))';
END; $$;

CREATE FUNCTION app.school_registration_audit(p_school uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor uuid;
BEGIN
  INSERT INTO app.audit_identity_map(aid,account_id,created_at)
    VALUES(gen_random_uuid(),auth.uid(),clock_timestamp()) ON CONFLICT(account_id) DO NOTHING;
  SELECT aid INTO STRICT actor FROM app.audit_identity_map WHERE account_id=auth.uid();
  INSERT INTO app.audit_events(id,at,actor_aid,action,object_type,object_ref,school_id,result,meta)
    VALUES(gen_random_uuid(),clock_timestamp(),actor,
      CASE WHEN p_school IS NULL THEN 'school_registration_denied' ELSE 'school_registered' END,
      'school',p_school,p_school,CASE WHEN p_school IS NULL THEN 'denied' ELSE 'ok' END::app.audit_result,'{}');
END; $$;

CREATE FUNCTION app.school_admin_lock() RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
BEGIN
  PERFORM id FROM app.profiles WHERE id=auth.uid() FOR SHARE;
  RETURN EXISTS(SELECT 1 FROM app.profiles WHERE id=auth.uid()
    AND role='admin' AND status='approved' AND deletion_state='none');
END; $$;

CREATE FUNCTION app.register_school(p_label text,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old app.school_registration_receipts%ROWTYPE;
  intent jsonb:=jsonb_build_object('scope','school_registration','label',p_label);
  school uuid; at timestamptz; result jsonb;
BEGIN
  -- key 鎖後才取得資格鎖，replay 與等待期間失權均重驗；鎖保留至 COMMIT。
  IF p_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('school-registration:'||auth.uid()::text||':'||p_key::text,0));
  END IF;
  IF NOT app.school_admin_lock() THEN
    IF EXISTS(SELECT 1 FROM app.profiles WHERE id=auth.uid()) THEN
      PERFORM app.school_registration_audit(NULL);
    END IF;
    RETURN '{"outcome":"denied"}';
  END IF;
  IF p_key IS NULL OR p_label IS NULL OR
    btrim(p_label,E' \t\n\r\f\013'||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||
      chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||
      chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))='' THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;
  SELECT * INTO old FROM app.school_registration_receipts WHERE actor_id=auth.uid() AND operation_key=p_key;
  IF FOUND THEN
    IF old.intent IS DISTINCT FROM intent THEN RETURN '{"outcome":"idempotency_conflict"}'; END IF;
    RETURN old.result||'{"outcome":"replayed"}'::jsonb;
  END IF;
  school:=gen_random_uuid(); at:=clock_timestamp();
  INSERT INTO app.schools(id,label,approval_state,approval_epoch,valid_until,current_doc_version,created_at,updated_at)
    VALUES(school,p_label,'unconfirmed',0,NULL,NULL,at,at);
  PERFORM app.school_registration_audit(school);
  result:=jsonb_build_object('outcome','created','operation','create','school_id',school,'label',p_label,
    'approval_state','unconfirmed','approval_epoch',0,'valid_until',NULL,'current_doc_version',NULL,
    'operated_at',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  INSERT INTO app.school_registration_receipts VALUES(auth.uid(),p_key,intent,result);
  RETURN result;
END; $$;

CREATE FUNCTION app.list_admin_schools(p_after uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE items jsonb; cursor uuid;
BEGIN
  IF NOT app.school_admin_lock() THEN RETURN '{"outcome":"denied"}'; END IF;
  WITH candidates AS MATERIALIZED (
    SELECT id,jsonb_build_object('id',id,'label',label,'approval_state',approval_state,'approval_epoch',approval_epoch,
      'valid_until',to_char(valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) item
    FROM app.schools WHERE p_after IS NULL OR id>p_after ORDER BY id LIMIT 21
  ), page AS (SELECT * FROM candidates ORDER BY id LIMIT 20)
  SELECT coalesce(jsonb_agg(item ORDER BY id),'[]'::jsonb),
    CASE WHEN (SELECT count(*) FROM candidates)>20 THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END
    INTO items,cursor FROM page;
  RETURN jsonb_build_object('outcome','found','items',items,'next_cursor',cursor);
END; $$;

CREATE FUNCTION app.read_admin_school(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE school jsonb;
BEGIN
  IF NOT app.school_admin_lock() THEN RETURN '{"outcome":"denied"}'; END IF;
  SELECT jsonb_build_object('id',id,'label',label,'approval_state',approval_state,'approval_epoch',approval_epoch,
    'valid_until',to_char(valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'current_doc_version',current_doc_version,'verification_history','not_available','last_change',NULL)
    INTO school FROM app.schools WHERE id=p_id;
  IF NOT FOUND THEN RETURN '{"outcome":"not_found"}'; END IF;
  RETURN jsonb_build_object('outcome','found','school',school);
END; $$;

GRANT CREATE ON SCHEMA app TO app_school_manager;
GRANT app_school_manager TO supabase_admin WITH ADMIN FALSE,INHERIT FALSE,SET TRUE;
ALTER FUNCTION app.school_registration_audit(uuid) OWNER TO app_school_manager;
ALTER FUNCTION app.school_admin_lock() OWNER TO app_school_manager;
ALTER FUNCTION app.register_school(text,uuid) OWNER TO app_school_manager;
ALTER FUNCTION app.list_admin_schools(uuid) OWNER TO app_school_manager;
ALTER FUNCTION app.read_admin_school(uuid) OWNER TO app_school_manager;
REVOKE app_school_manager FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_school_manager;
REVOKE ALL ON FUNCTION app.school_registration_audit(uuid),app.school_admin_lock(),
  app.register_school(text,uuid),app.list_admin_schools(uuid),app.read_admin_school(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.register_school(text,uuid),app.list_admin_schools(uuid),app.read_admin_school(uuid)
  TO authenticated;
COMMIT;
