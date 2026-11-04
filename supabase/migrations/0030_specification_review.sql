BEGIN;

-- 僅 Specification 審查證據的失效世代；不是帳號或學校管理服務。
ALTER TABLE app.profiles ADD COLUMN specification_review_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE app.schools ADD COLUMN specification_review_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE app.teacher_student_bindings ADD COLUMN specification_review_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE app.teacher_school_memberships ADD COLUMN specification_review_epoch bigint NOT NULL DEFAULT 0;
CREATE FUNCTION app.bump_specification_review_epoch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE v_new jsonb := to_jsonb(NEW); v_old jsonb := to_jsonb(OLD);
BEGIN
  NEW.specification_review_epoch := OLD.specification_review_epoch;
  IF (CASE TG_TABLE_NAME
    WHEN 'profiles' THEN
      (v_new->'role',v_new->'status',v_new->'deletion_state',v_new->'school_id') IS DISTINCT FROM
      (v_old->'role',v_old->'status',v_old->'deletion_state',v_old->'school_id')
    WHEN 'schools' THEN
      (v_new->'approval_state',v_new->'approval_epoch',v_new->'valid_until') IS DISTINCT FROM
      (v_old->'approval_state',v_old->'approval_epoch',v_old->'valid_until')
    ELSE (v_new - 'specification_review_epoch') IS DISTINCT FROM (v_old - 'specification_review_epoch')
  END) THEN
    NEW.specification_review_epoch := OLD.specification_review_epoch + 1;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION app.bump_specification_review_epoch() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER specification_profile_epoch BEFORE UPDATE ON app.profiles
  FOR EACH ROW EXECUTE FUNCTION app.bump_specification_review_epoch();
CREATE TRIGGER specification_school_epoch BEFORE UPDATE ON app.schools
  FOR EACH ROW EXECUTE FUNCTION app.bump_specification_review_epoch();
CREATE TRIGGER specification_binding_epoch BEFORE UPDATE ON app.teacher_student_bindings
  FOR EACH ROW EXECUTE FUNCTION app.bump_specification_review_epoch();
CREATE TRIGGER specification_membership_epoch BEFORE UPDATE ON app.teacher_school_memberships
  FOR EACH ROW EXECUTE FUNCTION app.bump_specification_review_epoch();

CREATE TABLE app.specification_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id uuid NOT NULL REFERENCES app.projects(id),
  student_id uuid NOT NULL REFERENCES app.profiles(id),
  school_id uuid NOT NULL REFERENCES app.schools(id),
  student_epoch bigint NOT NULL,
  school_epoch bigint NOT NULL,
  draft_version integer NOT NULL CHECK (draft_version >= 0),
  specification jsonb NOT NULL,
  requirements_revision integer NOT NULL,
  classification_id uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key uuid NOT NULL,
  UNIQUE(student_id,idempotency_key),
  FOREIGN KEY(project_id,classification_id,requirements_revision)
    REFERENCES app.project_classification_confirmations(project_id,id,requirements_revision)
);
CREATE INDEX specification_submissions_project_sequence ON app.specification_submissions(project_id,sequence DESC);
CREATE TABLE app.specification_decisions (
  submission_id uuid PRIMARY KEY REFERENCES app.specification_submissions(id),
  teacher_id uuid NOT NULL REFERENCES app.profiles(id),
  teacher_epoch bigint NOT NULL,
  binding_id uuid NOT NULL REFERENCES app.teacher_student_bindings(id),
  binding_epoch bigint NOT NULL,
  membership_id uuid NOT NULL REFERENCES app.teacher_school_memberships(id),
  membership_epoch bigint NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','returned')),
  reason text NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key uuid NOT NULL,
  UNIQUE(teacher_id,idempotency_key),
  CHECK ((decision = 'approved' AND reason IS NULL) OR
    (decision = 'returned' AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 2000
      AND reason !~ '[[:cntrl:]]'))
);
CREATE TRIGGER specification_submission_immutable BEFORE UPDATE ON app.specification_submissions
  FOR EACH ROW EXECUTE FUNCTION app.reject_project_history_mutation();
