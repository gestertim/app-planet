-- Teacher resource reads stay isolated from the earlier binding lifecycle migration.
BEGIN;

CREATE ROLE app_teacher_resource_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA app, auth TO app_teacher_resource_reader;
GRANT USAGE ON TYPE app.account_role, app.account_status, app.deletion_state,
  app.school_approval_state, app.binding_state, app.audit_result TO app_teacher_resource_reader;
GRANT EXECUTE ON FUNCTION auth.uid(), app.teacher_can_view_student(uuid) TO app_teacher_resource_reader;
GRANT EXECUTE ON FUNCTION app.specification_teacher_binding(uuid), app.specification_submission_current(uuid)
  TO app_teacher_resource_reader;

GRANT SELECT (id, role, status, deletion_state, school_id, specification_review_epoch)
  ON app.profiles TO app_teacher_resource_reader;
GRANT SELECT (id, approval_state, valid_until) ON app.schools TO app_teacher_resource_reader;
GRANT SELECT (id, teacher_id, school_id, state, specification_review_epoch)
  ON app.teacher_school_memberships TO app_teacher_resource_reader;
GRANT SELECT (id, teacher_id, student_id, state, specification_review_epoch)
  ON app.teacher_student_bindings TO app_teacher_resource_reader;
GRANT UPDATE (id) ON app.profiles, app.schools, app.teacher_school_memberships,
  app.teacher_student_bindings, app.projects TO app_teacher_resource_reader;
GRANT SELECT (id, owner_id, title, stage, row_version, created_at, classification_state, requested_tier,
  tier, needs_visitor_identity, requirements_revision, current_confirmation_id)
  ON app.projects TO app_teacher_resource_reader;
GRANT SELECT (project_id, revision, description, runtime_needs, runtime_ai_required)
  ON app.project_requirements TO app_teacher_resource_reader;
GRANT SELECT (id, project_id, requirements_revision, tier, needs_visitor_identity, confirmed_at, source,
  requested_tier_acknowledgement)
  ON app.project_classification_confirmations TO app_teacher_resource_reader;
GRANT SELECT (project_id, stage, content, row_version, state, content_source)
  ON app.stage_records TO app_teacher_resource_reader;
GRANT SELECT (project_id, stage, record_row_version, content_hash, confirmed_at)
  ON app.stage_draft_confirmations TO app_teacher_resource_reader;
GRANT SELECT (id, project_id, "order", title, done, row_version) ON app.tasks TO app_teacher_resource_reader;
GRANT SELECT (id, project_id, sequence, student_id, school_id, student_epoch, school_epoch, draft_version,
  specification, requirements_revision, classification_id)
  ON app.specification_submissions TO app_teacher_resource_reader;
GRANT SELECT (submission_id, teacher_id, teacher_epoch, binding_id, binding_epoch, membership_id,
  membership_epoch, decision) ON app.specification_decisions TO app_teacher_resource_reader;
GRANT SELECT, INSERT ON app.audit_identity_map TO app_teacher_resource_reader;
GRANT INSERT ON app.audit_events TO app_teacher_resource_reader;

CREATE POLICY teacher_resource_profiles_read ON app.profiles
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_schools_read ON app.schools
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_memberships_read ON app.teacher_school_memberships
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_bindings_read ON app.teacher_student_bindings
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_profiles_lock ON app.profiles
  FOR UPDATE TO app_teacher_resource_reader USING (true) WITH CHECK (false);
CREATE POLICY teacher_resource_schools_lock ON app.schools
  FOR UPDATE TO app_teacher_resource_reader USING (true) WITH CHECK (false);
CREATE POLICY teacher_resource_memberships_lock ON app.teacher_school_memberships
  FOR UPDATE TO app_teacher_resource_reader USING (true) WITH CHECK (false);
CREATE POLICY teacher_resource_bindings_lock ON app.teacher_student_bindings
  FOR UPDATE TO app_teacher_resource_reader USING (true) WITH CHECK (false);
