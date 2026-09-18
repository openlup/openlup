-- pgTAP: the invoice migration quiescence locks block legacy writers in the
-- same invoices -> outbox order used by request RPCs.

BEGIN;
SELECT plan(7);

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect(
  'canonical_rollout_writer',
  -- dblink executes inside the active Postgres container. Connect back to that
  -- same server instead of the host-mapped 55422 port: pooled verify slots use
  -- different host ports, which otherwise sends the writer to the shared DB.
  -- Use the server interface rather than loopback so pg_hba authenticates the
  -- supplied password (the postgres role is intentionally not a superuser).
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);

SAVEPOINT rollout_barrier;
LOCK TABLE public.accounting_invoices IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.accounting_invoice_issue_outbox IN SHARE ROW EXCLUSIVE MODE;

SELECT extensions.dblink_send_query(
  'canonical_rollout_writer',
  'WITH invoice_writer AS ('
  '  UPDATE public.accounting_invoices SET updated_at = updated_at WHERE false RETURNING 1'
  '), outbox_writer AS ('
  '  UPDATE public.accounting_invoice_issue_outbox SET created_at = created_at WHERE false RETURNING 1'
  ') SELECT 1 AS completed'
);
SELECT pg_sleep(0.05);
SELECT is(
  extensions.dblink_is_busy('canonical_rollout_writer'),
  1,
  'rollout invoice lock deterministically blocks a concurrent legacy writer before outbox'
);

ROLLBACK TO SAVEPOINT rollout_barrier;
SELECT is(
  (SELECT completed
     FROM extensions.dblink_get_result('canonical_rollout_writer') AS result(completed integer)),
  1,
  'legacy writer resumes only after the rollout barrier releases both locks'
);
SELECT count(*)
  FROM extensions.dblink_get_result('canonical_rollout_writer') AS drained(completed integer);

SELECT extensions.dblink_exec(
  'canonical_rollout_writer',
  'INSERT INTO public.commerce_orders ('
  '  id, order_number, status, currency, subtotal_cents, discount_cents,'
  '  shipping_cents, shipping_discount_cents, tax_cents, total_cents'
  ') VALUES ('
  '  ''ac000000-0000-4000-8000-000000000000'', ''ROLLOUT-LOCK-ORDER'','
  '  ''draft'', ''PLN'', 0, 0, 0, 0, 0, 0'
  '); INSERT INTO public.accounting_invoices ('
  '  id, order_id, order_ref, invoice_ref, status, currency, buyer_snapshot, order_snapshot,'
  '  tax_snapshot, lines_snapshot, total_net_cents, total_gross_cents,'
  '  provider_kind, document_kind, ksef_required, metadata'
  ') VALUES ('
  '  ''ac000000-0000-4000-8000-000000000001'','
  '  ''ac000000-0000-4000-8000-000000000000'', ''ROLLOUT-LOCK'', ''ROLLOUT-LOCK:issue'','
  '  ''draft'', ''PLN'', ''{}'', ''{}'', ''{}'', ''[]'', 0, 0,'
  '  ''fakturownia_test'', NULL, false, ''{}'''
  '); INSERT INTO public.accounting_invoice_issue_outbox ('
  '  id, invoice_id, provider_kind, status, next_attempt_at'
  ') VALUES ('
  '  ''ac000000-0000-4000-8000-000000000002'','
  '  ''ac000000-0000-4000-8000-000000000001'', ''fakturownia_test'','
  '  ''processing'', now() + interval ''5 minutes'''
  ')'
);

SELECT throws_ok(
  $$SELECT private.accounting_invoice_assert_issue_quiescent()$$,
  '55006',
  'accounting_invoice_rollout_active_processing_claim',
  'rollout aborts deterministically while a provider-success lease is active'
);
SELECT extensions.dblink_exec(
  'canonical_rollout_writer',
  'UPDATE public.accounting_invoice_issue_outbox '
  'SET next_attempt_at = now() - interval ''5 minutes'' '
  'WHERE id = ''ac000000-0000-4000-8000-000000000002'''
);
SELECT throws_ok(
  $$SELECT private.accounting_invoice_assert_issue_quiescent()$$,
  '55006',
  'accounting_invoice_rollout_active_processing_claim',
  'rollout also aborts for an expired processing claim until the worker state is explicitly drained'
);
SELECT extensions.dblink_exec(
  'canonical_rollout_writer',
  'UPDATE public.accounting_invoice_issue_outbox '
  'SET status = ''failed'', next_attempt_at = NULL '
  'WHERE id = ''ac000000-0000-4000-8000-000000000002'''
);

SAVEPOINT succeed_vs_rollout;
LOCK TABLE public.accounting_invoices IN SHARE ROW EXCLUSIVE MODE;
SELECT extensions.dblink_send_query(
  'canonical_rollout_writer',
  'SELECT public.accounting_invoice_issue_outbox_succeed('
  '  ''ac000000-0000-4000-8000-000000000002'','
  '  ''fv-rollout-lock'', ''FV/ROLLOUT/LOCK'', ''{}''::jsonb'
  ') AS result'
);
SELECT pg_sleep(0.05);
SELECT is(
  extensions.dblink_is_busy('canonical_rollout_writer'),
  1,
  'real provider-success finalization waits at the invoice lock'
);
SELECT lives_ok(
  $$SET LOCAL lock_timeout = '100ms';
    LOCK TABLE public.accounting_invoice_issue_outbox IN SHARE ROW EXCLUSIVE MODE$$,
  'blocked provider-success finalization does not hold the outbox in reverse order'
);
ROLLBACK TO SAVEPOINT succeed_vs_rollout;
SELECT is(
  (SELECT result#>>'{invoice,status}'
     FROM extensions.dblink_get_result('canonical_rollout_writer') AS response(result jsonb)),
  'draft',
  'provider-success finalization retries and completes after the rollout barrier releases'
);
SELECT count(*)
  FROM extensions.dblink_get_result('canonical_rollout_writer') AS drained(result jsonb);

SELECT extensions.dblink_exec(
  'canonical_rollout_writer',
  'DELETE FROM public.accounting_invoice_operations '
  'WHERE invoice_id = ''ac000000-0000-4000-8000-000000000001''; '
  'DELETE FROM public.accounting_invoice_issue_outbox '
  'WHERE id = ''ac000000-0000-4000-8000-000000000002''; '
  'DELETE FROM public.accounting_invoices '
  'WHERE id = ''ac000000-0000-4000-8000-000000000001''; '
  'DELETE FROM public.commerce_orders '
  'WHERE id = ''ac000000-0000-4000-8000-000000000000'''
);

SELECT extensions.dblink_disconnect('canonical_rollout_writer');
SELECT * FROM finish();
ROLLBACK;
