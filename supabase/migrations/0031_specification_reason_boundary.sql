BEGIN;

CREATE FUNCTION app.specification_reason_valid(p_reason text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
DECLARE v_code integer; v_index integer;
BEGIN
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 2000 THEN RETURN false; END IF;
  -- ECMAScript trim 的固定 WhiteSpace／LineTerminator 集合；不依賴 locale。
  IF length(btrim(p_reason, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) = 0
    THEN RETURN false; END IF;
  FOR v_index IN 1..length(p_reason) LOOP
    v_code := ascii(substr(p_reason,v_index,1));
    IF v_code BETWEEN 0 AND 31 OR v_code BETWEEN 127 AND 159 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION app.specification_reason_valid(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.specification_reason_valid(text) TO app_specification_reviewer;

LOCK TABLE app.specification_decisions IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE v_invalid bigint;
BEGIN
  SELECT count(*) INTO v_invalid FROM app.specification_decisions
    WHERE decision='returned' AND NOT app.specification_reason_valid(reason);
  IF v_invalid > 0 THEN
    RAISE EXCEPTION 'specification_reason_upgrade_blocked count=%', v_invalid;
  END IF;
END; $$;
ALTER TABLE app.specification_decisions DROP CONSTRAINT specification_decisions_check;
ALTER TABLE app.specification_decisions ADD CONSTRAINT specification_decisions_reason_valid
  CHECK ((decision='approved' AND reason IS NULL) OR
    (decision='returned' AND app.specification_reason_valid(reason)));

CREATE OR REPLACE FUNCTION app.decide_specification(p_submission uuid,p_decision text,p_reason text,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE sub app.specification_submissions%ROWTYPE; b app.teacher_student_bindings%ROWTYPE;
  m app.teacher_school_memberships%ROWTYPE; t app.profiles%ROWTYPE;
  old app.specification_decisions%ROWTYPE;
BEGIN
  IF p_submission IS NULL OR p_key IS NULL OR p_decision IS NULL OR p_decision NOT IN ('approved','returned')
    OR (p_decision='approved' AND p_reason IS NOT NULL)
    OR (p_decision='returned' AND NOT app.specification_reason_valid(p_reason))
    THEN RETURN '{"outcome":"invalid_input"}'; END IF;
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
COMMIT;