CREATE POLICY teacher_resource_projects_read ON app.projects
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_projects_lock ON app.projects
  FOR UPDATE TO app_teacher_resource_reader USING (true) WITH CHECK (false);
CREATE POLICY teacher_resource_requirements_read ON app.project_requirements
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_classifications_read ON app.project_classification_confirmations
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_stage_records_read ON app.stage_records
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_stage_confirmations_read ON app.stage_draft_confirmations
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_tasks_read ON app.tasks
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_submissions_read ON app.specification_submissions
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_decisions_read ON app.specification_decisions
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_aid_read ON app.audit_identity_map
  FOR SELECT TO app_teacher_resource_reader USING (true);
CREATE POLICY teacher_resource_aid_insert ON app.audit_identity_map
  FOR INSERT TO app_teacher_resource_reader WITH CHECK (true);
CREATE POLICY teacher_resource_audit_insert ON app.audit_events
  FOR INSERT TO app_teacher_resource_reader WITH CHECK (action = 'teacher_view');

CREATE FUNCTION app.teacher_resource_eligible(p_student uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
  SELECT auth.uid() IS NOT NULL
    AND p_student IS NOT NULL
    AND app.teacher_can_view_student(p_student)
    AND EXISTS (
      SELECT 1
      FROM app.profiles teacher
      JOIN app.teacher_student_bindings binding
        ON binding.teacher_id = teacher.id AND binding.student_id = p_student AND binding.state = 'active'
      JOIN app.profiles student
        ON student.id = binding.student_id AND student.role = 'student'
          AND student.status = 'approved' AND student.deletion_state = 'none'
      JOIN app.schools school
        ON school.id = student.school_id AND school.approval_state = 'approved'
          AND (school.valid_until IS NULL OR school.valid_until > clock_timestamp())
      JOIN app.teacher_school_memberships membership
        ON membership.teacher_id = teacher.id AND membership.school_id = school.id
          AND membership.state = 'active'
      WHERE teacher.id = auth.uid() AND teacher.role = 'teacher'
        AND teacher.status = 'approved' AND teacher.deletion_state = 'none'
    )
$function$;

CREATE FUNCTION app.lock_teacher_student_resource(p_student uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_teacher uuid := auth.uid();
  v_school uuid;
BEGIN
  IF v_teacher IS NULL OR p_student IS NULL THEN RETURN NULL; END IF;
  PERFORM id FROM app.profiles WHERE id IN (v_teacher, p_student) ORDER BY id FOR SHARE;
  SELECT school_id INTO v_school FROM app.profiles WHERE id = p_student;
  IF v_school IS NULL THEN RETURN NULL; END IF;
  PERFORM id FROM app.schools WHERE id = v_school FOR SHARE;
  PERFORM id FROM app.teacher_school_memberships
    WHERE teacher_id = v_teacher AND school_id = v_school AND state = 'active'
    ORDER BY id FOR SHARE;
  PERFORM id FROM app.teacher_student_bindings
    WHERE teacher_id = v_teacher AND student_id = p_student AND state = 'active'
    ORDER BY id FOR SHARE;
  IF app.teacher_resource_eligible(p_student) THEN RETURN v_school; END IF;
  RETURN NULL;
END
$function$;

CREATE FUNCTION app.teacher_resource_audit(p_student uuid, p_school uuid, p_project uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_actor_aid uuid;
  v_subject_aid uuid;
BEGIN
  INSERT INTO app.audit_identity_map (aid, account_id, created_at)
    SELECT gen_random_uuid(), id, clock_timestamp()
    FROM app.profiles WHERE id IN (auth.uid(), p_student) ORDER BY id
    ON CONFLICT (account_id) DO NOTHING;
  SELECT aid INTO STRICT v_actor_aid FROM app.audit_identity_map WHERE account_id = auth.uid();
  SELECT aid INTO STRICT v_subject_aid FROM app.audit_identity_map WHERE account_id = p_student;
  INSERT INTO app.audit_events
    (id, at, actor_aid, subject_aid, action, object_type, object_ref, school_id, result, meta)
  VALUES
    (gen_random_uuid(), clock_timestamp(), v_actor_aid, v_subject_aid, 'teacher_view',
      'project', p_project, p_school, 'ok', '{}'::jsonb);
END
$function$;

CREATE FUNCTION app.teacher_task_page(p_project uuid, p_after uuid, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_after_order integer;
  v_items jsonb;
  v_next uuid;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  IF p_after IS NOT NULL THEN
    SELECT "order" INTO v_after_order FROM app.tasks WHERE id = p_after AND project_id = p_project;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'invalid_input'); END IF;
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT id, title, done, row_version, "order"
    FROM app.tasks
    WHERE project_id = p_project
      AND (p_after IS NULL OR ("order", id) > (v_after_order, p_after))
    ORDER BY "order", id
    LIMIT p_limit + 1
  ), page AS (
    SELECT id, title, done, row_version, "order"
    FROM candidates ORDER BY "order", id LIMIT p_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'title', title, 'done', done, 'row_version', row_version
    ) ORDER BY "order", id), '[]'::jsonb),
    CASE WHEN (SELECT count(*) FROM candidates) > p_limit
      THEN (SELECT id FROM page ORDER BY "order" DESC, id DESC LIMIT 1) END
  INTO v_items, v_next FROM page;
  RETURN jsonb_build_object('items', v_items, 'next_cursor', v_next);
