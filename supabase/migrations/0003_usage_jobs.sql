-- §76 隔離本機核心；無政策／價格／公開池種子，不授權產品啟用。
-- 僅依賴 0001／0002，刻意不參照稍後 0009 的 projects。
CREATE ROLE app_usage_executor NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE app_job_executor NOLOGIN NOINHERIT NOBYPASSRLS;

CREATE TABLE app.budget_pools (
  key text PRIMARY KEY CHECK (key = 'internal_ai'),
  label text NOT NULL
);
CREATE TABLE app.pool_limits (
  pool text NOT NULL REFERENCES app.budget_pools,
  period_month date NOT NULL CHECK (extract(day FROM period_month) = 1),
  limit_micro bigint NOT NULL CHECK (limit_micro >= 0),
  approved_ref uuid NOT NULL,
  PRIMARY KEY (pool, period_month)
);
CREATE TABLE app.quota_policies (
  id uuid PRIMARY KEY,
  authority text NOT NULL CHECK (authority IN ('approved', 'synthetic')),
  approved_ref uuid NOT NULL,
  subject_role app.account_role NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('learner_feature', 'admin_internal_test')),
  model text NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*$'),
  period text NOT NULL CHECK (period = 'daily'),
  limit_micro bigint NOT NULL CHECK (limit_micro >= 0),
  rate_per_min integer NOT NULL CHECK (rate_per_min > 0),
  max_concurrent integer NOT NULL CHECK (max_concurrent > 0),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE app.model_prices (
  model text NOT NULL,
  effective_from timestamptz NOT NULL,
  input_micro_per_mtok bigint NOT NULL CHECK (input_micro_per_mtok >= 0),
  cached_input_micro_per_mtok bigint NOT NULL CHECK (cached_input_micro_per_mtok >= 0),
  output_micro_per_mtok bigint NOT NULL CHECK (output_micro_per_mtok >= 0),
  image_micro_per_unit bigint NOT NULL CHECK (image_micro_per_unit >= 0),
  source_url text NOT NULL,
  verified_on date NOT NULL,
  PRIMARY KEY (model, effective_from)
);
CREATE TABLE app.usage_totals (
  scope text NOT NULL CHECK (scope IN ('pool', 'account')),
  subject_id uuid NOT NULL,
  period_key date NOT NULL,
  reserved_micro bigint NOT NULL DEFAULT 0 CHECK (reserved_micro >= 0),
  settled_micro bigint NOT NULL DEFAULT 0 CHECK (settled_micro >= 0),
  PRIMARY KEY (scope, subject_id, period_key)
);
CREATE TABLE app.usage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key uuid NOT NULL UNIQUE,
  subject_id uuid NOT NULL REFERENCES app.profiles,
  school_id uuid NOT NULL REFERENCES app.schools,
  school_epoch bigint NOT NULL,
  policy_id uuid NOT NULL REFERENCES app.quota_policies,
  pool text NOT NULL REFERENCES app.budget_pools,
  purpose text NOT NULL,
  model text NOT NULL,
  period_day date NOT NULL,
  period_month date NOT NULL,
  est_micro bigint NOT NULL CHECK (est_micro > 0),
  settled_micro bigint CHECK (settled_micro >= 0),
  state text NOT NULL CHECK (state IN ('reserved', 'settled', 'released', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  usage_digest jsonb,
  CHECK ((state = 'settled') = (settled_micro IS NOT NULL))
);
CREATE TABLE app.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL UNIQUE REFERENCES app.usage_reservations,
  idempotency_key uuid NOT NULL UNIQUE,
  subject_id uuid NOT NULL REFERENCES app.profiles,
  school_id uuid NOT NULL REFERENCES app.schools,
  school_epoch bigint NOT NULL,
  resource_id uuid,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'leased', 'done', 'failed', 'cancelled')),
  lease_owner uuid,
  lease_expires_at timestamptz,
  fence bigint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancel_requested boolean NOT NULL DEFAULT false,
  effect_state text NOT NULL DEFAULT 'ready'
    CHECK (effect_state IN ('ready', 'in_flight', 'unknown')),
  checkpoint integer NOT NULL DEFAULT 0,
  partial_refs uuid[] NOT NULL DEFAULT '{}',
  confirmed_usage jsonb NOT NULL DEFAULT '{"input_tokens":0,"cached_input_tokens":0,"output_tokens":0,"images":0}',
  failure_code text,
  CHECK (checkpoint >= 0 AND attempts >= 0)
);
CREATE TABLE app.usage_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reservation_id uuid NOT NULL REFERENCES app.usage_reservations,
  action text NOT NULL CHECK (action IN ('reserved', 'settled', 'released', 'unknown')),
  amount_micro bigint CHECK (amount_micro >= 0)
);
CREATE INDEX jobs_ready ON app.jobs (run_after) WHERE state IN ('queued', 'leased');
CREATE INDEX usage_recent ON app.usage_reservations (subject_id, created_at);

