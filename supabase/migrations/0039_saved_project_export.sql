BEGIN;

CREATE ROLE app_saved_project_export_reader
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA app, auth TO app_saved_project_export_reader;
GRANT EXECUTE ON FUNCTION auth.uid(), app.current_account_gate(text) TO app_saved_project_export_reader;
GRANT SELECT (id, role, school_id), UPDATE (id) ON app.profiles TO app_saved_project_export_reader;
GRANT SELECT (id), UPDATE (id) ON app.schools TO app_saved_project_export_reader;
GRANT SELECT (id, owner_id, title, stage, row_version, classification_state, requested_tier,
  tier, needs_visitor_identity, requirements_revision, current_confirmation_id)
  ON app.projects TO app_saved_project_export_reader;
GRANT UPDATE (id) ON app.projects TO app_saved_project_export_reader;
GRANT SELECT (project_id, revision, description, runtime_needs, runtime_ai_required)
  ON app.project_requirements TO app_saved_project_export_reader;
GRANT SELECT (id, project_id, requirements_revision, requirements_description,
  requirements_runtime_needs, requirements_runtime_ai_required, requested_tier_at_confirmation,
  requested_tier_acknowledgement, tier, needs_visitor_identity, confirmed_by, confirmed_at, source)
  ON app.project_classification_confirmations TO app_saved_project_export_reader;
GRANT SELECT (project_id, stage, row_version, state, content_source, content)
  ON app.stage_records TO app_saved_project_export_reader;
GRANT SELECT (project_id, stage, record_row_version, content_hash, confirmed_by, confirmed_at, source)
  ON app.stage_draft_confirmations TO app_saved_project_export_reader;
GRANT SELECT (id, project_id, "order", title, done, row_version) ON app.tasks TO app_saved_project_export_reader;

CREATE POLICY saved_export_profile_read ON app.profiles FOR SELECT TO app_saved_project_export_reader
  USING (id = auth.uid());
CREATE POLICY saved_export_profile_lock ON app.profiles FOR UPDATE TO app_saved_project_export_reader
  USING (id = auth.uid()) WITH CHECK (false);
CREATE POLICY saved_export_school_read ON app.schools FOR SELECT TO app_saved_project_export_reader
  USING (EXISTS (SELECT 1 FROM app.profiles p WHERE p.id = auth.uid() AND p.school_id = schools.id));
CREATE POLICY saved_export_school_lock ON app.schools FOR UPDATE TO app_saved_project_export_reader
  USING (EXISTS (SELECT 1 FROM app.profiles p WHERE p.id = auth.uid() AND p.school_id = schools.id))
  WITH CHECK (false);
CREATE POLICY saved_export_project_read ON app.projects FOR SELECT TO app_saved_project_export_reader
  USING (owner_id = auth.uid() AND app.current_account_gate('download_own_results'));
CREATE POLICY saved_export_project_lock ON app.projects FOR UPDATE TO app_saved_project_export_reader
  USING (owner_id = auth.uid() AND app.current_account_gate('download_own_results')) WITH CHECK (false);
CREATE POLICY saved_export_requirements_read ON app.project_requirements FOR SELECT TO app_saved_project_export_reader
  USING (app.current_account_gate('download_own_results') AND EXISTS (
    SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid()));
CREATE POLICY saved_export_classification_read ON app.project_classification_confirmations FOR SELECT TO app_saved_project_export_reader
  USING (app.current_account_gate('download_own_results') AND EXISTS (
    SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid()));
CREATE POLICY saved_export_draft_read ON app.stage_records FOR SELECT TO app_saved_project_export_reader
  USING (app.current_account_gate('download_own_results') AND EXISTS (
    SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid()));
CREATE POLICY saved_export_confirmation_read ON app.stage_draft_confirmations FOR SELECT TO app_saved_project_export_reader
  USING (confirmed_by = auth.uid() AND app.current_account_gate('download_own_results') AND EXISTS (
    SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid()));
