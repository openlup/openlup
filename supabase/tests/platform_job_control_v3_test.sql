-- pgTAP: neutral v3 accounting trigger-control contract.
BEGIN;
SELECT plan(25);

SELECT is(
  (SELECT allowed_trigger_kinds::text FROM public.platform_job_controls WHERE job_name = 'accounting-invoice-issue'),
  '{worker,scheduler}',
  'invoice issue explicitly allows worker and scheduler execution');
SELECT is(
  (SELECT allowed_trigger_kinds::text FROM public.platform_job_controls WHERE job_name = 'accounting-invoice-delivery'),
  '{worker,scheduler}',
  'invoice delivery explicitly allows worker and scheduler execution');
SELECT is(
  (SELECT allowed_trigger_kinds::text FROM public.platform_job_controls WHERE job_name = 'accounting-invoice-correction'),
  '{worker,scheduler}',
  'invoice correction explicitly allows worker and scheduler execution');
SELECT is(
  (SELECT allowed_trigger_kinds::text FROM public.platform_job_controls WHERE job_name = 'accounting-ksef-status'),
  '{scheduler}',
  'KSeF status allows only scheduler execution');
SELECT ok(
  NOT (SELECT enabled FROM public.platform_job_controls WHERE job_name = 'accounting-ksef-status'),
  'KSeF control remains disabled by default');

CREATE TEMP TABLE _disabled AS
SELECT * FROM public.platform_claim_job_run_v3(
  'accounting-invoice-issue', 'worker', 'node_worker', 60, '{}'::jsonb);
SELECT ok(NOT (SELECT acquired FROM _disabled), 'disabled accounting issue does not acquire');
SELECT is((SELECT reason FROM _disabled), 'job_disabled', 'disabled accounting issue reports job_disabled');
SELECT is(
  (SELECT trigger_kind FROM public.platform_job_runs WHERE id = (SELECT run_id FROM _disabled)),
  'worker',
  'disabled v3 run records the neutral trigger kind');
SELECT is(
  (SELECT invocation_source FROM public.platform_job_runs WHERE id = (SELECT run_id FROM _disabled)),
  'node_worker',
  'disabled v3 run records the invocation source as evidence');

UPDATE public.platform_job_controls
   SET enabled = true,
       lease_owner = NULL,
       lease_token = NULL,
       lease_until = NULL,
       lease_expires_at = NULL
 WHERE job_name = 'accounting-invoice-issue';

CREATE TEMP TABLE _worker AS
SELECT * FROM public.platform_claim_job_run_v3(
  'accounting-invoice-issue', 'worker', 'node_worker', 60, '{"test":true}'::jsonb);
SELECT ok((SELECT acquired FROM _worker), 'enabled worker claim acquires');
SELECT is(
  (SELECT trigger_kind FROM public.platform_job_runs WHERE id = (SELECT run_id FROM _worker)),
  'worker',
  'running ledger row stores worker trigger kind');
SELECT is(
  (SELECT invocation_source FROM public.platform_job_runs WHERE id = (SELECT run_id FROM _worker)),
  'node_worker',
  'running ledger row stores node worker source');

CREATE TEMP TABLE _scheduler_during_worker AS
SELECT * FROM public.platform_claim_job_run_v3(
  'accounting-invoice-issue', 'scheduler', 'vercel_cron', 60, '{}'::jsonb);
SELECT ok(NOT (SELECT acquired FROM _scheduler_during_worker), 'scheduler cannot duplicate an active worker lease');
SELECT is((SELECT reason FROM _scheduler_during_worker), 'lease_active', 'worker lease fences scheduler backstop');

SELECT ok(public.platform_finish_job_run_v3(
  'accounting-invoice-issue', (SELECT run_id FROM _worker), 'success', 1, 1, NULL, NULL, '{}'::jsonb),
  'v3 finish releases the owned lease');
SELECT is(
  (SELECT status FROM public.platform_job_runs WHERE id = (SELECT run_id FROM _worker)),
  'success',
  'v3 finish records success');
SELECT is(
  (SELECT lease_token FROM public.platform_job_controls WHERE job_name = 'accounting-invoice-issue'),
  NULL::uuid,
  'v3 finish clears the shared lease token');

CREATE TEMP TABLE _operator AS
SELECT * FROM public.platform_claim_job_run_v3(
  'accounting-invoice-issue', 'operator', 'admin_requeue', 60, '{}'::jsonb);
SELECT ok(NOT (SELECT acquired FROM _operator), 'operator is not an implicit bypass');
SELECT is((SELECT reason FROM _operator), 'trigger_kind_not_allowed', 'operator is rejected by accounting allowlist');

UPDATE public.platform_job_controls
   SET enabled = true,
       lease_owner = NULL,
       lease_token = NULL,
       lease_until = NULL,
       lease_expires_at = NULL
 WHERE job_name = 'accounting-ksef-status';
CREATE TEMP TABLE _ksef_worker AS
SELECT * FROM public.platform_claim_job_run_v3(
  'accounting-ksef-status', 'worker', 'node_worker', 60, '{}'::jsonb);
SELECT ok(NOT (SELECT acquired FROM _ksef_worker), 'KSeF worker invocation is rejected');
SELECT is((SELECT reason FROM _ksef_worker), 'trigger_kind_not_allowed', 'KSeF allows scheduler only');

SELECT throws_ok(
  $$ SELECT * FROM public.platform_claim_job_run_v3('accounting-invoice-issue', 'scheduler', '', 60, '{}'::jsonb) $$,
  '22023', 'platform_job_invocation_source_required', 'v3 requires an auditable invocation source');
SELECT throws_ok(
  $$ SELECT * FROM public.platform_claim_job_run_v3('unknown-v3-job', 'scheduler', 'node_cron', 60, '{}'::jsonb) $$,
  '22023', 'platform_job_v3_control_not_configured', 'v3 fails closed for a job without explicit trigger policy');
SELECT ok(
  NOT has_function_privilege('anon', 'public.platform_claim_job_run_v3(text,text,text,integer,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.platform_claim_job_run_v3(text,text,text,integer,jsonb)', 'EXECUTE'),
  'v3 claim remains service-role only');
SELECT ok(
  NOT has_function_privilege('anon', 'public.platform_finish_job_run_v3(text,uuid,text,integer,integer,text,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.platform_finish_job_run_v3(text,uuid,text,integer,integer,text,text,jsonb)', 'EXECUTE'),
  'v3 finish remains service-role only');

SELECT * FROM finish();
ROLLBACK;
