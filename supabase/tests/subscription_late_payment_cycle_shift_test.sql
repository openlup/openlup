-- pgTAP: a late renewal payment shifts the subscription cycle, and never pulls it in.
--
-- Property matrix over the ONE expression 20260826100000 changed inside
-- `commerce_payment_control_apply_before_sub_lock`:
--
--     next_cycle_at := GREATEST(next_cycle_at, scheduled_at
--       + make_interval(days => whole_days_late + cadence_days))
--
-- The matrix is 7 lateness values x 3 cadences x 2 starting anchors = 42 cells,
-- and every cell is driven through the REAL RPC chain (create intent, record
-- attempt, apply result) rather than through a restatement of the arithmetic.
-- Each cell is asserted four ways: the exact anchor, `new >= old`,
-- `new >= scheduled_at + cadence`, and idempotence under a replayed webhook.
--
-- The two cells this suite exists to protect are called out by name below:
--   * a payment that settles TWO DAYS EARLY is a no-op, not a negative shift; and
--   * an anchor another rail already moved FURTHER OUT survives untouched.
-- Between them they falsify a sign error in either clamp, which is the failure
-- mode that would break the product invariant this rail is supposed to uphold.
--
-- Every scheduled_at here is deliberately in 2020 so that even the +400d cell
-- settles in the past: `LEAST(p_occurred_at, now())` is then a no-op and the
-- expected values are fixed constants rather than clock arithmetic. The clamp
-- itself gets its own cell (L2) with a settlement dated a century out.
--
-- Run via: bash scripts/local-supabase-db-test.sh supabase/tests/subscription_late_payment_cycle_shift_test.sql

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(186);

-- The delivery-alignment rail judges renewal cycle INSERTs when it is armed. This
-- suite is about the payment anchor, not about admission, so the rail is parked
-- for the duration of the fixture. The transaction rolls back, so nothing here
-- outlives the file.
UPDATE public.subscription_delivery_alignment_control SET mode = 'off' WHERE singleton;

INSERT INTO public.clients (id, email)
VALUES ('e1000000-0000-4000-8000-000000000001', 'late-payment-shift@example.invalid');
INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code)
VALUES ('e1100000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
        'shipping', 'Testowa 1', 'Testowo', '00-001');
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('e1200000-0000-4000-8000-000000000001', 'late-payment-shift-product', 'Late payment shift product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('e1300000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000001',
        'LATE-PAYMENT-SHIFT-SKU', 'Late payment shift SKU', 'dog', 'active', 400, 350);

-- ---------------------------------------------------------------------------
-- The matrix. `in_matrix` marks the 42 combinatorial cells; L1 and L2 are two
-- named single-purpose cells that do not belong to the cross product.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE lp_case (
  n integer PRIMARY KEY,
  in_matrix boolean NOT NULL,
  label text NOT NULL,
  cadence integer NOT NULL,
  scheduled_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL,
  prior_anchor timestamptz,
  expected timestamptz,
  lateness_days integer NOT NULL,
  subscription_id uuid,
  cycle_id uuid,
  order_id uuid,
  actual timestamptz,
  replay_actual timestamptz
);

INSERT INTO lp_case (n, in_matrix, label, cadence, scheduled_at, occurred_at, prior_anchor, expected, lateness_days)
SELECT
  row_number() OVER (ORDER BY lateness.ordinal, cadence.days, anchor.ordinal)::int,
  true,
  format('%s, cadence %s, anchor %s', lateness.name, cadence.days, anchor.name),
  cadence.days,
  '2020-06-01T09:15:00Z'::timestamptz,
  '2020-06-01T09:15:00Z'::timestamptz + make_interval(secs => lateness.offset_seconds::double precision),
  CASE anchor.ordinal
    WHEN 1 THEN '2020-06-01T09:15:00Z'::timestamptz
    ELSE '2020-06-01T09:15:00Z'::timestamptz + make_interval(days => 900)
  END,
  CASE anchor.ordinal
    WHEN 1 THEN '2020-06-01T09:15:00Z'::timestamptz
      + make_interval(days => lateness.whole_days + cadence.days)
    ELSE '2020-06-01T09:15:00Z'::timestamptz + make_interval(days => 900)
  END,
  lateness.whole_days
