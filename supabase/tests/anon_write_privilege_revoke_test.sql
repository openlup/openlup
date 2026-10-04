-- Browser mutations remain denied; current server evidence writes stay callable.
BEGIN;
SELECT plan(21);

CREATE TEMP TABLE narrowed_table (
  ident text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO narrowed_table (ident) VALUES
  ('public.admin_users'),
  ('public.b2b_inquiries'),
  ('public.commerce_settings'),
  ('public.comms_notification_controls'),
  ('public.customer_external_refs'),
  ('public.customer_personalization'),
  ('public.email_sends'),
  ('public.email_templates'),
  ('public.email_webhook_attempts'),
  ('public.feedback'),
  ('public.notification_recipients'),
  ('public.order_line_pricing_breakdown'),
  ('public.payment_external_refs'),
  ('public.pet_personalizer_events'),
  ('public.price_entries'),
  ('public.price_lists'),
  ('public.promotion_redemptions'),
  ('public.promotions'),
  ('public.providers'),
  ('public.sample_requests'),
  ('public.settings'),
  ('public.shipment_external_refs'),
  ('public.shipping_rules'),
  ('public.subscription_cycles'),
  ('public.subscription_lines'),
  ('public.subscription_pause_windows'),
  ('public.subscription_price_agreements'),
  ('public.subscriptions'),
  ('public.testers'),
  ('public.variant_formats'),
  ('public.variant_unit_forms'),
  ('public.waitlist'),
  -- The four read-only rows: three retired intakes and the email-event ledger.
  ('public.email_events');

CREATE TEMP TABLE evidence_routine (
  ident text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO evidence_routine (ident) VALUES
  ('public.omnipack_record_stock_snapshot(text, text, integer, integer, integer, integer, integer, integer, integer, text, text, jsonb, text)');

SELECT is(
  (SELECT string_agg(ident, ', ' ORDER BY ident)
     FROM narrowed_table WHERE to_regclass(ident) IS NULL),
  NULL,
  'every pinned table identity resolves, so the privilege assertions cannot pass vacuously'
);

SELECT is(
  (SELECT count(*)::integer
     FROM evidence_routine AS routine
     JOIN pg_proc AS proc ON proc.oid = to_regprocedure(routine.ident)),
  1,
  'the pinned evidence-writing routine still exists, so the execute and security-context assertions cannot pass vacuously'
);

SELECT is(
  (SELECT count(*)::integer FROM narrowed_table),
  33,
  'the fixture pins all thirty-three tables this narrowing covers'
);

SELECT is(
  (SELECT string_agg(narrowed.ident || ':' || candidate.privilege, ', '
            ORDER BY narrowed.ident, candidate.privilege)
     FROM narrowed_table AS narrowed
     CROSS JOIN (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS candidate(privilege)
    WHERE has_table_privilege('anon', narrowed.ident, candidate.privilege)),
  NULL,
  'the unauthenticated role holds no UPDATE, DELETE or whole-table privilege on any of the thirty-three pinned tables'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.email_events', 'INSERT'),
  'the unauthenticated role cannot append to the email evidence ledger'
);

SELECT is(
  (SELECT string_agg(policy.schemaname || '.' || policy.tablename || ':' || policy.policyname, ', '
                     ORDER BY policy.schemaname, policy.tablename, policy.policyname)
     FROM pg_policies AS policy
    WHERE policy.schemaname = 'public'
      AND (policy.tablename, policy.policyname) IN (
        ('sample_requests', 'Anyone can submit a sample request'),
        ('testers', 'anon_insert_limited'),
        ('waitlist', 'anon_insert_waitlist')
      )),
  NULL,
  'the three obsolete anonymous legacy-intake insert policies are absent'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.email_events', 'INSERT'),
  'the signed-in browser role cannot append to the email evidence ledger'
);

SELECT is(
  (SELECT string_agg(routine.ident, ', ' ORDER BY routine.ident)
     FROM evidence_routine AS routine
    WHERE has_function_privilege('anon', to_regprocedure(routine.ident)::oid, 'execute')),
  NULL,
  'the unauthenticated role holds no execute privilege on the evidence-writing routine'
);

SELECT is(
  (SELECT string_agg(routine.ident, ', ' ORDER BY routine.ident)
     FROM evidence_routine AS routine
    WHERE has_function_privilege('authenticated', to_regprocedure(routine.ident)::oid, 'execute')),
  NULL,
  'the signed-in role holds no execute privilege on the evidence-writing routine'
);

SELECT is(
  (SELECT string_agg(routine.ident, ', ' ORDER BY routine.ident)
     FROM evidence_routine AS routine
    WHERE has_function_privilege('service_role', to_regprocedure(routine.ident)::oid, 'execute') IS NOT TRUE),
  NULL,
  'the runtime role retains execute on the evidence-writing routine, so the sync path still records a snapshot'
);

SELECT is(
  (SELECT string_agg(routine.ident, ', ' ORDER BY routine.ident)
     FROM evidence_routine AS routine
     JOIN pg_proc AS proc ON proc.oid = to_regprocedure(routine.ident)
    WHERE NOT proc.prosecdef),
  NULL,
  'the evidence-writing routine is still SECURITY DEFINER, so the narrowing cannot have broken a write path'
);

SELECT is(
  (SELECT string_agg(DISTINCT coalesce(nullif(acl.grantee::regrole::text, '-'), 'PUBLIC'), ', '
            ORDER BY coalesce(nullif(acl.grantee::regrole::text, '-'), 'PUBLIC'))
     FROM evidence_routine AS routine
     JOIN pg_proc AS proc ON proc.oid = to_regprocedure(routine.ident)
     CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS acl
    WHERE acl.privilege_type = 'EXECUTE'
      AND (acl.grantee = 0 OR acl.grantee::regrole::text IN ('anon', 'authenticated'))),
  NULL,
  'the routine grant list itself names no browser role and no PUBLIC execute grant'
);

-- The real stock writer requires its selected provider FK; this is rolled back.
INSERT INTO public.providers (kind, capability, display_name, status, enabled_for_region)
VALUES ('omnipack', 'fulfillment', 'Synthetic stock evidence provider', 'active', ARRAY['ZZ'])
ON CONFLICT (kind) DO NOTHING;

SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$SELECT public.omnipack_record_stock_snapshot(
    'synthetic-stock-evidence-write', 'SYNTHETIC-PACKAGING-NO-CATALOG',
    0, 0, 0, 0, 0, 0, 0, 'not_evaluated', 'synthetic-run', '{}', 'packaging')$$,
  'service_role executes the installed stock-evidence writer without provider access'
);

RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.omnipack_stock_snapshots
  WHERE idempotency_key = 'synthetic-stock-evidence-write'), 1,
  'owner witness observes the row written by the actual service-role RPC');

