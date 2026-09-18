-- pgTAP: commerce returns R0 — request create (happy, idempotent replay, invalid order,
-- quantity-exceeds guard), approve (transition + replay + invalid-state), reject.
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT plan(11);

-- Seed a returnable paid order with one line (qty 3). Only metadata lacks a default.
INSERT INTO public.commerce_orders (id, status, metadata)
VALUES ('11110000-0000-0000-0000-0000000000a1', 'paid', '{}'::jsonb);
INSERT INTO public.commerce_order_items (id, order_id, quantity, unit_price_cents, total_cents, discount_allocated_cents, effective_total_cents, effective_net_cents, product_snapshot, variant_snapshot)
VALUES ('11110000-0000-0000-0000-0000000000b1', '11110000-0000-0000-0000-0000000000a1', 3, 1490, 4470, 0, 4470, round((4470)::numeric * 10000 / (10000 + (800)::integer))::integer,
        '{"sku":"OPENLUP-DOG-LAMB-CAN-400G"}'::jsonb, '{}'::jsonb);

-- 1. Create opens a 'requested' return (replayed=false).
SELECT is(
  public.commerce_return_request_create(
    'ret-idem-0000001', '11110000-0000-0000-0000-0000000000a1',
    '[{"orderItemId":"11110000-0000-0000-0000-0000000000b1","sku":"OPENLUP-DOG-LAMB-CAN-400G","quantity":2}]'::jsonb,
    'damaged', 'box crushed', NULL) ->> 'status',
  'requested', 'create opens a requested return');

-- 2. Exactly one return line persisted.
SELECT is(
  (SELECT count(*)::int FROM public.commerce_return_lines l
     JOIN public.commerce_return_requests r ON r.id = l.return_request_id
    WHERE r.idempotency_key = 'ret-idem-0000001'),
  1, 'create persists the return line');

-- 3. Replay on the same idempotency_key is idempotent (replayed=true, still one request).
SELECT is(
  public.commerce_return_request_create(
    'ret-idem-0000001', '11110000-0000-0000-0000-0000000000a1',
    '[{"orderItemId":"11110000-0000-0000-0000-0000000000b1","sku":"OPENLUP-DOG-LAMB-CAN-400G","quantity":2}]'::jsonb,
    'damaged', 'box crushed', NULL) ->> 'replayed',
  'true', 'create is idempotent on replay');
SELECT is(
  (SELECT count(*)::int FROM public.commerce_return_requests WHERE order_id = '11110000-0000-0000-0000-0000000000a1'),
  1, 'replay does not create a second request');

-- 4. Unknown order is rejected.
SELECT throws_ok(
  $$ SELECT public.commerce_return_request_create('ret-idem-0000002', '99990000-0000-0000-0000-000000009999',
       '[{"orderItemId":"11110000-0000-0000-0000-0000000000b1","quantity":1}]'::jsonb, 'damaged', NULL, NULL) $$,
  '22023', 'commerce_return_request_order_not_found', 'unknown order is rejected');

-- 5. Quantity exceeding the ordered quantity is rejected.
SELECT throws_ok(
  $$ SELECT public.commerce_return_request_create('ret-idem-0000003', '11110000-0000-0000-0000-0000000000a1',
       '[{"orderItemId":"11110000-0000-0000-0000-0000000000b1","quantity":5}]'::jsonb, 'damaged', NULL, NULL) $$,
  '22023', 'commerce_return_request_quantity_exceeds_ordered', 'quantity over ordered is rejected');

-- 6. Approve transitions requested -> approved.
SELECT is(
  public.commerce_return_approve(
    'appr-key-0000001',
    (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-idem-0000001'),
    '11110000-0000-0000-0000-0000000000c1', 'full', NULL, 'ok to return') ->> 'status',
  'approved', 'approve transitions to approved');
SELECT is(
  (SELECT status FROM public.commerce_return_requests WHERE idempotency_key = 'ret-idem-0000001'),
  'approved', 'request row is approved');

-- 7. Approve replay is idempotent.
SELECT is(
  public.commerce_return_approve(
    'appr-key-0000001',
    (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-idem-0000001'),
    '11110000-0000-0000-0000-0000000000c1', 'full', NULL, NULL) ->> 'replayed',
  'true', 'approve is idempotent on replay');

-- 8. Rejecting an already-approved request is an invalid state transition.
SELECT throws_ok(
  $$ SELECT public.commerce_return_reject('rej-key-00000001',
       (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-idem-0000001'),
       '11110000-0000-0000-0000-0000000000c1', NULL) $$,
  '22023', 'commerce_return_reject_invalid_state', 'cannot reject an approved return');

-- 9. A fresh requested return can be rejected.
SELECT public.commerce_return_request_create(
  'ret-idem-0000010', '11110000-0000-0000-0000-0000000000a1',
  '[{"orderItemId":"11110000-0000-0000-0000-0000000000b1","quantity":1}]'::jsonb, 'changed_mind', NULL, NULL);
SELECT is(
  public.commerce_return_reject(
    'rej-key-00000010',
    (SELECT id FROM public.commerce_return_requests WHERE idempotency_key = 'ret-idem-0000010'),
    '11110000-0000-0000-0000-0000000000c1', 'not eligible') ->> 'status',
  'rejected', 'a requested return can be rejected');

ROLLBACK;