DO $block$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['budget_pools','pool_limits','quota_policies','model_prices',
    'usage_totals','usage_reservations','jobs','usage_audit'] LOOP
    EXECUTE format('ALTER TABLE app.%I OWNER TO postgres', name);
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, anon, authenticated, service_role, app_usage_executor, app_job_executor', name);
  END LOOP;
END
$block$;
GRANT USAGE ON SCHEMA app TO app_usage_executor, app_job_executor;
GRANT USAGE ON SCHEMA auth TO app_usage_executor;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_usage_executor;

CREATE FUNCTION app.usage_period_keys(instant timestamptz)
RETURNS TABLE(period_day date, period_month date)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $function$
  SELECT (instant AT TIME ZONE 'Asia/Taipei')::date,
    date_trunc('month', instant AT TIME ZONE 'Asia/Taipei')::date
$function$;

CREATE FUNCTION app.usage_account_allowed(subject uuid, school uuid, epoch bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM app.profiles p JOIN app.schools s ON s.id = p.school_id
    WHERE p.id = subject AND p.school_id = school AND p.role = 'student'
      AND p.status = 'approved' AND p.deletion_state = 'none'
      AND s.approval_state = 'approved' AND s.approval_epoch = epoch
      -- D-04 尚未核定 valid_until 語意；非 NULL 分支不自行採用到期方案。
      AND s.valid_until IS NULL
      AND app.account_gate(subject, 'login')
  )
$function$;

CREATE FUNCTION app.usage_reserve(
  idem uuid, policy uuid, estimate bigint, resource uuid DEFAULT NULL
) RETURNS app.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  subject uuid := auth.uid();
  p app.quota_policies%ROWTYPE;
  a app.profiles%ROWTYPE;
  s app.schools%ROWTYPE;
  r app.usage_reservations%ROWTYPE;
  j app.jobs%ROWTYPE;
  day_key date;
  month_key date;
  pool_subject uuid := '00000000-0000-0000-0000-000000000000';
  pool_limit bigint;