END
$function$;

CREATE FUNCTION app.read_teacher_students(p_after uuid, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_candidates uuid[];
  v_student uuid;
  v_school uuid;
  v_items jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_last uuid;
  v_scanned uuid;
  v_extra boolean := false;
  v_next uuid;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.profiles WHERE id = auth.uid() AND role = 'teacher'
    AND status = 'approved' AND deletion_state = 'none') THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  SELECT array_agg(candidate.id ORDER BY candidate.id) INTO v_candidates
  FROM (
    SELECT student.id
    FROM app.profiles student
    WHERE student.role = 'student' AND student.status = 'approved'
      AND student.deletion_state = 'none' AND (p_after IS NULL OR student.id > p_after)
      AND app.teacher_resource_eligible(student.id)
    ORDER BY student.id LIMIT p_limit + 1
  ) candidate;
  FOREACH v_student IN ARRAY coalesce(v_candidates, ARRAY[]::uuid[]) LOOP
    v_scanned := v_student;
    v_school := app.lock_teacher_student_resource(v_student);
    IF v_school IS NOT NULL THEN
      IF v_count = p_limit THEN
        v_extra := true;
        EXIT;
      END IF;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_student, 'display_label', '學生-' || left(v_student::text, 8)
      ));
      v_count := v_count + 1;
      v_last := v_student;
    END IF;
  END LOOP;
  IF v_extra THEN
    v_next := v_last;
  ELSIF coalesce(array_length(v_candidates, 1), 0) > p_limit THEN
    v_next := v_scanned;
  END IF;
  FOR v_student IN SELECT (item->>'id')::uuid FROM jsonb_array_elements(v_items) item LOOP
    IF NOT app.teacher_resource_eligible(v_student) THEN
      RETURN jsonb_build_object('outcome', 'not_found');
    END IF;
  END LOOP;
  RETURN jsonb_build_object('outcome', 'found', 'items', v_items, 'next_cursor', v_next);
END
$function$;