CREATE POLICY saved_export_task_read ON app.tasks FOR SELECT TO app_saved_project_export_reader
  USING (app.current_account_gate('download_own_results') AND EXISTS (
    SELECT 1 FROM app.projects p WHERE p.id = project_id AND p.owner_id = auth.uid()));

-- READ WRITE is needed only for row locks. This role cannot change any row.
CREATE FUNCTION app.read_saved_project_export(p_project uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_subject uuid := auth.uid();
  v_role text;
  v_school uuid;
  v_project uuid;
  v_result jsonb;
BEGIN
  IF p_project IS NULL THEN RETURN '{"outcome":"invalid_input"}'; END IF;
  IF v_subject IS NULL THEN RETURN '{"outcome":"denied"}'; END IF;

  -- Same profile -> school order as the existing protected operations.
  SELECT p.role, p.school_id INTO v_role, v_school
    FROM app.profiles p WHERE p.id = v_subject FOR SHARE;
  IF NOT FOUND THEN RETURN '{"outcome":"denied"}'; END IF;
  IF v_role <> 'student' THEN RETURN '{"outcome":"not_found"}'; END IF;
  PERFORM s.id FROM app.schools s WHERE s.id = v_school FOR SHARE;
  IF NOT FOUND OR NOT app.current_account_gate('download_own_results') THEN
    RETURN '{"outcome":"denied"}';
  END IF;
  SELECT p.id INTO v_project FROM app.projects p
    WHERE p.id = p_project AND p.owner_id = v_subject FOR SHARE;
  IF NOT FOUND THEN RETURN '{"outcome":"not_found"}'; END IF;

  -- After waiting for eligibility locks, this VOLATILE function obtains a fresh
  -- READ COMMITTED statement snapshot for every exported resource and validity.
  WITH current_project AS MATERIALIZED (
    SELECT p.id, p.owner_id, p.title, p.stage, p.row_version, p.classification_state,
      p.requested_tier, p.tier, p.needs_visitor_identity, p.requirements_revision,
      r.revision AS saved_revision, r.description, r.runtime_needs, r.runtime_ai_required,
      c.id AS confirmation_id, c.requirements_revision AS confirmation_revision,
      c.confirmed_at, c.source,
      (c.project_id = p.id AND c.requirements_revision = p.requirements_revision
        AND c.confirmed_by = p.owner_id AND c.source = 'student_explicit_confirmation'
        AND convert_to(c.requirements_description, 'UTF8') = convert_to(r.description, 'UTF8')
        AND c.requirements_runtime_needs = r.runtime_needs
        AND c.requirements_runtime_ai_required = r.runtime_ai_required
        AND c.tier = p.tier AND c.needs_visitor_identity = p.needs_visitor_identity
        AND c.requested_tier_at_confirmation IS NOT DISTINCT FROM p.requested_tier
        AND c.requested_tier_acknowledgement = CASE
          WHEN p.requested_tier IS NULL THEN 'no_preference'
          WHEN p.requested_tier = p.tier THEN 'matches' ELSE 'explicit_change' END) AS classification_current
    FROM app.projects p
    LEFT JOIN app.project_requirements r ON r.project_id = p.id AND r.revision = p.requirements_revision
    LEFT JOIN app.project_classification_confirmations c
      ON c.project_id = p.id AND c.id = p.current_confirmation_id
    WHERE p.id = p_project AND p.owner_id = v_subject
      AND app.current_account_gate('download_own_results')
  ), budget AS MATERIALIZED (
    SELECT p.*,
      (4096::bigint + octet_length(to_jsonb(p.title)::text)
        + COALESCE(octet_length(to_jsonb(p.description)::text), 0)
        + COALESCE((SELECT sum(octet_length(d.content::text)::bigint + 2048)
          FROM app.stage_records d WHERE d.project_id = p.id), 0)
        + COALESCE((SELECT sum(octet_length(to_jsonb(t.title)::text)::bigint + 512)
          FROM app.tasks t WHERE t.project_id = p.id), 0)) AS assembly_bytes
    FROM current_project p
  )
  SELECT CASE WHEN b.requirements_revision > 0 AND b.saved_revision IS NULL THEN '{"outcome":"invalid_result"}'::jsonb
    WHEN b.assembly_bytes > 8388608 THEN '{"outcome":"too_large"}'::jsonb
    ELSE jsonb_build_object('outcome', 'found', 'data', jsonb_build_object(
      'project', jsonb_build_object('id', b.id, 'title', b.title, 'stage', b.stage, 'row_version', b.row_version),
      'requirements', CASE WHEN b.saved_revision IS NULL THEN NULL ELSE jsonb_build_object(
        'revision', b.saved_revision, 'content', jsonb_build_object(
          'description', b.description, 'runtime_needs', b.runtime_needs, 'runtime_ai_required', b.runtime_ai_required)) END,
      'classification', jsonb_build_object(
        'classification_state', b.classification_state, 'requested_tier', b.requested_tier,
        'tier', b.tier, 'needs_visitor_identity', b.needs_visitor_identity,
        'confirmation', CASE WHEN b.confirmation_id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', b.confirmation_id, 'requirements_revision', b.confirmation_revision,
          'confirmed_at', to_char(b.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'source', b.source) END,
        'confirmation_validity', CASE b.classification_state
          WHEN 'unconfirmed' THEN 'not_confirmed' WHEN 'legacy_unverified' THEN 'legacy_unverified'
          ELSE CASE WHEN b.classification_current THEN 'valid' ELSE 'stale' END END),
      'stages', (SELECT jsonb_agg(jsonb_build_object(
        'stage', s.stage,
        'draft', CASE WHEN d.project_id IS NULL THEN NULL ELSE jsonb_build_object(
          'row_version', d.row_version, 'state', d.state, 'content_source', d.content_source, 'content', d.content) END,
        'confirmation', CASE WHEN c.project_id IS NULL THEN NULL ELSE jsonb_build_object(
          'row_version', c.record_row_version,
          'confirmed_at', to_char(c.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'source', c.source,
          'current', d.row_version = c.record_row_version
            AND c.content_hash = encode(sha256(convert_to(d.content->>'text', 'UTF8')), 'hex')) END
        ) ORDER BY s.ordinality)
        FROM unnest(ARRAY['點子','A/B','Specification','Checkpoint','Constitution',
          'UX/UI','Specification Sync','Technical Plan','Final Pack']::text[]) WITH ORDINALITY AS s(stage, ordinality)
        LEFT JOIN app.stage_records d ON d.project_id = b.id AND d.stage = s.stage
        LEFT JOIN LATERAL (
          SELECT c.project_id, c.record_row_version, c.content_hash, c.confirmed_at, c.source
          FROM app.stage_draft_confirmations c
          WHERE c.project_id = b.id AND c.stage = s.stage AND c.confirmed_by = v_subject
          ORDER BY c.record_row_version DESC LIMIT 1
        ) c ON true),
      'tasks', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', t.id, 'project_id', t.project_id, 'order', t."order", 'title', t.title,
        'done', t.done, 'row_version', t.row_version) ORDER BY t."order", t.id), '[]'::jsonb)
        FROM app.tasks t WHERE t.project_id = b.id),
      'read_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    )) END INTO v_result FROM budget b;

  RETURN COALESCE(v_result, '{"outcome":"not_found"}'::jsonb);
END;
$function$;
ALTER FUNCTION app.read_saved_project_export(uuid) OWNER TO app_saved_project_export_reader;
REVOKE ALL ON FUNCTION app.read_saved_project_export(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION app.read_saved_project_export(uuid) TO authenticated;
COMMIT;
