-- Public platform job-run ledger: the two relations a scheduled job needs to be
-- mutually exclusive across runners, and the two verbs its runtime actually calls.
--
-- WHAT THIS FORWARD SHIPS, AND WHY IT IS TWO VERBS AND NOT THREE. The second bundle
-- already has reads, a queue, a customer mutation, an operator mutation and a shipment
-- machine. What it has never had is the thing that lets a *scheduled* job run at all:
-- somewhere to say "this attempt is mine, nobody else start", and somewhere to say
-- "it is finished, and this is what it did". The consumer of this ledger asks for
-- exactly those two things -- a claim and a finish -- and for nothing else. There is
-- no heartbeat, no renew and no extend anywhere in the runtime that drives it, so
-- there is none here: a lease is issued once, and it is released by finishing or by
-- expiring. A failure is a finish with status 'failed', not a separate verb.
--
-- EXCLUSIVITY IS THE CONTROL ROW, NOT AN ADVISORY LOCK. The claim upserts the job's
-- control row and then takes `FOR UPDATE` on it. A second claimer arriving in the same
-- instant blocks on that row rather than racing past it, and once the first claimer
-- commits it reads a live lease and is refused. This is deliberate and it is the
-- property the harness proves with two concurrent connections. An advisory lock would
-- be a different machine: it is not carried by the row, so it would vanish with the
-- session and leave the ledger claiming a run that nobody holds. The lease, in
-- contrast, outlives the connection and is what makes a crashed runner recoverable --
-- after the lease elapses, and not before.
--
-- WHAT A FINISH IS ALLOWED TO DO. A finish always stamps its own run row, because a
-- runner that lost its lease still owes the ledger the truth about what it did. It
-- releases the *job* only when the control row still carries its own token. So a
-- zombie -- a runner whose lease expired and whose job was re-claimed by somebody else
-- -- writes its own epitaph and returns false, and cannot clear a lease it no longer
-- holds. That returned boolean is the fencing signal, and the harness asserts it.
--
-- WHERE THE SEMANTICS COME FROM, AND EVERY PLACE THIS KERNEL DEPARTS FROM THEM. The
-- behaviour above is derived from the managed chain's own claim/finish pair, read in
-- full rather than summarised: its two relations and its first begin/finish, the later
-- migration that added the second finish and the driver/lease/counter columns, the
-- migration that rewrote the claim into its current 199-line body, and the migration
-- that introduced a neutral trigger vocabulary. Five departures, each named because a
-- silent one is how a kernel and its origin quietly stop being the same machine:
--
--   1. THE RUNNER VOCABULARY IS NEUTRAL: 'worker', 'scheduler', 'operator'. The chain's
--      set enumerates two named cron mechanisms, one of which is the scheduler of a
--      specific hosting vendor. Which scheduler a deployment happens to run is a fact
--      about that deployment, never a fact about a platform, and this kernel may not
--      carry a vendor's name in a CHECK constraint. The vocabulary chosen is not
--      invented here either: it is the one the chain's own newest control-plane
--      migration introduced, in its words, so that a deployment adapter is EVIDENCE
--      rather than an authorization decision. The concrete adapter label survives
--      losslessly in `p_metadata`, which is caller-supplied jsonb this kernel stores
--      and never interprets.
--   2. THE FIRST CLAIMER DEFINES THE JOB'S ACTIVE RUNNER. Upstream the control row is
--      created with a fixed default runner, so on a fresh install the first tick of a
--      long-running worker is refused as the wrong runner until an operator edits a
--      row by hand. That is a migration artefact of a live cutover, not a platform
--      rule. Here the auto-created row adopts the runner that created it; changing
--      runners afterwards stays an explicit operator UPDATE, and the refusal below
--      still protects a job whose runner has been pinned.
--   3. ONE LEASE COLUMN AND ONE COUNTER PAIR. Upstream carries `lease_until` and
--      `lease_expires_at` for one lease, and `checked`/`checked_count`,
--      `updated`/`updated_count` for one pair of counts, writing both of each on every
--      call. Those are compatibility shadows of an earlier signature. This kernel has
--      no earlier signature, so it ships one of each. For the same reason the run row
--      records its runner once, where upstream writes the same value into three
--      columns.
--   4. NO `SECURITY DEFINER`, NO `GRANT`/`REVOKE`, NO ROW-LEVEL SECURITY, matching
--      every forward this catalogue already carries. This kernel creates zero roles.
--      Said out loud rather than assumed: ON THIS KERNEL THE FUNCTIONS BELOW ARE NOT A
--      SECURITY BOUNDARY -- the host application is what authenticates, and a caller
--      that can reach these functions can already reach the tables. `SET search_path`
--      is kept, because that one is a correctness property and not a role property.
--   5. THE FINISH KEEPS ITS `_v2` SUFFIX. There is no v1 in this kernel and the suffix
--      describes the version history of a different codebase. It is kept anyway: it is
--      the name the shipped consumer calls, and giving a public kernel a second,
--      prettier name for one verb would be worse than carrying one inherited one.
--
-- WHAT THIS FORWARD DELIBERATELY DOES NOT SHIP, enumerated so nobody has to infer it:
--   * no runtime binding. Not one line of the application runtime is rewired onto this
--     ledger by this forward; the files that would do it belong to another line of work
--     in flight, and the falsifier for this kernel is its own parity harness driving
--     the shipped port's two calls;
--   * no job seed. A job NAME is a deployment fact, so this kernel names none. The
--     claim creates the control row it needs on first contact;
--   * no lease extension and no reaper. Neither exists upstream either. A lease that
--     elapses is simply claimable again, and a job that must not be re-entered before
--     its own work finishes must ask for a lease long enough to cover it;
--   * no attempt counter and no poison-pill policy. Upstream has none on this ledger,
--     and inventing one here would be a policy this kernel has no way to falsify;
--   * no scheduling. WHEN a job runs is the host's problem. This ledger only answers
--     whether an attempt that has already begun is allowed to proceed.

