BEGIN;

-- readiness §90：本人帳號狀態讀取（A-2 登入後判定、A-4 /me）。
-- 只讀 auth.uid() 本人，不接受任何主體參數；固定投影，不回傳 handle、school_id、學校名稱、
-- 學習資料或其他帳號識別。停用／待審／拒絕者也能讀到自己的最小狀態，但不因此通過任何
-- account_gate 或 RLS；一般資料權限仍由既有 gate／policy 判斷。
-- 擁有者與 SECURITY DEFINER 慣例沿用 0002 的 app.account_gate。
CREATE FUNCTION app.current_account_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_subject uuid := auth.uid();
  v_account app.profiles%ROWTYPE;
  v_school_state app.school_approval_state;
  v_school_found boolean := false;
  v_teachers jsonb := '[]'::jsonb;
BEGIN
  IF v_subject IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT profile.* INTO v_account FROM app.profiles AS profile WHERE profile.id = v_subject;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_account.role = 'student' AND v_account.school_id IS NOT NULL THEN
    SELECT school.approval_state INTO v_school_state
    FROM app.schools AS school WHERE school.id = v_account.school_id;
    v_school_found := FOUND;
  END IF;

  -- 與 app.teacher_can_view_student 相同的教師可檢視條件，由學生本人側投影；只回顯示標籤。
  IF v_account.role = 'student' AND v_account.status = 'approved'
    AND v_account.deletion_state = 'none' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(teacher.display_label) ORDER BY binding.created_at, binding.id),
      '[]'::jsonb)
    INTO v_teachers
    FROM app.teacher_student_bindings AS binding
    JOIN app.profiles AS teacher ON teacher.id = binding.teacher_id
    JOIN app.schools AS school ON school.id = v_account.school_id
    WHERE binding.student_id = v_subject
      AND binding.state = 'active'
      AND teacher.role = 'teacher'
      AND teacher.status = 'approved'
      AND teacher.deletion_state = 'none'
      AND school.approval_state = 'approved'
      AND app.account_gate(teacher.id, 'login')
      AND app.account_gate(v_subject, 'read_saved_content');
  END IF;

  RETURN jsonb_build_object(
    'subject', v_subject,
    'role', v_account.role,
    'status', v_account.status,
    'deletion_state', v_account.deletion_state,
    'school_found', v_school_found,
    'school_state', CASE WHEN v_school_found THEN to_jsonb(v_school_state) ELSE 'null'::jsonb END,
    'login_gate', app.account_gate(v_subject, 'login'),
    'public_deploy_gate', app.account_gate(v_subject, 'public_deploy'),
    'ai_call_gate', app.account_gate(v_subject, 'ai_call'),
    'teacher_labels', v_teachers
  );
END;
$function$;

ALTER FUNCTION app.current_account_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION app.current_account_status()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.current_account_status() TO authenticated;

COMMIT;
