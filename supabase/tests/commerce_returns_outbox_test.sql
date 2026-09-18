-- pgTAP: commerce returns outbox emit (R1 runtime semantics). R1 narrowed the trigger
-- (20260708130000_commerce_returns_promote_runtime) to emit ONLY the handled statuses
-- as explicit literals — commerce.return.approved / commerce.return.rejected — exactly
-- once via return_<status>:<id>. The other lifecycle statuses (requested/label_issued/
-- received/refunded) are NOT emitted until their handlers land in R2+. The legacy
-- dynamic 'commerce.return.' prefix stays registered as a dormant producer.
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(6);

INSERT INTO public.commerce_orders (id, status, metadata)
VALUES ('22220000-0000-0000-0000-0000000000a1', 'paid', '{}'::jsonb);
INSERT INTO public.commerce_order_items (id, order_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot, variant_snapshot)
VALUES ('22220000-0000-0000-0000-0000000000b1', '22220000-0000-0000-0000-0000000000a1', 2, 1490, 2980, 0, 2980, round((2980)::numeric * 10000 / (10000 + (800)::integer))::integer,
        '{"sku":"OPENLUP-DOG-BEEF-CAN-400G"}'::jsonb, '{}'::jsonb);

-- create does NOT emit in R1: 'requested' has no runtime handler yet, so the narrowed
-- trigger produces no outbox event for it (avoids an unclaimable blocking event).
SELECT public.commerce_return_request_create(
  'ret-emit-0000001', '22220000-0000-0000-0000-0000000000a1',
  '[{"orderItemId":"22220000-0000-0000-0000-0000000000b1","quantity":1}]'::jsonb, 'damaged', NULL, NULL);
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type LIKE 'commerce.return.%'
    AND aggregate_id = (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-emit-0000001')),
  0, 'create emits no return outbox event in R1 (requested is not handled yet)');

-- approve emits commerce.return.approved with the return_approved:<id> key.
SELECT public.commerce_return_approve(
  'appr-emit-0000001',
  (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-emit-0000001'),
  '22220000-0000-0000-0000-0000000000c1', 'full', NULL, NULL);
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events WHERE event_type = 'commerce.return.approved'
    AND aggregate_id = (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-emit-0000001')),
  1, 'approve emits commerce.return.approved');
SELECT is(
  (SELECT idempotency_key FROM public.outbox_events WHERE event_type = 'commerce.return.approved'
    AND aggregate_id = (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-emit-0000001')),
  'return_approved:' || (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-emit-0000001')::text,
  'approved event idempotency key is return_approved:<id>');

-- approve replay does not double-emit.
SELECT public.commerce_return_approve(
  'appr-emit-0000001',
  (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-emit-0000001'),
  '22220000-0000-0000-0000-0000000000c1', 'full', NULL, NULL);
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events WHERE event_type = 'commerce.return.approved'
    AND aggregate_id = (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-emit-0000001')),
  1, 'approve replay does not double-emit');

-- reject emits commerce.return.rejected on a fresh request.
SELECT public.commerce_return_request_create(
  'ret-emit-0000010', '22220000-0000-0000-0000-0000000000a1',
  '[{"orderItemId":"22220000-0000-0000-0000-0000000000b1","quantity":1}]'::jsonb, 'changed_mind', NULL, NULL);
SELECT public.commerce_return_reject(
  'rej-emit-0000010',
  (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-emit-0000010'),
  '22220000-0000-0000-0000-0000000000c1', NULL);
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events WHERE event_type = 'commerce.return.rejected'
    AND aggregate_id = (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-emit-0000010')),
  1, 'reject emits commerce.return.rejected');

-- the producer is registered DORMANT (no handler yet).
SELECT is(
  (SELECT count(*)::int FROM public.outbox_dormant_event_types WHERE event_type = 'commerce.return.'),
  1, 'commerce.return. producer is registered dormant');

ROLLBACK;