FROM (VALUES
  (1, 'two days early',      -172800.0, 0),
  (2, 'settled on time',            0.0, 0),
  (3, 'thirty minutes late',     1800.0, 0),
  (4, '23h59m late',            86340.0, 0),
  (5, 'one day late',           86400.0, 1),
  (6, 'eleven days late',      950400.0, 11),
  (7, 'four hundred days late', 34560000.0, 400)
) AS lateness(ordinal, name, offset_seconds, whole_days)
CROSS JOIN (VALUES (14), (21), (28)) AS cadence(days)
CROSS JOIN (VALUES (1, 'at the scheduled date'), (2, 'already moved later')) AS anchor(ordinal, name);

-- L1: no anchor at all. GREATEST ignores NULL operands, so the computed value
-- must still land rather than the write collapsing to NULL.
INSERT INTO lp_case (n, in_matrix, label, cadence, scheduled_at, occurred_at, prior_anchor, expected, lateness_days)
VALUES (43, false, 'L1 no prior anchor', 28, '2020-06-01T09:15:00Z',
        '2020-06-12T09:15:00Z', NULL,
        '2020-06-01T09:15:00Z'::timestamptz + make_interval(days => 39), 11);

-- L2: a settlement timestamp a century in the future is caller-supplied data.
-- `LEAST(p_occurred_at, now())` must bound it; the expectation is therefore
-- computed from the clock at assertion time rather than pinned.
INSERT INTO lp_case (n, in_matrix, label, cadence, scheduled_at, occurred_at, prior_anchor, expected, lateness_days)
VALUES (44, false, 'L2 settlement dated a century out', 28, '2020-06-01T09:15:00Z',
        '2120-06-01T09:15:00Z', '2020-06-01T09:15:00Z', NULL, 0);

-- ---------------------------------------------------------------------------
-- One subscription, one renewal cycle and one order per cell.
-- ---------------------------------------------------------------------------
UPDATE lp_case SET
  subscription_id = ('e2000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  cycle_id        = ('e3000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid,
  order_id        = ('e4000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid;

INSERT INTO public.subscriptions (
  id, client_id, shipping_address_id, cadence_days, currency, status,
  next_cycle_at, payment_method_ref, payment_method_kind
)
SELECT c.subscription_id, 'e1000000-0000-4000-8000-000000000001',
       'e1100000-0000-4000-8000-000000000001', c.cadence, 'XTS', 'active',
       c.prior_anchor, 'pm-late-payment-' || c.n::text, 'card'
  FROM lp_case c;

INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version)
SELECT ('e1400000-0000-4000-8000-' || lpad(to_hex(c.n), 12, '0'))::uuid, c.subscription_id,
       'e1300000-0000-4000-8000-000000000001', 1, 1, false, 1
  FROM lp_case c;

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, template_snapshot
)
SELECT c.cycle_id, c.subscription_id, 2, c.scheduled_at, 'payment_pending',
       'late-payment-shift-' || c.n::text,
       public.subscription_current_template_snapshot(c.subscription_id)
  FROM lp_case c;

INSERT INTO public.commerce_orders (
  id, client_id, shipping_address_id, status, currency, subtotal_cents, total_cents,
  mode, subscription_id, subscription_cycle_id
)
SELECT c.order_id, 'e1000000-0000-4000-8000-000000000001',
       'e1100000-0000-4000-8000-000000000001', 'pending_payment', 'XTS', 2680, 2680,
       'subscription_cycle', c.subscription_id, c.cycle_id
  FROM lp_case c;

UPDATE public.subscription_cycles c
   SET order_id = k.order_id
  FROM lp_case k
 WHERE c.id = k.cycle_id;

-- ---------------------------------------------------------------------------
-- Drive every cell through the real payment-control chain, twice. The second
-- apply reuses the SAME idempotency key and the SAME fingerprint, which is what
-- a re-delivered provider webhook looks like.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  r record;
  v_intent uuid;
BEGIN
  FOR r IN SELECT * FROM lp_case ORDER BY n LOOP
    v_intent := (public.commerce_payment_control_create_intent(
      'late-payment-intent-' || r.n::text, 'subscription_cycle', r.order_id,
      r.subscription_id, r.cycle_id, 2680, 'XTS', '{}'::jsonb
    ) -> 'paymentIntent' ->> 'id')::uuid;

    PERFORM public.commerce_payment_control_record_attempt(
      'late-payment-attempt-' || r.n::text, v_intent, 'proof_channel', NULL, NULL,
      'sent_to_provider', NULL, '{}'::jsonb, '{}'::jsonb);

    PERFORM public.commerce_payment_control_apply_result(
      'late-payment-apply-' || r.n::text, v_intent, NULL, 'succeeded', r.occurred_at, NULL);
    UPDATE lp_case SET actual =
      (SELECT next_cycle_at FROM public.subscriptions WHERE id = r.subscription_id)
     WHERE n = r.n;

    PERFORM public.commerce_payment_control_apply_result(
      'late-payment-apply-' || r.n::text, v_intent, NULL, 'succeeded', r.occurred_at, NULL);
    UPDATE lp_case SET replay_actual =
      (SELECT next_cycle_at FROM public.subscriptions WHERE id = r.subscription_id)
     WHERE n = r.n;
  END LOOP;