SET LOCAL ROLE anon;

SELECT throws_ok(
  $$UPDATE public.subscriptions SET status = 'rewritten'$$,
  '42501',
  NULL,
  'as the unauthenticated role, rewriting a subscription is refused by privilege rather than silently matching no rows'
);

SELECT throws_ok(
  $$DELETE FROM public.promotion_redemptions$$,
  '42501',
  NULL,
  'as the unauthenticated role, deleting redemption history is refused, so a spent promotion cannot be laundered'
);

SELECT throws_ok(
  $$TRUNCATE public.price_entries$$,
  '42501',
  NULL,
  'as the unauthenticated role, emptying the price entries table is refused by the withdrawn grant, which no policy could have done'
);

-- Inspect effective browser privileges rather than invoke the denied routine:
-- the managed permission-hint extension previously crashed on that invocation.
SELECT ok(
  NOT has_function_privilege(
    current_user,
    to_regprocedure('public.omnipack_record_stock_snapshot(text, text, integer, integer, integer, integer, integer, integer, integer, text, text, jsonb, text)')::oid,
    'execute'),
  'the effective principal of an unauthenticated session holds no execute on the evidence-writing routine'
);

SELECT throws_ok(
  $$INSERT INTO public.sample_requests (
       first_name, last_name, email, phone, address, postal_code, city, feedback
     ) VALUES (
       'privilege', 'probe', 'sample-privilege-probe@example.invalid', '000000000',
       'probe street', '00-000', 'probe city', 'privilege probe'
     )$$,
  '42501',
  NULL,
  'as the unauthenticated role, a valid retired sample-request append is refused'
);

SELECT throws_ok(
  $$INSERT INTO public.testers (
       first_name, last_name, email, phone, street, postal_code, city,
       gdpr_consent, verification_consent
     ) VALUES (
       'privilege', 'probe', 'tester-privilege-probe@example.invalid', '000000000',
       'probe street', '00-000', 'probe city', true, true
     )$$,
  '42501',
  NULL,
  'as the unauthenticated role, a valid retired tester-signup append is refused'
);

SELECT throws_ok(
  $$INSERT INTO public.waitlist (email, first_name)
     VALUES ('waitlist-privilege-probe@example.invalid', 'probe')$$,
  '42501',
  NULL,
  'as the unauthenticated role, a valid retired waitlist append is refused'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
