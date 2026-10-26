CREATE FUNCTION app.account_gate(account_id uuid, capability text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  account app.profiles%ROWTYPE;
  school_state app.school_approval_state;
BEGIN
  IF account_id IS NULL OR capability IS NULL THEN
    RETURN false;
  END IF;

  SELECT profile.*
  INTO account
  FROM app.profiles AS profile
  WHERE profile.id = account_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF account.status = 'disabled' OR account.deletion_state <> 'none' THEN
    RETURN false;
  END IF;

  IF capability = 'login' THEN
    IF account.role IN ('teacher', 'admin')
      AND account.status IN ('pending', 'rejected') THEN
      RETURN true;
    END IF;

    IF account.status <> 'approved' THEN
      RETURN false;
    END IF;

    IF account.role IN ('teacher', 'admin') THEN
      RETURN true;
    END IF;

    IF account.school_id IS NULL THEN
      RETURN false;
    END IF;

    SELECT school.approval_state
    INTO school_state
    FROM app.schools AS school
    WHERE school.id = account.school_id;

    IF NOT FOUND THEN
      RETURN false;
    END IF;

    RETURN school_state <> 'unconfirmed';
  END IF;

  IF account.role <> 'student'
    OR account.status <> 'approved'
    OR account.school_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT school.approval_state
  INTO school_state
  FROM app.schools AS school
  WHERE school.id = account.school_id;

  IF NOT FOUND OR school_state = 'unconfirmed' THEN
    RETURN false;
  END IF;

  CASE capability
    WHEN 'read_saved_content' THEN
      RETURN true;
    WHEN 'edit_saved_content' THEN
      RETURN true;
    WHEN 'download_own_results' THEN
      RETURN true;
    WHEN 'submit_for_review' THEN
      RETURN true;
    WHEN 'public_deploy' THEN
      RETURN school_state = 'approved';
    ELSE
      RETURN false;
  END CASE;
END;
$function$;

ALTER FUNCTION app.account_gate(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.account_gate(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.current_account_gate(capability text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT app.account_gate(auth.uid(), capability)
$function$;

ALTER FUNCTION app.current_account_gate(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.current_account_gate(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.current_account_gate(text) TO authenticated;

CREATE FUNCTION app.teacher_can_view_student(p_student_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM app.profiles AS teacher
      JOIN app.teacher_student_bindings AS binding
        ON binding.teacher_id = teacher.id
       AND binding.state = 'active'
      JOIN app.profiles AS student
        ON student.id = binding.student_id
      JOIN app.schools AS school
        ON school.id = student.school_id
      WHERE teacher.id = auth.uid()
        AND teacher.role = 'teacher'
        AND teacher.status = 'approved'
        AND teacher.deletion_state = 'none'
        AND student.id = p_student_id
        AND student.role = 'student'
        AND student.status = 'approved'
        AND student.deletion_state = 'none'
        AND school.approval_state = 'approved'
        AND app.account_gate(teacher.id, 'login')
        AND app.account_gate(student.id, 'read_saved_content')
    )
$function$;

ALTER FUNCTION app.teacher_can_view_student(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.teacher_can_view_student(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.teacher_can_view_student(uuid) TO authenticated;

CREATE POLICY profiles_read_self
  ON app.profiles
  FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    AND app.current_account_gate('login')
  );

CREATE POLICY schools_read_own_or_affiliated
  ON app.schools
  FOR SELECT
  TO authenticated
  USING (
    app.current_account_gate('login')
    AND (
      EXISTS (
        SELECT 1
        FROM app.profiles AS student
        WHERE student.id = auth.uid()
          AND student.role = 'student'
          AND student.school_id = schools.id
      )
      OR EXISTS (
        SELECT 1
        FROM app.teacher_school_memberships AS membership
        WHERE membership.teacher_id = auth.uid()
          AND membership.school_id = schools.id
          AND membership.state = 'active'
      )
    )
  );

CREATE POLICY teacher_school_memberships_read_self_active
  ON app.teacher_school_memberships
  FOR SELECT
  TO authenticated
  USING (
    teacher_id = auth.uid()
    AND state = 'active'
    AND app.current_account_gate('login')
    AND EXISTS (
      SELECT 1
      FROM app.profiles AS teacher
      WHERE teacher.id = auth.uid()
        AND teacher.role = 'teacher'
        AND teacher.status = 'approved'
        AND teacher.deletion_state = 'none'
    )
  );

CREATE POLICY teacher_student_bindings_read_authorized
  ON app.teacher_student_bindings
  FOR SELECT
  TO authenticated
  USING (
    teacher_id = auth.uid()
    AND app.teacher_can_view_student(student_id)
  );