BEGIN
  IF subject IS NULL OR idem IS NULL OR estimate IS NULL OR estimate <= 0 THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  SELECT period_day, period_month INTO day_key, month_key
    FROM app.usage_period_keys(clock_timestamp());
  PERFORM pg_advisory_xact_lock(hashtextextended(idem::text, 0));
  -- 相同帳號所有預留串行化；不同帳號仍由 pool totals 的列鎖保護。
  SELECT * INTO a FROM app.profiles WHERE id = subject FOR SHARE;
  SELECT * INTO s FROM app.schools WHERE id = a.school_id FOR SHARE;
  IF NOT app.usage_account_allowed(subject, s.id, s.approval_epoch) THEN
    RAISE EXCEPTION 'authorization_denied';
  END IF;
  SELECT * INTO p FROM app.quota_policies WHERE id = policy AND enabled FOR UPDATE;
  IF NOT FOUND OR p.subject_role <> a.role OR p.purpose <> 'learner_feature'
    OR (p.authority = 'synthetic' AND session_user <> 'app_usage_test') THEN
    RAISE EXCEPTION 'policy_not_approved';
  END IF;
  -- 教師／管理員完整角色與值守政策仍未定，這些正式分支維持拒絕。
  SELECT * INTO r FROM app.usage_reservations WHERE idempotency_key = idem FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO j FROM app.jobs WHERE reservation_id = r.id;
    IF r.subject_id <> subject OR r.policy_id <> policy OR r.est_micro <> estimate
      OR j.resource_id IS DISTINCT FROM resource THEN
      RAISE EXCEPTION 'idempotency_key_reuse';
    END IF;
    RETURN j;
  END IF;
  -- 即使不同政策版本也共用帳號日桶，避免輪替政策繞過計數。
  INSERT INTO app.usage_totals(scope, subject_id, period_key)
    VALUES ('account', subject, day_key) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM app.usage_totals
    WHERE scope = 'account' AND subject_id = subject AND period_key = day_key FOR UPDATE;
  IF (SELECT count(*) FROM app.usage_reservations
      WHERE subject_id = subject AND created_at > clock_timestamp() - interval '1 minute') >= p.rate_per_min THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF (SELECT count(*) FROM app.usage_reservations
      WHERE subject_id = subject AND state IN ('reserved', 'unknown')) >= p.max_concurrent THEN
    RAISE EXCEPTION 'concurrency_limited';
  END IF;
  UPDATE app.usage_totals SET reserved_micro = reserved_micro + estimate
    WHERE scope = 'account' AND subject_id = subject AND period_key = day_key
      AND reserved_micro::numeric + settled_micro + estimate <= p.limit_micro;
  IF NOT FOUND THEN RAISE EXCEPTION 'quota_daily_exhausted'; END IF;
  SELECT limit_micro INTO pool_limit FROM app.pool_limits
    WHERE pool = 'internal_ai' AND period_month = month_key FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'policy_not_approved'; END IF;
  INSERT INTO app.usage_totals(scope, subject_id, period_key)
    VALUES ('pool', pool_subject, month_key) ON CONFLICT DO NOTHING;
  UPDATE app.usage_totals SET reserved_micro = reserved_micro + estimate
    WHERE scope = 'pool' AND subject_id = pool_subject AND period_key = month_key
      AND reserved_micro::numeric + settled_micro + estimate <= pool_limit;
  IF NOT FOUND THEN RAISE EXCEPTION 'pool_creator_exhausted'; END IF;
  INSERT INTO app.usage_reservations(idempotency_key, subject_id, school_id, school_epoch,
    policy_id, pool, purpose, model, period_day, period_month, est_micro, state)
    VALUES (idem, subject, s.id, s.approval_epoch, p.id, 'internal_ai', p.purpose,
      p.model, day_key, month_key, estimate, 'reserved') RETURNING * INTO r;
  INSERT INTO app.jobs(reservation_id, idempotency_key, subject_id, school_id, school_epoch,
    resource_id, kind, max_attempts)
    VALUES (r.id, idem, subject, s.id, s.approval_epoch, resource, p.kind, p.max_attempts)
    RETURNING * INTO j;
  INSERT INTO app.usage_audit(reservation_id, action, amount_micro) VALUES (r.id, 'reserved', estimate);
  RETURN j;
END
$function$;