CREATE TRIGGER specification_decision_immutable BEFORE UPDATE ON app.specification_decisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_project_history_mutation();
ALTER TABLE app.specification_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.specification_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.specification_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.specification_decisions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.specification_submissions,app.specification_decisions FROM PUBLIC,anon,authenticated,service_role;
CREATE ROLE app_specification_reviewer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA app,auth TO app_specification_reviewer;
GRANT EXECUTE ON FUNCTION auth.uid(),app.current_account_gate(text) TO app_specification_reviewer;
GRANT SELECT ON app.profiles,app.schools,app.teacher_student_bindings,app.teacher_school_memberships,
  app.projects,app.stage_records,app.project_requirements,app.project_classification_confirmations
  TO app_specification_reviewer;
-- FOR SHARE requires a column UPDATE grant; there is no exposed UPDATE function or role membership.
GRANT UPDATE(id) ON app.profiles,app.schools,app.teacher_student_bindings,app.teacher_school_memberships,
  app.projects TO app_specification_reviewer;
CREATE POLICY specification_profiles_read ON app.profiles FOR SELECT TO app_specification_reviewer USING(true);
CREATE POLICY specification_schools_read ON app.schools FOR SELECT TO app_specification_reviewer USING(true);
CREATE POLICY specification_bindings_read ON app.teacher_student_bindings FOR SELECT TO app_specification_reviewer USING(true);
CREATE POLICY specification_memberships_read ON app.teacher_school_memberships FOR SELECT TO app_specification_reviewer USING(true);
CREATE POLICY specification_projects_read ON app.projects FOR SELECT TO app_specification_reviewer USING(true);
CREATE POLICY specification_drafts_read ON app.stage_records FOR SELECT TO app_specification_reviewer USING(true);
CREATE POLICY specification_requirements_read ON app.project_requirements FOR SELECT TO app_specification_reviewer USING(true);
CREATE POLICY specification_classification_read ON app.project_classification_confirmations FOR SELECT TO app_specification_reviewer USING(true);
CREATE POLICY specification_profiles_lock ON app.profiles FOR UPDATE TO app_specification_reviewer USING(true) WITH CHECK(false);
CREATE POLICY specification_schools_lock ON app.schools FOR UPDATE TO app_specification_reviewer USING(true) WITH CHECK(false);
CREATE POLICY specification_bindings_lock ON app.teacher_student_bindings FOR UPDATE TO app_specification_reviewer USING(true) WITH CHECK(false);
CREATE POLICY specification_memberships_lock ON app.teacher_school_memberships FOR UPDATE TO app_specification_reviewer USING(true) WITH CHECK(false);
CREATE POLICY specification_projects_lock ON app.projects FOR UPDATE TO app_specification_reviewer USING(true) WITH CHECK(false);
GRANT SELECT,INSERT ON app.specification_submissions,app.specification_decisions TO app_specification_reviewer;
GRANT USAGE ON SEQUENCE app.specification_submissions_sequence_seq TO app_specification_reviewer;
CREATE POLICY specification_submission_read ON app.specification_submissions FOR SELECT TO app_specification_reviewer USING(true);
CREATE POLICY specification_submission_insert ON app.specification_submissions FOR INSERT TO app_specification_reviewer
  WITH CHECK(student_id=auth.uid() AND app.current_account_gate('submit_for_review'));
CREATE POLICY specification_decision_read ON app.specification_decisions FOR SELECT TO app_specification_reviewer USING(true);
CREATE POLICY specification_decision_insert ON app.specification_decisions FOR INSERT TO app_specification_reviewer
  WITH CHECK(teacher_id=auth.uid());

