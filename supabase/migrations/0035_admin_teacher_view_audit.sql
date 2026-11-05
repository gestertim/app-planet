BEGIN;

CREATE ROLE app_teacher_view_audit_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA app, auth TO app_teacher_view_audit_reader;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_teacher_view_audit_reader;
GRANT SELECT (id, role, status, deletion_state, display_label), UPDATE (id)
  ON app.profiles TO app_teacher_view_audit_reader;
GRANT SELECT (aid, account_id) ON app.audit_identity_map TO app_teacher_view_audit_reader;
GRANT SELECT (id, at, actor_aid, subject_aid, action) ON app.audit_events TO app_teacher_view_audit_reader;
CREATE POLICY teacher_view_admin_profiles_read ON app.profiles
  FOR SELECT TO app_teacher_view_audit_reader USING (true);
CREATE POLICY teacher_view_admin_profiles_lock ON app.profiles
  FOR UPDATE TO app_teacher_view_audit_reader USING (true) WITH CHECK (false);
CREATE POLICY teacher_view_admin_identity_read ON app.audit_identity_map
  FOR SELECT TO app_teacher_view_audit_reader USING (true);
CREATE POLICY teacher_view_admin_events_read ON app.audit_events
  FOR SELECT TO app_teacher_view_audit_reader USING (action = 'teacher_view');

CREATE INDEX audit_teacher_view_page ON app.audit_events (at DESC, id DESC) WHERE action = 'teacher_view';

CREATE FUNCTION app.read_admin_teacher_views(
  p_teacher uuid, p_student uuid, p_after_at timestamptz, p_after_id uuid,
  p_limit integer, p_valid boolean
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  v_admin uuid := auth.uid();
  v_result jsonb;
BEGIN
  -- profiles first, matching the existing authorization lock order.
  PERFORM id FROM app.profiles WHERE id = v_admin ORDER BY id FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM app.profiles WHERE id = v_admin AND role = 'admin'
    AND status = 'approved' AND deletion_state = 'none') THEN
    RETURN '{"outcome":"denied"}';
  END IF;
  IF p_valid IS DISTINCT FROM true OR p_limit IS NULL OR p_limit < 1 OR p_limit > 50
    OR (p_after_at IS NULL) <> (p_after_id IS NULL) OR NOT coalesce(isfinite(p_after_at), true) THEN
    RETURN '{"outcome":"invalid_input"}';
  END IF;

  -- No approved presentation policy exists for removed mappings. Never omit such events
  -- through an inner join, reconstruct identities, or disguise this gap as an empty page.
  WITH unresolved AS MATERIALIZED (
    SELECT 1 FROM app.audit_events e
    LEFT JOIN app.audit_identity_map actor ON actor.aid = e.actor_aid
    LEFT JOIN app.audit_identity_map subject ON subject.aid = e.subject_aid
    LEFT JOIN app.profiles teacher ON teacher.id = actor.account_id
    LEFT JOIN app.profiles student ON student.id = subject.account_id
    WHERE e.action = 'teacher_view' AND (
      teacher.display_label IS NULL OR length(btrim(teacher.display_label)) = 0
      OR student.display_label IS NULL OR length(btrim(student.display_label)) = 0)
    LIMIT 1
  ), page AS MATERIALIZED (
    SELECT e.id, e.at, teacher.display_label AS teacher_label, student.display_label AS student_label
    FROM app.audit_events e
    LEFT JOIN app.audit_identity_map actor ON actor.aid = e.actor_aid
    LEFT JOIN app.audit_identity_map subject ON subject.aid = e.subject_aid
    LEFT JOIN app.profiles teacher ON teacher.id = actor.account_id
    LEFT JOIN app.profiles student ON student.id = subject.account_id
    WHERE e.action = 'teacher_view'
      AND (p_teacher IS NULL OR actor.account_id = p_teacher)
      AND (p_student IS NULL OR subject.account_id = p_student)
      AND (p_after_at IS NULL OR (e.at, e.id) < (p_after_at, p_after_id))
    ORDER BY e.at DESC, e.id DESC LIMIT p_limit + 1
  ), visible AS MATERIALIZED (
    SELECT * FROM page ORDER BY at DESC, id DESC LIMIT p_limit
  )
  SELECT CASE WHEN EXISTS (SELECT 1 FROM unresolved) THEN '{"outcome":"identity_unavailable"}'::jsonb
    ELSE jsonb_build_object(
    'outcome', 'found',
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'teacher_label', teacher_label, 'student_label', student_label,
      'viewed_at', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ORDER BY at DESC, id DESC) FROM visible), '[]'::jsonb),
    'next', CASE WHEN (SELECT count(*) FROM page) > p_limit THEN
      (SELECT jsonb_build_object('at', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'id', id) FROM visible ORDER BY at, id LIMIT 1) ELSE NULL END
  ) END INTO v_result;
  RETURN v_result;
END
$function$;

ALTER FUNCTION app.read_admin_teacher_views(uuid, uuid, timestamptz, uuid, integer, boolean)
  OWNER TO app_teacher_view_audit_reader;
REVOKE ALL ON FUNCTION app.read_admin_teacher_views(uuid, uuid, timestamptz, uuid, integer, boolean)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION app.read_admin_teacher_views(uuid, uuid, timestamptz, uuid, integer, boolean)
  TO authenticated;

COMMIT;