CREATE FUNCTION app.read_teacher_student_projects(
  p_student uuid, p_after uuid, p_limit integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_school uuid;
  v_items jsonb;
  v_next uuid;
  v_project uuid;
BEGIN
  IF p_student IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  v_school := app.lock_teacher_student_resource(p_student);
  IF v_school IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  WITH candidates AS MATERIALIZED (
    SELECT id, title, stage, classification_state
    FROM app.projects
    WHERE owner_id = p_student AND (p_after IS NULL OR id > p_after)
    ORDER BY id LIMIT p_limit + 1
  ), page AS (
    SELECT id, title, stage, classification_state FROM candidates ORDER BY id LIMIT p_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'title', title, 'stage', stage, 'classification_state', classification_state
    ) ORDER BY id), '[]'::jsonb),
    CASE WHEN (SELECT count(*) FROM candidates) > p_limit
      THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END
  INTO v_items, v_next FROM page;
  IF NOT app.teacher_resource_eligible(p_student) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  FOR v_project IN SELECT (item->>'id')::uuid FROM jsonb_array_elements(v_items) item LOOP
    PERFORM app.teacher_resource_audit(p_student, v_school, v_project);
  END LOOP;
  RETURN jsonb_build_object('outcome', 'found', 'items', v_items, 'next_cursor', v_next);
END
$function$;