-- Keep the existing audit whitelist, adding only three content-free Specification actions.
ALTER TABLE app.audit_events DROP CONSTRAINT audit_events_staff_shape;
ALTER TABLE app.audit_events ADD CONSTRAINT audit_events_staff_shape CHECK (
  (action = 'teacher_view' AND object_type IN ('project','conversation','file','activity') AND meta='{}'::jsonb)
  OR coalesce((
    action IN ('first_admin_bootstrap','teacher_approved','teacher_rejected')
    AND object_type='account' AND object_ref IS NULL AND school_id IS NULL
    AND subject_aid IS NOT NULL AND result='ok' AND jsonb_typeof(meta)='object'
    AND meta ?& ARRAY['from_status','to_status','row_version','operation_id']
    AND (meta-ARRAY['from_status','to_status','row_version','operation_id'])='{}'::jsonb
    AND meta->>'from_status'='pending'
    AND meta->>'to_status'=CASE WHEN action='teacher_rejected' THEN 'rejected' ELSE 'approved' END
    AND jsonb_typeof(meta->'row_version')='number' AND (meta->>'row_version')~'^[1-9][0-9]*$'
    AND (meta->>'operation_id')~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),false)
  OR (action IN ('specification_submitted','specification_approved','specification_returned')
    AND object_type='project' AND object_ref IS NOT NULL AND subject_aid IS NOT NULL
    AND school_id IS NOT NULL AND result='ok' AND meta='{}'::jsonb)
);
GRANT SELECT,INSERT ON app.audit_identity_map TO app_specification_reviewer;
GRANT INSERT ON app.audit_events TO app_specification_reviewer;
CREATE POLICY specification_aid_read ON app.audit_identity_map FOR SELECT TO app_specification_reviewer USING(true);
CREATE POLICY specification_aid_insert ON app.audit_identity_map FOR INSERT TO app_specification_reviewer WITH CHECK(true);
CREATE POLICY specification_audit_insert ON app.audit_events FOR INSERT TO app_specification_reviewer
  WITH CHECK(action IN ('teacher_view','specification_submitted','specification_approved','specification_returned'));