END
$do$;

-- ===========================================================================
-- 42 cells x 4 properties.
-- ===========================================================================
SELECT is(c.actual, c.expected, format('cell %s: %s -> exact anchor', c.n, c.label))
  FROM lp_case c WHERE c.in_matrix ORDER BY c.n;

SELECT ok(c.actual >= c.prior_anchor,
          format('cell %s: %s -> new anchor is never earlier than the old one', c.n, c.label))
  FROM lp_case c WHERE c.in_matrix ORDER BY c.n;

SELECT ok(c.actual >= c.scheduled_at + make_interval(days => c.cadence),
          format('cell %s: %s -> new anchor is at least one whole cadence out', c.n, c.label))
  FROM lp_case c WHERE c.in_matrix ORDER BY c.n;

SELECT is(c.replay_actual, c.actual,
          format('cell %s: %s -> a replayed webhook moves nothing', c.n, c.label))
  FROM lp_case c WHERE c.in_matrix ORDER BY c.n;

-- ===========================================================================
-- The two guardian cells, named so a regression reads as what it is.
-- ===========================================================================
SELECT is(
  (SELECT actual FROM lp_case WHERE label = 'two days early, cadence 28, anchor at the scheduled date'),
  '2020-06-29T09:15:00Z'::timestamptz,
  'GUARDIAN: paying two days early is a no-op, not a two-day pull-in');

SELECT is(
  (SELECT actual FROM lp_case WHERE label = 'eleven days late, cadence 28, anchor already moved later'),
  '2020-06-01T09:15:00Z'::timestamptz + make_interval(days => 900),
  'GUARDIAN: an anchor another rail already moved further out survives untouched');

-- The zero-drift promise: an on-time settlement produces exactly what the rule
-- this migration replaced produced, to the second, including its time of day.
SELECT is(
  (SELECT actual FROM lp_case WHERE label = 'settled on time, cadence 28, anchor at the scheduled date'),
  '2020-06-29T09:15:00Z'::timestamptz,
  'an on-time settlement is byte-identical to the superseded rule');
SELECT is(
  (SELECT actual FROM lp_case WHERE label = '23h59m late, cadence 28, anchor at the scheduled date'),
  '2020-06-29T09:15:00Z'::timestamptz,
  'lateness truncates to whole days: 23h59m still lands on the original grid');

-- The business property, stated as the customer experiences it.
SELECT is(
  (SELECT extract(epoch FROM actual - scheduled_at)::int / 86400
     FROM lp_case WHERE label = 'eleven days late, cadence 28, anchor at the scheduled date'),
  39,
  'an eleven-day recovery restores the 28-day gap instead of compressing it to 17 days');

-- ===========================================================================
-- L1 / L2: the two clamps that the cross product cannot express.
-- ===========================================================================
SELECT is((SELECT actual FROM lp_case WHERE n = 43),
  '2020-07-10T09:15:00Z'::timestamptz,
  'L1: a subscription with no anchor yet still receives the computed date');

SELECT ok((SELECT actual FROM lp_case WHERE n = 44) < '2050-01-01T00:00:00Z'::timestamptz,
  'L2: a settlement dated a century out cannot push the next delivery a century out');
SELECT is((SELECT actual FROM lp_case WHERE n = 44),
  '2020-06-01T09:15:00Z'::timestamptz + make_interval(days =>
    floor(extract(epoch FROM (now() - '2020-06-01T09:15:00Z'::timestamptz)) / 86400.0)::int + 28),
  'L2: the future timestamp is clamped to now() before the lateness is measured');

-- ===========================================================================
-- The equality invariant the renewal lane depends on: the successor cycle is
-- scheduled at exactly the anchor this write produced.
-- ===========================================================================
INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, template_snapshot
)
SELECT ('e5000000-0000-4000-8000-' || lpad(to_hex(c.n), 12, '0'))::uuid, c.subscription_id, 3,
       (SELECT s.next_cycle_at FROM public.subscriptions s WHERE s.id = c.subscription_id),
       'payment_pending', 'late-payment-successor-' || c.n::text,
       public.subscription_current_template_snapshot(c.subscription_id)
  FROM lp_case c WHERE c.in_matrix;