CREATE FUNCTION app.usage_finish(reservation uuid, action text, usage jsonb DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE
  r app.usage_reservations%ROWTYPE;
  price app.model_prices%ROWTYPE;
  amount numeric;
  old_reserved bigint;
BEGIN
  SELECT * INTO r FROM app.usage_reservations WHERE id = reservation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation_not_found'; END IF;
  IF action NOT IN ('settled','released','unknown') OR action IS NULL THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF r.state IN ('released','settled') THEN
    IF r.state <> action OR (action = 'settled' AND r.usage_digest IS DISTINCT FROM usage) THEN
      RAISE EXCEPTION 'reservation_state_conflict';
    END IF;
    RETURN r.state;
  END IF;
  IF action = 'released' AND (r.state = 'unknown' OR EXISTS (
      SELECT 1 FROM app.jobs WHERE reservation_id = r.id AND (effect_state <> 'ready' OR checkpoint > 0))) THEN
    RAISE EXCEPTION 'reconciliation_required';
  END IF;
  IF action = 'settled' THEN
    IF r.state = 'unknown' THEN RAISE EXCEPTION 'reconciliation_required'; END IF;
    IF usage IS NULL OR jsonb_typeof(usage) <> 'object'
      OR NOT (usage ?& ARRAY['input_tokens','cached_input_tokens','output_tokens','images'])
      OR (SELECT count(*) FROM jsonb_object_keys(usage)) <> 4
      OR EXISTS (SELECT 1 FROM jsonb_each(usage) e
        WHERE jsonb_typeof(e.value) <> 'number' OR e.value::text !~ '^[0-9]+$')
      OR (usage->>'cached_input_tokens')::numeric > (usage->>'input_tokens')::numeric THEN
      RAISE EXCEPTION 'invalid_usage';
    END IF;
    SELECT * INTO price FROM app.model_prices
      WHERE model = r.model AND effective_from <= r.created_at
      ORDER BY effective_from DESC LIMIT 1;
    IF NOT FOUND THEN
      action := 'unknown';
    ELSE
      amount := (((usage->>'input_tokens')::numeric - (usage->>'cached_input_tokens')::numeric)
        * price.input_micro_per_mtok
        + (usage->>'cached_input_tokens')::numeric * price.cached_input_micro_per_mtok
        + (usage->>'output_tokens')::numeric * price.output_micro_per_mtok) / 1000000
        + (usage->>'images')::numeric * price.image_micro_per_unit;
      -- 契約未核定分數 micro 的捨入；不自行進位或當零。
      IF amount <> trunc(amount) OR amount > 9223372036854775807 THEN action := 'unknown'; END IF;
    END IF;
  END IF;
  IF action = 'unknown' THEN
    IF r.state <> 'unknown' THEN
      UPDATE app.usage_reservations SET state = 'unknown' WHERE id = reservation;
      INSERT INTO app.usage_audit(reservation_id, action) VALUES (r.id, 'unknown');
    END IF;
    RETURN 'unknown';
  END IF;
  old_reserved := r.est_micro;
  PERFORM 1 FROM app.usage_totals
    WHERE scope = 'account' AND subject_id = r.subject_id AND period_key = r.period_day FOR UPDATE;
  PERFORM 1 FROM app.usage_totals
    WHERE scope = 'pool' AND subject_id = '00000000-0000-0000-0000-000000000000'
      AND period_key = r.period_month FOR UPDATE;
  UPDATE app.usage_totals SET reserved_micro = reserved_micro - old_reserved,
    settled_micro = settled_micro + CASE WHEN action = 'settled' THEN amount::bigint ELSE 0 END
    WHERE (scope = 'account' AND subject_id = r.subject_id AND period_key = r.period_day)
      OR (scope = 'pool' AND subject_id = '00000000-0000-0000-0000-000000000000'
        AND period_key = r.period_month);
  UPDATE app.usage_reservations SET state = action,
    settled_micro = CASE WHEN action = 'settled' THEN amount::bigint ELSE NULL END,
    settled_at = clock_timestamp(), usage_digest = CASE WHEN action = 'settled' THEN usage ELSE NULL END
    WHERE id = reservation;
  INSERT INTO app.usage_audit(reservation_id, action, amount_micro)
    VALUES (r.id, action, CASE WHEN action = 'settled' THEN amount::bigint ELSE 0 END);
  RETURN action;
END
$function$;

CREATE FUNCTION app.job_stop_usage(job app.jobs) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
  SELECT app.usage_finish(job.reservation_id,
    CASE WHEN job.checkpoint > 0 THEN 'settled' ELSE 'released' END,
    CASE WHEN job.checkpoint > 0 THEN job.confirmed_usage ELSE NULL END)
$function$;

CREATE FUNCTION app.job_claim(worker uuid, lease_ms integer)
RETURNS SETOF app.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE j app.jobs%ROWTYPE; outcome text;
BEGIN
  IF worker IS NULL OR lease_ms IS NULL OR lease_ms < 1 THEN RAISE EXCEPTION 'invalid_input'; END IF;
  FOR j IN SELECT * FROM app.jobs
    WHERE (state = 'queued' AND run_after <= clock_timestamp())
       OR (state = 'leased' AND lease_expires_at <= clock_timestamp())
    ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1
  LOOP
    IF j.effect_state <> 'ready' THEN
      PERFORM app.usage_finish(j.reservation_id, 'unknown');
      UPDATE app.jobs SET state = 'failed', effect_state = 'unknown',
        failure_code = 'reconciliation_required', fence = fence + 1 WHERE id = j.id;
      RETURN;
    END IF;
    IF j.cancel_requested OR j.attempts >= j.max_attempts
      OR NOT app.usage_account_allowed(j.subject_id, j.school_id, j.school_epoch) THEN
      outcome := app.job_stop_usage(j);
      UPDATE app.jobs SET state = CASE WHEN cancel_requested AND outcome <> 'unknown' THEN 'cancelled' ELSE 'failed' END,
        failure_code = CASE WHEN outcome = 'unknown' THEN 'reconciliation_required'
          WHEN cancel_requested THEN 'cancelled' ELSE 'gate_or_retry_limit' END,
        fence = fence + 1 WHERE id = j.id;
      RETURN;
    END IF;
    UPDATE app.jobs SET state = 'leased', lease_owner = worker,
      lease_expires_at = clock_timestamp() + lease_ms * interval '1 millisecond',
      attempts = attempts + 1, fence = fence + 1 WHERE id = j.id RETURNING * INTO j;
    RETURN NEXT j;
  END LOOP;
END
$function$;

CREATE FUNCTION app.job_checkpoint(
  job uuid, worker uuid, token bigint, operation text, lease_ms integer,
  result_ref uuid DEFAULT NULL, usage jsonb DEFAULT NULL
) RETURNS app.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE j app.jobs%ROWTYPE; outcome text; combined jsonb;
BEGIN
  SELECT * INTO j FROM app.jobs WHERE id = job FOR UPDATE;
  IF NOT FOUND OR j.state <> 'leased' OR j.lease_owner IS DISTINCT FROM worker
    OR j.fence <> token OR j.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'stale_lease';
  END IF;
  IF operation IS NULL OR operation NOT IN ('heartbeat','begin','complete','done','retry','unknown','stop','not_sent')
    OR lease_ms IS NULL OR lease_ms < 1 THEN RAISE EXCEPTION 'invalid_input'; END IF;
  -- 鎖住當下帳號／學校列至本次平台寫入提交，非鎖住外部呼叫。
  PERFORM 1 FROM app.profiles WHERE id = j.subject_id FOR SHARE;
  PERFORM 1 FROM app.schools WHERE id = j.school_id FOR SHARE;
  IF j.cancel_requested OR NOT app.usage_account_allowed(j.subject_id, j.school_id, j.school_epoch)
    OR operation = 'stop' THEN
    IF j.effect_state = 'in_flight' THEN
      PERFORM app.usage_finish(j.reservation_id, 'unknown');
      UPDATE app.jobs SET state = 'failed', effect_state = 'unknown',
        failure_code = 'reconciliation_required' WHERE id = job RETURNING * INTO j;
    ELSE
      outcome := app.job_stop_usage(j);
      UPDATE app.jobs SET state = CASE WHEN cancel_requested AND outcome <> 'unknown' THEN 'cancelled' ELSE 'failed' END,
        failure_code = CASE WHEN outcome = 'unknown' THEN 'reconciliation_required' ELSE 'gate_or_cancelled' END
        WHERE id = job RETURNING * INTO j;
    END IF;
    RETURN j;
  END IF;
  CASE operation
    WHEN 'heartbeat' THEN NULL;
    WHEN 'begin' THEN
      IF j.effect_state <> 'ready' THEN RAISE EXCEPTION 'effect_already_started'; END IF;
      UPDATE app.jobs SET effect_state = 'in_flight' WHERE id = job;
    WHEN 'complete' THEN
      IF j.effect_state <> 'in_flight' OR result_ref IS NULL THEN RAISE EXCEPTION 'invalid_checkpoint'; END IF;
      IF usage IS NULL OR jsonb_typeof(usage) <> 'object'
        OR NOT (usage ?& ARRAY['input_tokens','cached_input_tokens','output_tokens','images'])
        OR (SELECT count(*) FROM jsonb_object_keys(usage)) <> 4
        OR EXISTS (SELECT 1 FROM jsonb_each(usage) e
          WHERE jsonb_typeof(e.value) <> 'number' OR e.value::text !~ '^[0-9]+$')
        OR (usage->>'cached_input_tokens')::numeric > (usage->>'input_tokens')::numeric THEN
        RAISE EXCEPTION 'invalid_usage';
      END IF;
      SELECT jsonb_object_agg(e.key, (e.value::text)::numeric + (j.confirmed_usage->>e.key)::numeric)
        INTO combined FROM jsonb_each(usage) e;
      UPDATE app.jobs SET effect_state = 'ready', checkpoint = checkpoint + 1,
        confirmed_usage = combined, partial_refs = array_append(partial_refs, result_ref) WHERE id = job;
    WHEN 'not_sent' THEN
      IF j.effect_state <> 'in_flight' THEN RAISE EXCEPTION 'invalid_checkpoint'; END IF;
      UPDATE app.jobs SET effect_state = 'ready' WHERE id = job;
    WHEN 'done' THEN
      IF j.effect_state <> 'ready' THEN RAISE EXCEPTION 'effect_not_complete'; END IF;
      outcome := app.usage_finish(j.reservation_id, 'settled', j.confirmed_usage);
      UPDATE app.jobs SET state = CASE WHEN outcome = 'settled' THEN 'done' ELSE 'failed' END,
        effect_state = CASE WHEN outcome = 'unknown' THEN 'unknown' ELSE effect_state END,
        failure_code = CASE WHEN outcome = 'unknown' THEN 'reconciliation_required' ELSE NULL END
        WHERE id = job;
    WHEN 'retry' THEN
      IF j.effect_state <> 'ready' THEN RAISE EXCEPTION 'reconciliation_required'; END IF;
      IF j.attempts >= j.max_attempts THEN
        PERFORM app.job_stop_usage(j);
        UPDATE app.jobs SET state = 'failed', failure_code = 'retry_limit' WHERE id = job;
      ELSE
        UPDATE app.jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = job;
      END IF;
    WHEN 'unknown' THEN
      PERFORM app.usage_finish(j.reservation_id, 'unknown');
      UPDATE app.jobs SET state = 'failed', effect_state = 'unknown',
        failure_code = 'reconciliation_required' WHERE id = job;
    ELSE RAISE EXCEPTION 'invalid_input';
  END CASE;
  UPDATE app.jobs SET lease_expires_at = CASE WHEN state = 'leased'
    THEN clock_timestamp() + lease_ms * interval '1 millisecond' ELSE NULL END
    WHERE id = job RETURNING * INTO j;
  RETURN j;
END
$function$;

CREATE FUNCTION app.job_cancel(job uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT app.account_gate(auth.uid(), 'login') THEN
    RAISE EXCEPTION 'authorization_denied';
  END IF;
  UPDATE app.jobs SET cancel_requested = true
    WHERE id = job AND subject_id = auth.uid() AND state IN ('queued','leased');
  RETURN FOUND;
END
$function$;

REVOKE ALL ON FUNCTION app.usage_account_allowed(uuid,uuid,bigint),
  app.usage_period_keys(timestamptz),
  app.job_stop_usage(app.jobs),
  app.usage_reserve(uuid,uuid,bigint,uuid), app.usage_finish(uuid,text,jsonb),
  app.job_claim(uuid,integer), app.job_checkpoint(uuid,uuid,bigint,text,integer,uuid,jsonb),
  app.job_cancel(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.usage_reserve(uuid,uuid,bigint,uuid), app.job_cancel(uuid)
  TO app_usage_executor;
GRANT EXECUTE ON FUNCTION app.job_claim(uuid,integer),
  app.job_checkpoint(uuid,uuid,bigint,text,integer,uuid,jsonb) TO app_job_executor;

ALTER FUNCTION app.usage_account_allowed(uuid,uuid,bigint) OWNER TO postgres;
ALTER FUNCTION app.usage_period_keys(timestamptz) OWNER TO postgres;
ALTER FUNCTION app.usage_reserve(uuid,uuid,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION app.usage_finish(uuid,text,jsonb) OWNER TO postgres;
ALTER FUNCTION app.job_stop_usage(app.jobs) OWNER TO postgres;
ALTER FUNCTION app.job_claim(uuid,integer) OWNER TO postgres;
ALTER FUNCTION app.job_checkpoint(uuid,uuid,bigint,text,integer,uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION app.job_cancel(uuid) OWNER TO postgres;