CREATE TABLE IF NOT EXISTS public.platform_job_controls (
  job_name text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  active_driver text NOT NULL
    CHECK (active_driver IN ('worker', 'scheduler', 'operator')),
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_success_at timestamptz,
  last_status text
    CHECK (last_status IS NULL OR last_status IN ('running', 'success', 'failed', 'skipped')),
  last_run_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.platform_job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL REFERENCES public.platform_job_controls(job_name),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  driver text NOT NULL
    CHECK (driver IN ('worker', 'scheduler', 'operator')),
  lease_until timestamptz,
  checked integer CHECK (checked IS NULL OR checked >= 0),
  updated integer CHECK (updated IS NULL OR updated >= 0),
  error text,
  support_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_platform_job_runs_job_started
  ON public.platform_job_runs (job_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_job_runs_status_started
  ON public.platform_job_runs (status, started_at DESC);

COMMENT ON TABLE public.platform_job_controls IS
  'One row per scheduled job: whether it may run, which runner class owns it, and the live lease.';
COMMENT ON TABLE public.platform_job_runs IS
  'Append-only attempt ledger. A refused attempt is recorded as a skipped run, so a job that never runs is visible.';
COMMENT ON COLUMN public.platform_job_runs.driver IS
  'Neutral runner class of the attempt. The concrete adapter, if any, lives in metadata as evidence.';

CREATE OR REPLACE FUNCTION public.platform_claim_job_run(
  p_job_name text,
  p_driver text,
  p_lease_seconds integer DEFAULT 900,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  acquired boolean,
  run_id uuid,
  reason text,
  lease_until timestamptz
)
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_control public.platform_job_controls%ROWTYPE;
  v_job_name text := btrim(COALESCE(p_job_name, ''));
  v_driver text := COALESCE(NULLIF(btrim(p_driver), ''), 'worker');
  v_lease_seconds integer;
  v_run_id uuid;
  v_now timestamptz := now();
  v_metadata jsonb := COALESCE(p_metadata, '{}'::jsonb);
  v_lease_until timestamptz;
  v_refusal text;
BEGIN
  IF v_job_name = '' THEN
    RAISE EXCEPTION 'platform_job_name_required' USING ERRCODE = '22023';
  END IF;

  IF v_driver NOT IN ('worker', 'scheduler', 'operator') THEN
    RAISE EXCEPTION 'platform_job_invalid_driver' USING ERRCODE = '22023';
  END IF;

  v_lease_seconds := LEAST(GREATEST(COALESCE(p_lease_seconds, 900), 60), 3600);

  INSERT INTO public.platform_job_controls (job_name, active_driver)
  VALUES (v_job_name, v_driver)
  ON CONFLICT (job_name) DO NOTHING;

  -- The row lock IS the exclusivity. Everything below runs with the control row held.
  SELECT * INTO v_control
    FROM public.platform_job_controls
   WHERE public.platform_job_controls.job_name = v_job_name
     FOR UPDATE;

  v_lease_until := v_control.lease_until;
  v_refusal := CASE
    WHEN NOT v_control.enabled THEN 'job_disabled'
    WHEN v_control.active_driver <> v_driver THEN 'inactive_driver'
    WHEN v_lease_until IS NOT NULL AND v_lease_until > v_now THEN 'lease_active'
    ELSE NULL
  END;

  IF v_refusal IS NOT NULL THEN
    -- A refusal is still an attempt, and an attempt nobody records is an outage
    -- nobody can see. The refused run carries WHY, and the control row records that
    -- somebody tried; the live lease is left exactly as it was found.
    INSERT INTO public.platform_job_runs (
      job_name, status, driver, started_at, finished_at, lease_until, error, metadata
    )
    VALUES (
      v_job_name, 'skipped', v_driver, v_now, v_now,
      CASE WHEN v_refusal = 'lease_active' THEN v_lease_until ELSE NULL END,
      v_refusal,
      v_metadata || jsonb_build_object('activeDriver', v_control.active_driver, 'leaseOwner', v_control.lease_owner)
    )
    RETURNING id INTO v_run_id;

    UPDATE public.platform_job_controls
       SET updated_at = v_now,
           last_started_at = v_now,
           last_finished_at = v_now,
           last_status = 'skipped',
           last_run_id = v_run_id
     WHERE public.platform_job_controls.job_name = v_job_name;

    RETURN QUERY SELECT false, v_run_id, v_refusal,
      CASE WHEN v_refusal = 'lease_active' THEN v_lease_until ELSE NULL::timestamptz END;
    RETURN;
  END IF;

  v_run_id := gen_random_uuid();
  v_lease_until := v_now + make_interval(secs => v_lease_seconds);

  UPDATE public.platform_job_controls
     SET updated_at = v_now,
         lease_owner = v_driver,
         lease_token = v_run_id,
         lease_until = v_lease_until,
         last_started_at = v_now,
         last_status = 'running',
         last_run_id = v_run_id
   WHERE public.platform_job_controls.job_name = v_job_name;

  INSERT INTO public.platform_job_runs (
    id, job_name, status, driver, started_at, lease_until, metadata
  )
  VALUES (
    v_run_id, v_job_name, 'running', v_driver, v_now, v_lease_until, v_metadata
  );

  RETURN QUERY SELECT true, v_run_id, 'acquired', v_lease_until;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_finish_job_run_v2(
  p_job_name text,
  p_run_id uuid,
  p_status text,
  p_checked integer DEFAULT NULL,
  p_updated integer DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_support_code text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_now timestamptz := now();
  v_job_name text := btrim(COALESCE(p_job_name, ''));
  v_metadata jsonb := COALESCE(p_metadata, '{}'::jsonb);
  v_released boolean;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('success', 'failed') THEN
    RAISE EXCEPTION 'platform_job_invalid_finish_status' USING ERRCODE = '22023';
  END IF;

  -- The run row is always stamped, even by a runner whose lease is gone: a runner that
  -- lost its lease still owes the ledger the truth about what it did. Deliberately NOT
  -- guarded on `finished_at IS NULL` -- upstream re-stamps too, and a kernel that
  -- silently ignored a second finish would answer a different last-writer than the
  -- bundle it is compared against.
  UPDATE public.platform_job_runs
     SET status = p_status,
         finished_at = v_now,
         checked = p_checked,
         updated = p_updated,
         error = p_error,
         support_code = p_support_code,
         metadata = public.platform_job_runs.metadata || v_metadata
   WHERE id = p_run_id
     AND public.platform_job_runs.job_name = v_job_name;

  -- The lease is released ONLY by the token that holds it. This predicate is the fence.
  UPDATE public.platform_job_controls
     SET updated_at = v_now,
         lease_owner = NULL,
         lease_token = NULL,
         lease_until = NULL,
         last_finished_at = v_now,
         last_success_at = CASE WHEN p_status = 'success' THEN v_now ELSE last_success_at END,
         last_status = p_status,
         last_run_id = p_run_id
   WHERE public.platform_job_controls.job_name = v_job_name
     AND lease_token = p_run_id
   RETURNING true INTO v_released;

  RETURN COALESCE(v_released, false);
END;
$$;
