-- T011 本機基礎：Job 狀態查詢所需的時間欄位與擁有者唯讀快照函式。
-- 編號 0004–0019 已被 tasks.md 既有規劃占用，故使用 0020；不改既有 migration。
-- 只提供 COMMON「狀態查詢」所需的 started_at／updated_at 與擁有者唯讀快照，不定義任何 kind 的成功 result。

ALTER TABLE app.jobs
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN started_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

-- 既有已被領取過的列以 updated_at 近似開始時間，確保「完成的工作必有開始時間」。
UPDATE app.jobs SET started_at = updated_at WHERE attempts > 0 AND started_at IS NULL;

CREATE FUNCTION app.jobs_touch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  NEW.updated_at := clock_timestamp();
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := NEW.updated_at;
    NEW.started_at := NULL;
  ELSIF NEW.state = 'leased' AND NEW.started_at IS NULL THEN
    NEW.started_at := NEW.updated_at;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER jobs_touch BEFORE INSERT OR UPDATE ON app.jobs
  FOR EACH ROW EXECUTE FUNCTION app.jobs_touch();

-- 擁有者唯讀；當下帳號 gate 失敗拒絕，非擁有者與不存在一律回零列，不洩漏他人工作存在。
CREATE FUNCTION app.job_status(job uuid)
RETURNS TABLE(
  job_id uuid, kind text, state text, started_at timestamptz, updated_at timestamptz,
  failure_code text, checkpoint integer, effect_state text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT app.account_gate(auth.uid(), 'login') THEN
    RAISE EXCEPTION 'authorization_denied';
  END IF;
  RETURN QUERY
    SELECT j.id, j.kind, j.state, j.started_at, j.updated_at, j.failure_code, j.checkpoint, j.effect_state
    FROM app.jobs j WHERE j.id = job AND j.subject_id = auth.uid();
END
$function$;

REVOKE ALL ON FUNCTION app.jobs_touch(), app.job_status(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.job_status(uuid) TO app_usage_executor;
ALTER FUNCTION app.jobs_touch() OWNER TO postgres;
ALTER FUNCTION app.job_status(uuid) OWNER TO postgres;