CREATE FUNCTION app.specification_teacher_binding(p_student uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT b.id FROM app.teacher_student_bindings b
  JOIN app.profiles t ON t.id=b.teacher_id
  JOIN app.profiles s ON s.id=b.student_id
  JOIN app.schools sc ON sc.id=s.school_id
  JOIN app.teacher_school_memberships m ON m.teacher_id=t.id AND m.school_id=sc.id AND m.state='active'
  WHERE t.id=auth.uid() AND t.id<>s.id AND b.student_id=p_student AND b.state='active'
    AND t.role='teacher' AND t.status='approved' AND t.deletion_state='none'
    AND s.role='student' AND s.status='approved' AND s.deletion_state='none'
    AND sc.approval_state='approved' AND (sc.valid_until IS NULL OR sc.valid_until>clock_timestamp())
$$;
CREATE FUNCTION app.specification_submission_current(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(
    SELECT 1 FROM app.specification_submissions sub
    JOIN app.projects p ON p.id=sub.project_id AND p.owner_id=sub.student_id
    JOIN app.profiles s ON s.id=sub.student_id AND s.school_id=sub.school_id
    JOIN app.schools sc ON sc.id=sub.school_id
    JOIN app.stage_records dr ON dr.project_id=p.id AND dr.stage='Specification'
    WHERE sub.id=p_id AND s.role='student' AND s.status='approved' AND s.deletion_state='none'
      AND s.specification_review_epoch=sub.student_epoch AND sc.specification_review_epoch=sub.school_epoch
      AND sc.approval_state='approved' AND (sc.valid_until IS NULL OR sc.valid_until>clock_timestamp())
      AND dr.row_version=sub.draft_version AND dr.content=sub.specification
      AND p.requirements_revision=sub.requirements_revision AND p.current_confirmation_id=sub.classification_id
      AND p.classification_state='confirmed'
      AND NOT EXISTS (
        SELECT 1 FROM app.specification_decisions d
        LEFT JOIN app.profiles t ON t.id=d.teacher_id
        LEFT JOIN app.teacher_student_bindings b ON b.id=d.binding_id
        LEFT JOIN app.teacher_school_memberships m ON m.id=d.membership_id
        WHERE d.submission_id=sub.id AND NOT coalesce(
          t.role='teacher' AND t.status='approved' AND t.deletion_state='none'
          AND t.specification_review_epoch=d.teacher_epoch
          AND b.teacher_id=t.id AND b.student_id=s.id AND b.state='active'
          AND b.specification_review_epoch=d.binding_epoch
          AND m.teacher_id=t.id AND m.school_id=sc.id AND m.state='active'
          AND m.specification_review_epoch=d.membership_epoch,false))
  )
$$;
CREATE FUNCTION app.specification_projection(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object(
    'id',s.id,'project_id',s.project_id,'title',p.title,'draft_version',s.draft_version,
    'requirements_revision',s.requirements_revision,'classification_id',s.classification_id,
    'specification',s.specification,
    'requirements',jsonb_build_object('description',r.description,'runtime_needs',r.runtime_needs,'runtime_ai_required',r.runtime_ai_required),
    'classification',jsonb_build_object('tier',c.tier,'needs_visitor_identity',c.needs_visitor_identity),
    'submitted_at',to_char(s.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'state',CASE WHEN NOT app.specification_submission_current(s.id) THEN 'invalidated'
      ELSE coalesce(d.decision,'pending') END,
    'decision',CASE WHEN d.submission_id IS NULL THEN NULL ELSE jsonb_build_object(
      'decision',d.decision,'reason',d.reason,
      'decided_at',to_char(d.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) END)
  FROM app.specification_submissions s JOIN app.projects p ON p.id=s.project_id
  JOIN app.project_requirements r ON r.project_id=s.project_id AND r.revision=s.requirements_revision
  JOIN app.project_classification_confirmations c ON c.project_id=s.project_id AND c.id=s.classification_id
  LEFT JOIN app.specification_decisions d ON d.submission_id=s.id WHERE s.id=p_id
$$;
CREATE FUNCTION app.specification_audit(p_student uuid,p_project uuid,p_school uuid,p_action text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v_actor uuid; v_subject uuid;
BEGIN
  INSERT INTO app.audit_identity_map(aid,account_id,created_at)
    SELECT gen_random_uuid(),id,clock_timestamp() FROM app.profiles
    WHERE id IN (auth.uid(),p_student) ORDER BY id ON CONFLICT(account_id) DO NOTHING;
  SELECT aid INTO STRICT v_actor FROM app.audit_identity_map WHERE account_id=auth.uid();
  SELECT aid INTO STRICT v_subject FROM app.audit_identity_map WHERE account_id=p_student;
  INSERT INTO app.audit_events(id,at,actor_aid,subject_aid,action,object_type,object_ref,school_id,result,meta)
    VALUES(gen_random_uuid(),clock_timestamp(),v_actor,v_subject,p_action,'project',p_project,p_school,'ok','{}');
END; $$;

CREATE FUNCTION app.submit_specification(p_project uuid,p_draft integer,p_revision integer,p_classification uuid,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p app.projects%ROWTYPE; s app.profiles%ROWTYPE; sc app.schools%ROWTYPE;
  dr app.stage_records%ROWTYPE; old app.specification_submissions%ROWTYPE; v_id uuid;
BEGIN
  IF p_project IS NULL OR p_draft IS NULL OR p_draft<0 OR p_revision IS NULL OR p_revision<1
    OR p_classification IS NULL OR p_key IS NULL THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  IF NOT app.current_account_gate('submit_for_review') THEN RETURN '{"outcome":"denied"}'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.projects WHERE id=p_project AND owner_id=auth.uid())
    THEN RETURN '{"outcome":"not_found"}'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('specification-submit:'||auth.uid()::text||':'||p_key::text,0));
  SELECT * INTO s FROM app.profiles WHERE id=auth.uid() FOR SHARE;
  SELECT * INTO sc FROM app.schools WHERE id=s.school_id FOR SHARE;
  SELECT * INTO p FROM app.projects WHERE id=p_project FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project::text||':Specification',0));
  IF NOT app.current_account_gate('submit_for_review') OR p.owner_id IS DISTINCT FROM auth.uid()
    OR sc.approval_state<>'approved' OR (sc.valid_until IS NOT NULL AND sc.valid_until<=clock_timestamp())
    THEN RETURN '{"outcome":"denied"}'; END IF;
  SELECT * INTO old FROM app.specification_submissions WHERE student_id=auth.uid() AND idempotency_key=p_key;
  IF FOUND THEN
    IF (old.project_id,old.draft_version,old.requirements_revision,old.classification_id)
      IS DISTINCT FROM (p_project,p_draft,p_revision,p_classification)
      THEN RETURN '{"outcome":"idempotency_conflict"}'; END IF;
    RETURN jsonb_build_object('outcome','replayed','submission_id',old.id);
  END IF;
  SELECT * INTO dr FROM app.stage_records WHERE project_id=p_project AND stage='Specification';
  IF NOT FOUND OR p.current_confirmation_id IS NULL OR p.requirements_revision=0
    THEN RETURN '{"outcome":"evidence_missing"}'; END IF;
  IF (dr.row_version,p.requirements_revision,p.current_confirmation_id) IS DISTINCT FROM
    (p_draft,p_revision,p_classification) THEN RETURN '{"outcome":"version_conflict"}'; END IF;
  SELECT * INTO old FROM app.specification_submissions WHERE project_id=p_project ORDER BY sequence DESC LIMIT 1;
  IF FOUND AND app.specification_submission_current(old.id) AND NOT EXISTS(
    SELECT 1 FROM app.specification_decisions WHERE submission_id=old.id AND decision='returned')
    THEN RETURN '{"outcome":"version_conflict"}'; END IF;
  INSERT INTO app.specification_submissions(project_id,student_id,school_id,student_epoch,school_epoch,
    draft_version,specification,requirements_revision,classification_id,idempotency_key)
    VALUES(p_project,auth.uid(),s.school_id,s.specification_review_epoch,sc.specification_review_epoch,
      dr.row_version,dr.content,p.requirements_revision,p.current_confirmation_id,p_key) RETURNING id INTO v_id;
  PERFORM app.specification_audit(auth.uid(),p_project,s.school_id,'specification_submitted');
  RETURN jsonb_build_object('outcome','submitted','submission_id',v_id);
END; $$;

CREATE FUNCTION app.decide_specification(p_submission uuid,p_decision text,p_reason text,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sub app.specification_submissions%ROWTYPE; b app.teacher_student_bindings%ROWTYPE;
  m app.teacher_school_memberships%ROWTYPE; t app.profiles%ROWTYPE;
  old app.specification_decisions%ROWTYPE;
BEGIN
  IF p_submission IS NULL OR p_key IS NULL OR p_decision IS NULL OR p_decision NOT IN ('approved','returned')
    OR (p_decision='approved' AND p_reason IS NOT NULL)
    OR (p_decision='returned' AND (p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000
      OR p_reason~'[[:cntrl:]]')) THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  SELECT * INTO sub FROM app.specification_submissions WHERE id=p_submission;
  IF NOT FOUND OR app.specification_teacher_binding(sub.student_id) IS NULL
    THEN RETURN '{"outcome":"not_found"}'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('specification-decision:'||auth.uid()::text||':'||p_key::text,0));
  PERFORM id FROM app.profiles WHERE id IN (auth.uid(),sub.student_id) ORDER BY id FOR SHARE;
  PERFORM id FROM app.schools WHERE id=sub.school_id FOR SHARE;
  SELECT * INTO t FROM app.profiles WHERE id=auth.uid();
  SELECT * INTO m FROM app.teacher_school_memberships
    WHERE teacher_id=auth.uid() AND school_id=sub.school_id AND state='active' FOR SHARE;
  SELECT * INTO b FROM app.teacher_student_bindings
    WHERE teacher_id=auth.uid() AND student_id=sub.student_id AND state='active' FOR SHARE;
  PERFORM id FROM app.projects WHERE id=sub.project_id FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended(sub.project_id::text||':Specification',0));
  IF app.specification_teacher_binding(sub.student_id) IS DISTINCT FROM b.id OR b.id IS NULL OR m.id IS NULL
    THEN RETURN '{"outcome":"not_found"}'; END IF;
  SELECT * INTO old FROM app.specification_decisions WHERE teacher_id=auth.uid() AND idempotency_key=p_key;
  IF FOUND THEN
    IF (old.submission_id,old.decision,old.reason) IS DISTINCT FROM (p_submission,p_decision,p_reason)
      THEN RETURN '{"outcome":"idempotency_conflict"}'; END IF;
    RETURN jsonb_build_object('outcome','replayed','submission_id',old.submission_id);
  END IF;
  IF NOT app.specification_submission_current(p_submission) OR EXISTS(
    SELECT 1 FROM app.specification_decisions WHERE submission_id=p_submission)
    THEN RETURN '{"outcome":"version_conflict"}'; END IF;
  INSERT INTO app.specification_decisions(submission_id,teacher_id,teacher_epoch,binding_id,binding_epoch,
    membership_id,membership_epoch,decision,reason,idempotency_key)
    VALUES(p_submission,auth.uid(),t.specification_review_epoch,b.id,b.specification_review_epoch,
      m.id,m.specification_review_epoch,p_decision,p_reason,p_key);
  PERFORM app.specification_audit(sub.student_id,sub.project_id,sub.school_id,
    CASE WHEN p_decision='approved' THEN 'specification_approved' ELSE 'specification_returned' END);
  RETURN jsonb_build_object('outcome','decided','submission_id',p_submission);
END; $$;

CREATE FUNCTION app.read_specification_status(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p app.projects%ROWTYPE; sub uuid;
BEGIN
  IF NOT app.current_account_gate('read_saved_content') THEN RETURN '{"outcome":"denied"}'; END IF;
  SELECT * INTO p FROM app.projects WHERE id=p_project AND owner_id=auth.uid();
  IF NOT FOUND THEN RETURN '{"outcome":"not_found"}'; END IF;
  SELECT id INTO sub FROM app.specification_submissions WHERE project_id=p_project ORDER BY sequence DESC LIMIT 1;
  RETURN jsonb_build_object('outcome','found','project_id',p_project,
    'evidence',jsonb_build_object(
      'draft_version',(SELECT row_version FROM app.stage_records WHERE project_id=p_project AND stage='Specification'),
      'requirements_revision',p.requirements_revision,'classification_id',p.current_confirmation_id),
    'latest',app.specification_projection(sub));
END; $$;
CREATE FUNCTION app.list_specification_reviews(p_after bigint,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_items jsonb; v_next text;
BEGIN
  IF p_after IS NULL OR p_after<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
    THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app.profiles WHERE id=auth.uid() AND role='teacher'
    AND status='approved' AND deletion_state='none') THEN RETURN '{"outcome":"denied"}'; END IF;
  WITH visible AS MATERIALIZED (
    SELECT s.id,s.sequence,s.project_id,p.title,s.draft_version,s.submitted_at
    FROM app.specification_submissions s JOIN app.projects p ON p.id=s.project_id
    WHERE s.sequence>p_after AND app.specification_teacher_binding(s.student_id) IS NOT NULL
      AND app.specification_submission_current(s.id)
      AND NOT EXISTS(SELECT 1 FROM app.specification_decisions d WHERE d.submission_id=s.id)
    ORDER BY s.sequence LIMIT p_limit+1
  ), page AS (SELECT * FROM visible ORDER BY sequence LIMIT p_limit)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'project_id',project_id,'title',title,
    'draft_version',draft_version,'submitted_at',to_char(submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    ORDER BY sequence),'[]'::jsonb),
    CASE WHEN (SELECT count(*) FROM visible)>p_limit THEN max(sequence)::text ELSE NULL END
  INTO v_items,v_next FROM page;
  RETURN jsonb_build_object('outcome','found','items',v_items,'next_cursor',v_next);
END; $$;
CREATE FUNCTION app.read_specification_review(p_submission uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sub app.specification_submissions%ROWTYPE; v_result jsonb;
BEGIN
  SELECT * INTO sub FROM app.specification_submissions WHERE id=p_submission;
  IF NOT FOUND OR app.specification_teacher_binding(sub.student_id) IS NULL
    THEN RETURN '{"outcome":"not_found"}'; END IF;
  PERFORM id FROM app.profiles WHERE id IN (auth.uid(),sub.student_id) ORDER BY id FOR SHARE;
  PERFORM id FROM app.schools WHERE id=sub.school_id FOR SHARE;
  PERFORM id FROM app.teacher_school_memberships WHERE teacher_id=auth.uid() AND school_id=sub.school_id AND state='active' FOR SHARE;
  PERFORM id FROM app.teacher_student_bindings WHERE teacher_id=auth.uid() AND student_id=sub.student_id AND state='active' FOR SHARE;
  IF app.specification_teacher_binding(sub.student_id) IS NULL THEN RETURN '{"outcome":"not_found"}'; END IF;
  v_result := app.specification_projection(p_submission);
  PERFORM app.specification_audit(sub.student_id,sub.project_id,sub.school_id,'teacher_view');
  RETURN jsonb_build_object('outcome','found','submission',v_result);
END; $$;

-- No runtime actor may assume the writer role or call its internal helpers.
GRANT CREATE ON SCHEMA app TO app_specification_reviewer;
GRANT app_specification_reviewer TO supabase_admin WITH ADMIN FALSE,INHERIT FALSE,SET TRUE;
ALTER FUNCTION app.specification_teacher_binding(uuid) OWNER TO app_specification_reviewer;
ALTER FUNCTION app.specification_submission_current(uuid) OWNER TO app_specification_reviewer;
ALTER FUNCTION app.specification_projection(uuid) OWNER TO app_specification_reviewer;
ALTER FUNCTION app.specification_audit(uuid,uuid,uuid,text) OWNER TO app_specification_reviewer;
ALTER FUNCTION app.submit_specification(uuid,integer,integer,uuid,uuid) OWNER TO app_specification_reviewer;
ALTER FUNCTION app.decide_specification(uuid,text,text,uuid) OWNER TO app_specification_reviewer;
ALTER FUNCTION app.read_specification_status(uuid) OWNER TO app_specification_reviewer;
ALTER FUNCTION app.list_specification_reviews(bigint,integer) OWNER TO app_specification_reviewer;
ALTER FUNCTION app.read_specification_review(uuid) OWNER TO app_specification_reviewer;
REVOKE app_specification_reviewer FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_specification_reviewer;
REVOKE ALL ON FUNCTION app.specification_teacher_binding(uuid),app.specification_submission_current(uuid),
  app.specification_projection(uuid),app.specification_audit(uuid,uuid,uuid,text),
  app.submit_specification(uuid,integer,integer,uuid,uuid),app.decide_specification(uuid,text,text,uuid),
  app.read_specification_status(uuid),app.list_specification_reviews(bigint,integer),app.read_specification_review(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.submit_specification(uuid,integer,integer,uuid,uuid),
  app.decide_specification(uuid,text,text,uuid),app.read_specification_status(uuid),
  app.list_specification_reviews(bigint,integer),app.read_specification_review(uuid) TO authenticated;
COMMIT;