CREATE FUNCTION app.read_teacher_project(p_student uuid, p_project uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_school uuid;
  v_project_id uuid;
  v_project_title text;
  v_project_stage text;
  v_project_row_version integer;
  v_project_created_at timestamptz;
  v_classification_state text;
  v_requested_tier text;
  v_tier text;
  v_needs_visitor_identity boolean;
  v_requirements_revision integer;
  v_current_confirmation_id uuid;
  v_requirements jsonb;
  v_classification jsonb;
  v_stages jsonb;
  v_tasks jsonb;
  v_review text := 'not_submitted';
  v_submission uuid;
  v_decision text;
BEGIN
  IF p_student IS NULL OR p_project IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  v_school := app.lock_teacher_student_resource(p_student);
  IF v_school IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  SELECT id, title, stage, row_version, created_at, classification_state, requested_tier, tier,
      needs_visitor_identity, requirements_revision, current_confirmation_id
    INTO v_project_id, v_project_title, v_project_stage, v_project_row_version, v_project_created_at,
      v_classification_state, v_requested_tier, v_tier, v_needs_visitor_identity,
      v_requirements_revision, v_current_confirmation_id
    FROM app.projects WHERE id = p_project AND owner_id = p_student FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;

  SELECT jsonb_build_object(
    'revision', revision,
    'content', jsonb_build_object(
      'description', description, 'runtime_needs', runtime_needs,
      'runtime_ai_required', runtime_ai_required
    )
  ) INTO v_requirements
  FROM app.project_requirements
  WHERE project_id = p_project AND revision = v_requirements_revision;

  IF v_classification_state = 'confirmed' THEN
    SELECT jsonb_build_object(
      'state', 'confirmed', 'requested_tier', v_requested_tier,
      'tier', v_tier, 'needs_visitor_identity', v_needs_visitor_identity,
      'confirmation', jsonb_build_object(
        'id', c.id, 'requirements_revision', c.requirements_revision,
        'confirmed_at', to_char(c.confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'source', c.source, 'requested_tier_acknowledgement', c.requested_tier_acknowledgement
      )
    ) INTO v_classification
    FROM app.project_classification_confirmations c
    WHERE c.project_id = p_project AND c.id = v_current_confirmation_id;
  ELSIF v_classification_state = 'legacy_unverified' THEN
    v_classification := jsonb_build_object(
      'state', 'legacy_unverified', 'requested_tier', NULL, 'tier', v_tier,
      'needs_visitor_identity', v_needs_visitor_identity, 'confirmation', NULL
    );
  ELSE
    v_classification := jsonb_build_object(
      'state', 'unconfirmed', 'requested_tier', v_requested_tier,
      'tier', NULL, 'needs_visitor_identity', NULL, 'confirmation', NULL
    );
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'stage', stage_name,
    'saved', draft.project_id IS NOT NULL,
    'row_version', draft.row_version,
    'student_confirmation', CASE
      WHEN draft.project_id IS NULL THEN 'not_applicable'
      WHEN confirmation.project_id IS NULL THEN 'not_confirmed'
      WHEN confirmation.record_row_version = draft.row_version
        AND confirmation.content_hash = encode(sha256(convert_to(draft.content->>'text','UTF8')), 'hex')
        THEN 'current'
      ELSE 'stale'
    END,
    'confirmed_at', CASE WHEN confirmation.project_id IS NULL THEN NULL
      ELSE to_char(confirmation.confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
  ) ORDER BY stage_order), '[]'::jsonb)
  INTO v_stages
  FROM unnest(ARRAY['點子','A/B','Specification','Checkpoint','Constitution',
    'UX/UI','Specification Sync','Technical Plan','Final Pack']::text[])
    WITH ORDINALITY AS stages(stage_name, stage_order)
  LEFT JOIN app.stage_records draft ON draft.project_id = p_project AND draft.stage = stage_name
  LEFT JOIN LATERAL (
    SELECT confirm.project_id, confirm.record_row_version, confirm.content_hash, confirm.confirmed_at
    FROM app.stage_draft_confirmations confirm
    WHERE confirm.project_id = p_project AND confirm.stage = stage_name
    ORDER BY confirm.record_row_version DESC LIMIT 1
  ) confirmation ON true;

  SELECT id INTO v_submission FROM app.specification_submissions
    WHERE project_id = p_project ORDER BY sequence DESC LIMIT 1;
  IF v_submission IS NOT NULL THEN
    IF NOT app.specification_submission_current(v_submission) THEN
      v_review := 'invalidated';
    ELSE
      SELECT decision INTO v_decision FROM app.specification_decisions WHERE submission_id = v_submission;
      v_review := coalesce(v_decision, 'pending');
    END IF;
  END IF;

  v_tasks := app.teacher_task_page(p_project, NULL, 20);
  IF v_requirements IS NOT NULL AND jsonb_typeof(v_requirements) <> 'object'
    OR v_classification IS NULL OR jsonb_array_length(v_stages) <> 9
    OR v_tasks->>'outcome' = 'invalid_input' THEN
    RAISE EXCEPTION 'teacher project projection inconsistent';
  END IF;
  IF NOT app.teacher_resource_eligible(p_student) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  PERFORM app.teacher_resource_audit(p_student, v_school, p_project);
  RETURN jsonb_build_object(
    'outcome', 'found',
    'project', jsonb_build_object(
      'id', v_project_id, 'title', v_project_title, 'stage', v_project_stage,
      'row_version', v_project_row_version,
      'created_at', to_char(v_project_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ),
    'classification', v_classification,
    'requirements', v_requirements,
    'stages', v_stages,
    'specification_review', v_review,
    'tasks', v_tasks
  );
END
$function$;

CREATE FUNCTION app.read_teacher_stage_draft(p_student uuid, p_project uuid, p_stage text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_school uuid;
  v_saved boolean := false;
  v_version integer;
  v_content jsonb;
  v_confirmation jsonb;
  v_confirmed_at timestamptz;
  v_confirmation_state text := 'not_applicable';
BEGIN
  IF p_student IS NULL OR p_project IS NULL OR p_stage IS NULL OR p_stage NOT IN
    ('點子','A/B','Specification','Checkpoint','Constitution','UX/UI','Specification Sync','Technical Plan','Final Pack') THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  v_school := app.lock_teacher_student_resource(p_student);
  IF v_school IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  PERFORM id FROM app.projects WHERE id = p_project AND owner_id = p_student FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;

  SELECT draft.row_version, draft.content INTO v_version, v_content
  FROM app.stage_records draft
  WHERE draft.project_id = p_project AND draft.stage = p_stage;
  IF FOUND THEN
    v_saved := true;
    SELECT jsonb_build_object(
      'row_version', confirmation.record_row_version,
      'content_hash', confirmation.content_hash,
      'confirmed_at', confirmation.confirmed_at
    ), confirmation.confirmed_at
    INTO v_confirmation, v_confirmed_at
    FROM app.stage_draft_confirmations confirmation
    WHERE confirmation.project_id = p_project AND confirmation.stage = p_stage
    ORDER BY confirmation.record_row_version DESC LIMIT 1;
    IF v_confirmation IS NULL THEN
      v_confirmation_state := 'not_confirmed';
    ELSIF (v_confirmation->>'row_version')::integer = v_version
      AND v_confirmation->>'content_hash' = encode(sha256(convert_to(v_content->>'text','UTF8')), 'hex') THEN
      v_confirmation_state := 'current';
    ELSE
      v_confirmation_state := 'stale';
    END IF;
  END IF;
  IF NOT app.teacher_resource_eligible(p_student) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  PERFORM app.teacher_resource_audit(p_student, v_school, p_project);
  RETURN jsonb_build_object(
    'outcome', 'found', 'project_id', p_project, 'stage', p_stage,
    'saved', v_saved, 'row_version', v_version, 'content', v_content,
    'student_confirmation', v_confirmation_state,
    'confirmed_at', CASE WHEN v_confirmed_at IS NULL THEN NULL
      ELSE to_char(v_confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
  );
END
$function$;

CREATE FUNCTION app.read_teacher_project_tasks(
  p_student uuid, p_project uuid, p_after uuid, p_limit integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_school uuid;
  v_page jsonb;
BEGIN
  IF p_student IS NULL OR p_project IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  v_school := app.lock_teacher_student_resource(p_student);
  IF v_school IS NULL THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  PERFORM id FROM app.projects WHERE id = p_project AND owner_id = p_student FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  v_page := app.teacher_task_page(p_project, p_after, p_limit);
  IF v_page->>'outcome' = 'invalid_input' THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  IF NOT app.teacher_resource_eligible(p_student) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  PERFORM app.teacher_resource_audit(p_student, v_school, p_project);
  RETURN jsonb_build_object('outcome', 'found', 'tasks', v_page);
END
$function$;

GRANT CREATE ON SCHEMA app TO app_teacher_resource_reader;
GRANT app_teacher_resource_reader TO supabase_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
ALTER FUNCTION app.teacher_resource_eligible(uuid) OWNER TO app_teacher_resource_reader;
ALTER FUNCTION app.lock_teacher_student_resource(uuid) OWNER TO app_teacher_resource_reader;
ALTER FUNCTION app.teacher_resource_audit(uuid,uuid,uuid) OWNER TO app_teacher_resource_reader;
ALTER FUNCTION app.teacher_task_page(uuid,uuid,integer) OWNER TO app_teacher_resource_reader;
ALTER FUNCTION app.read_teacher_students(uuid,integer) OWNER TO app_teacher_resource_reader;
ALTER FUNCTION app.read_teacher_student_projects(uuid,uuid,integer) OWNER TO app_teacher_resource_reader;
ALTER FUNCTION app.read_teacher_project(uuid,uuid) OWNER TO app_teacher_resource_reader;
ALTER FUNCTION app.read_teacher_stage_draft(uuid,uuid,text) OWNER TO app_teacher_resource_reader;
ALTER FUNCTION app.read_teacher_project_tasks(uuid,uuid,uuid,integer) OWNER TO app_teacher_resource_reader;
REVOKE app_teacher_resource_reader FROM supabase_admin;
REVOKE CREATE ON SCHEMA app FROM app_teacher_resource_reader;
REVOKE ALL ON FUNCTION app.teacher_resource_eligible(uuid), app.lock_teacher_student_resource(uuid),
  app.teacher_resource_audit(uuid,uuid,uuid), app.teacher_task_page(uuid,uuid,integer),
  app.read_teacher_students(uuid,integer), app.read_teacher_student_projects(uuid,uuid,integer),
  app.read_teacher_project(uuid,uuid), app.read_teacher_stage_draft(uuid,uuid,text),
  app.read_teacher_project_tasks(uuid,uuid,uuid,integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.read_teacher_students(uuid,integer),
  app.read_teacher_student_projects(uuid,uuid,integer), app.read_teacher_project(uuid,uuid),
  app.read_teacher_stage_draft(uuid,uuid,text), app.read_teacher_project_tasks(uuid,uuid,uuid,integer)
  TO authenticated;

COMMIT;