SELECT is(
  (SELECT count(*)::int FROM lp_case c
     JOIN public.subscriptions s ON s.id = c.subscription_id
     JOIN public.subscription_cycles n3 ON n3.subscription_id = c.subscription_id AND n3.cycle_number = 3
    WHERE c.in_matrix AND s.next_cycle_at IS DISTINCT FROM n3.scheduled_at),
  0,
  'subscriptions.next_cycle_at equals the following cycle scheduled_at in all 42 cells');

-- ===========================================================================
-- The extended ledger: `basedOnScheduledAt` is KEPT, two keys are ADDED.
-- ===========================================================================
SELECT is(
  (SELECT (payload ->> 'basedOnScheduledAt')::timestamptz FROM public.subscription_events
    WHERE cycle_id = (SELECT cycle_id FROM lp_case WHERE label = 'eleven days late, cadence 28, anchor at the scheduled date')
      AND event_type = 'subscription.cycle_paid'),
  '2020-06-01T09:15:00Z'::timestamptz,
  'cycle_paid still reports the cycle scheduled date under its existing key');
SELECT is(
  (SELECT (payload ->> 'basedOnPaidAt')::timestamptz FROM public.subscription_events
    WHERE cycle_id = (SELECT cycle_id FROM lp_case WHERE label = 'eleven days late, cadence 28, anchor at the scheduled date')
      AND event_type = 'subscription.cycle_paid'),
  '2020-06-12T09:15:00Z'::timestamptz,
  'cycle_paid now also reports when the money actually arrived');
SELECT is(
  (SELECT (payload ->> 'shiftedByDays')::int FROM public.subscription_events
    WHERE cycle_id = (SELECT cycle_id FROM lp_case WHERE label = 'eleven days late, cadence 28, anchor at the scheduled date')
      AND event_type = 'subscription.cycle_paid'),
  11,
  'cycle_paid names the shift in days so triage does not have to reconstruct it');
SELECT is(
  (SELECT (payload ->> 'shiftedByDays')::int FROM public.subscription_events
    WHERE cycle_id = (SELECT cycle_id FROM lp_case WHERE label = 'two days early, cadence 28, anchor at the scheduled date')
      AND event_type = 'subscription.cycle_paid'),
  0,
  'an early settlement reports a zero shift rather than a negative one');

-- ===========================================================================
-- Privilege readback. This block was written when the apply body was last
-- changed by a full-body CREATE OR REPLACE, which keeps the existing ACL, and it
-- pinned that the ACL had in fact survived -- because a DROP-and-recreate would
-- reset it to the schema default and hand PUBLIC an EXECUTE this function must
-- never have.
--
-- 20260826180000 is that DROP-and-recreate. It widened the parameter list to
-- carry the refusal's class, which CREATE OR REPLACE cannot do, so the ACL this
-- block used to watch survive was genuinely discarded and restated by hand. The
-- assertions therefore move to the SEVEN-argument identity: the same four facts
-- about the same function, now read off the identity that exists. What they
-- prove is strictly more than before -- previously that a seal was not disturbed,
-- now that a seal was correctly rebuilt from nothing.
-- ===========================================================================
SELECT ok(NOT has_function_privilege('anon',
  'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)', 'EXECUTE'),
  'ACL: anon holds no EXECUTE on the replaced apply body');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)', 'EXECUTE'),
  'ACL: authenticated holds no EXECUTE on the replaced apply body');
SELECT ok(NOT has_function_privilege('service_role',
  'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)', 'EXECUTE'),
  'ACL: service_role holds no EXECUTE either -- only the owner reaches this body');
SELECT is(
  (SELECT count(*)::int FROM pg_proc p, aclexplode(p.proacl) acl
    WHERE p.oid = 'public.commerce_payment_control_apply_before_sub_lock(text,uuid,uuid,text,timestamptz,text,text)'::regprocedure
      AND acl.grantee = 0),
  0,
  'ACL: PUBLIC holds no privilege on the replaced apply body');
-- The eight-argument form is the live entrypoint: 20260806120000 dropped the
-- six-argument one and re-granted this signature to service_role. 20260826180000
-- replaced its body again without touching its signature, so this grant is the
-- one that survived a CREATE OR REPLACE while the body above did not.
SELECT ok(has_function_privilege('service_role',
  'public.commerce_payment_control_apply_result(text,uuid,uuid,text,timestamptz,text,text,text)', 'EXECUTE'),
  'ACL: the service-role entrypoint that calls it still has its EXECUTE');

SELECT * FROM finish();
ROLLBACK;
