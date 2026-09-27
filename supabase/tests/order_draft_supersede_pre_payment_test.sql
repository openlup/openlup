-- pgTAP: stable-journey-key order-draft supersede (20260714201101).
--   * a fresh PRE-PAYMENT draft is superseded: order cancelled, pending draft-saved
--     outbox discarded, key dropped -> producer re-creates fresh under the same key.
--   * FORENSIC (Tomi): an UNPAID `pending_payment` order with a FAILED payment row and
--     a linked PROVISIONAL `pending_activation` subscription is superseded=true; the
--     subscription is cancelled SILENTLY (its subscription.cancelled outbox row is
--     'discarded', so no customer email dispatches); order cancelled; key dropped.
--   * MONEY MOVED: an order with a `succeeded` payment row is NOT superseded
--     (returns false, order + subscription untouched) — resume/duplicate-charge domain,
--     and its payment-ledger row keeps the key it was written under.
--   * LEDGER: a journey that opened a REAL intent and a REAL prepared attempt is
--     superseded, its `commerce_payment_state_transitions` rows are renamed in place
--     (same ids, `superseded:` prefix), and the re-drafted order opens its own intent
--     and prepares its own attempt under the SAME journey key. Without that rename the
--     second `create_intent` aborts with 23505 on
--     `commerce_payment_state_transitions_idempotency_key_key`.
--
-- Canonical order money freezes an order's money columns on UPDATE, so supersede does
-- status-only changes and never mutates money.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(28);

INSERT INTO public.clients (id, email)
VALUES ('21111111-1111-4000-8000-000000000001', 'order-draft-supersede@example.invalid');

-- ---- Draft 1: fresh pre-payment draft under the stable journey key -----------
CREATE TEMP TABLE _draft1 AS
SELECT public.commerce_create_order_draft_with_outbox(
  'journey-key-supersede-0001',
  '{"context":{"mode":"one_time"}}'::jsonb,
  '{
     "contractVersion": "commerce.v0", "source": "commerce.order_draft.bff.v0",
     "status": "draft", "paymentStatus": "not_started", "currency": "PLN", "taxIncluded": "true",
     "lines": [ { "sku": "ORG-SKU-1", "productSlug": "organic-prod", "quantity": 2,
         "unitPriceGross": {"amountMinor": 1340, "currency": "PLN"},
         "lineSubtotalGross": {"amountMinor": 2680, "currency": "PLN"},
         "tax": {"vatRateBps": 800,
           "netAmount": {"amountMinor": 2481, "currency": "PLN"},
           "vatAmount": {"amountMinor": 199, "currency": "PLN"},
           "grossAmount": {"amountMinor": 2680, "currency": "PLN"}} } ],
     "totals": {
       "subtotalGross": {"amountMinor": 2680, "currency": "PLN"},
       "discountTotalGross": {"amountMinor": 0, "currency": "PLN"},
       "netTotal": {"amountMinor": 2481, "currency": "PLN"},
       "taxTotal": {"amountMinor": 199, "currency": "PLN"},
       "totalGross": {"amountMinor": 2680, "currency": "PLN"} }
   }'::jsonb,
  '21111111-1111-4000-8000-000000000001'::uuid
) AS r;

CREATE TEMP TABLE _ids AS
SELECT replace((SELECT r #>> '{orderDraft,orderId}' FROM _draft1), 'order_', '')::uuid AS order1_id;

-- The journey's OTHER identity, as finalize writes it. Supersede cancels the order
-- this row names, and `cancelled` is on finalize's terminal allowlist — so leaving
-- the row standing is what refused the re-drafted order as `journey_consumed` and
-- forced the browser to rotate its journey key (20260903130000).
INSERT INTO public.commerce_idempotency_keys (scope, idempotency_key, request_fingerprint, status, metadata)
VALUES ('commerce.checkout_order_finalize', 'journey-key-supersede-0001', 'fp-finalize-0001', 'completed',
        jsonb_build_object('orderId', (SELECT order1_id FROM _ids)::text));

-- The journey's THIRD identity. `startRuntime` derives it as
-- `<journey>:payment-intent` and the intent RPC fingerprints over the order id, so a
-- row left standing here meets the re-drafted order with a different fingerprint and
-- raises `payment_control_intent_idempotency_conflict` - which no application code
-- handles. ⛔ The suffix literal is spelled here on purpose: it is the only place a
-- rename on either side of the TypeScript/SQL pair is caught (20260903220000).
INSERT INTO public.commerce_idempotency_keys (scope, idempotency_key, request_fingerprint, status, metadata)
VALUES ('commerce.payment_intent.create', 'journey-key-supersede-0001:payment-intent', 'fp-intent-0001', 'completed',
        jsonb_build_object('orderId', (SELECT order1_id FROM _ids)::text));
-- The journey's PREPARE identity, one call further down the same saga and the one an
-- enumeration missed. Both live providers take this path, and its RPC fingerprints
-- over the INTENT id, so a surviving row raises
-- `payment_control_provider_attempt_prepare_idempotency_conflict` — which maps to
-- `provider_attempt_in_flight` with a null order id, so nothing compensates and the
-- order is left finalized with reserved stock.
INSERT INTO public.commerce_idempotency_keys (scope, idempotency_key, request_fingerprint, status, metadata)
VALUES ('commerce.payment_attempt.prepare_provider', 'journey-key-supersede-0001:payment-execution:prepare-attempt', 'fp-prep-0001', 'completed',
        jsonb_build_object('orderId', (SELECT order1_id FROM _ids)::text));

CREATE TEMP TABLE _sup1 AS
SELECT public.commerce_supersede_pre_payment_order_draft('journey-key-supersede-0001') AS ok;

SELECT is((SELECT ok FROM _sup1), true,
  'supersede returns true for a fresh pre-payment draft');
SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = (SELECT order1_id FROM _ids)),
  'cancelled', 'the superseded pre-payment draft is cancelled');
SELECT is(
  (SELECT count(*)::int FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.order_draft.create' AND idempotency_key = 'journey-key-supersede-0001'),
  0, 'the idempotency-key row is dropped so the producer can re-create fresh');
SELECT is(
  (SELECT count(*)::int FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.checkout_order_finalize' AND idempotency_key = 'journey-key-supersede-0001'),
  0, 'the finalize identity is dropped too, so the re-drafted order is not refused journey_consumed');
SELECT is(
  (SELECT count(*)::int FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.payment_intent.create'
      AND idempotency_key = 'journey-key-supersede-0001:payment-intent'),
  0, 'the payment-intent identity is dropped too, so the re-drafted order opens its own intent');
SELECT is(
  (SELECT count(*)::int FROM public.commerce_idempotency_keys
    WHERE idempotency_key = 'journey-key-supersede-0001:payment-execution:prepare-attempt'),
  0, 'every DERIVED key is dropped, including the prepare identity an enumeration missed');
SELECT is(
  (SELECT status FROM public.outbox_events
    WHERE aggregate_id = (SELECT order1_id FROM _ids)
      AND event_type = 'commerce.order_draft.created'),
  'discarded', 'the pending draft-saved outbox event is discarded');

-- Re-create under the SAME key with an EDITED cart (different snapshot) succeeds.
CREATE TEMP TABLE _draft2 AS
SELECT public.commerce_create_order_draft_with_outbox(
  'journey-key-supersede-0001',
  '{"context":{"mode":"one_time"}}'::jsonb,
  '{
     "contractVersion": "commerce.v0", "source": "commerce.order_draft.bff.v0",
     "status": "draft", "paymentStatus": "not_started", "currency": "PLN", "taxIncluded": "true",
     "lines": [ { "sku": "ORG-SKU-1", "productSlug": "organic-prod", "quantity": 1,
         "unitPriceGross": {"amountMinor": 1340, "currency": "PLN"},
         "lineSubtotalGross": {"amountMinor": 1340, "currency": "PLN"},
         "tax": {"vatRateBps": 800,
           "netAmount": {"amountMinor": 1241, "currency": "PLN"},
           "vatAmount": {"amountMinor": 99, "currency": "PLN"},
           "grossAmount": {"amountMinor": 1340, "currency": "PLN"}} } ],
     "totals": {
       "subtotalGross": {"amountMinor": 1340, "currency": "PLN"},
       "discountTotalGross": {"amountMinor": 0, "currency": "PLN"},
       "netTotal": {"amountMinor": 1241, "currency": "PLN"},
       "taxTotal": {"amountMinor": 99, "currency": "PLN"},
       "totalGross": {"amountMinor": 1340, "currency": "PLN"} }
   }'::jsonb,
  '21111111-1111-4000-8000-000000000001'::uuid
) AS r;

SELECT isnt(
  replace((SELECT r #>> '{orderDraft,orderId}' FROM _draft2), 'order_', '')::uuid,
  (SELECT order1_id FROM _ids),
  'the re-created draft is a fresh, distinct order (edited cart, same key)');
SELECT is(
  (SELECT status FROM public.commerce_orders
    WHERE id = replace((SELECT r #>> '{orderDraft,orderId}' FROM _draft2), 'order_', '')::uuid),
  'draft', 'the re-created draft is a live draft');

-- ---- FORENSIC (Tomi): pending_payment + FAILED intent + provisional sub --------
INSERT INTO public.clients (id, email)
VALUES ('22222222-2222-4000-8000-000000000002', 'supersede-tomi@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type, name)
VALUES ('23222222-2222-4000-8000-000000000002', '22222222-2222-4000-8000-000000000002', 'dog', 'Tomi');
-- Provisional subscription created at finalize (pending_activation, carries pet_id).
INSERT INTO public.subscriptions (id, client_id, pet_id, cadence_days, currency, status)
VALUES ('24222222-2222-4000-8000-000000000002', '22222222-2222-4000-8000-000000000002',
        '23222222-2222-4000-8000-000000000002', 30, 'PLN', 'pending_activation');

CREATE TEMP TABLE _draftT AS
SELECT public.commerce_create_order_draft_with_outbox(
  'journey-key-supersede-tomi',
  '{"context":{"mode":"one_time"}}'::jsonb,
  '{
     "contractVersion": "commerce.v0", "source": "commerce.order_draft.bff.v0",
     "status": "draft", "paymentStatus": "not_started", "currency": "PLN", "taxIncluded": "true",
     "lines": [ { "sku": "ORG-SKU-1", "productSlug": "organic-prod", "quantity": 2,
         "unitPriceGross": {"amountMinor": 1340, "currency": "PLN"},
         "lineSubtotalGross": {"amountMinor": 2680, "currency": "PLN"},
         "tax": {"vatRateBps": 800,
           "netAmount": {"amountMinor": 2481, "currency": "PLN"},
           "vatAmount": {"amountMinor": 199, "currency": "PLN"},
           "grossAmount": {"amountMinor": 2680, "currency": "PLN"}} } ],
     "totals": {
       "subtotalGross": {"amountMinor": 2680, "currency": "PLN"},
       "discountTotalGross": {"amountMinor": 0, "currency": "PLN"},
       "netTotal": {"amountMinor": 2481, "currency": "PLN"},
       "taxTotal": {"amountMinor": 199, "currency": "PLN"},
       "totalGross": {"amountMinor": 2680, "currency": "PLN"} }
   }'::jsonb,
  '22222222-2222-4000-8000-000000000002'::uuid
) AS r;

CREATE TEMP TABLE _idsT AS
SELECT replace((SELECT r #>> '{orderDraft,orderId}' FROM _draftT), 'order_', '')::uuid AS orderT_id;

-- Advance to the forensic state: link the provisional subscription, move the order to
-- pending_payment (money columns untouched -> frozen trigger inert), attach a FAILED
-- payment row (0 zł moved).
UPDATE public.commerce_orders
   SET subscription_id = '24222222-2222-4000-8000-000000000002',
       status = 'pending_payment',
       metadata = metadata || jsonb_build_object('paymentStatus', 'pending')
 WHERE id = (SELECT orderT_id FROM _idsT);
INSERT INTO public.commerce_payments (order_id, provider, amount_cents, status)
VALUES ((SELECT orderT_id FROM _idsT), 'tpay', 2680, 'failed');

CREATE TEMP TABLE _supT AS
SELECT public.commerce_supersede_pre_payment_order_draft('journey-key-supersede-tomi') AS ok;

SELECT is((SELECT ok FROM _supT), true,
  'FORENSIC: unpaid pending_payment order with a FAILED payment is superseded (no deadlock)');
SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = '24222222-2222-4000-8000-000000000002'),
  'cancelled', 'the linked provisional subscription is cancelled');
SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = (SELECT orderT_id FROM _idsT)),
  'cancelled', 'the unpaid order is cancelled');
SELECT is(
  (SELECT status FROM public.outbox_events
    WHERE event_type = 'subscription.cancelled'
      AND idempotency_key = 'subscription_cancelled:24222222-2222-4000-8000-000000000002'),
  'discarded',
  'the subscription.cancelled outbox row is discarded (no customer email dispatched)');
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'subscription.cancelled'
      AND idempotency_key = 'subscription_cancelled:24222222-2222-4000-8000-000000000002'
      AND status = 'pending'),
  0, 'no pending subscription.cancelled event exists (silent supersede)');

-- ---- MONEY MOVED: a succeeded payment must NOT be superseded --------------------
INSERT INTO public.clients (id, email)
VALUES ('25333333-3333-4000-8000-000000000003', 'supersede-paid@example.invalid');
INSERT INTO public.pets (id, client_id, pet_type, name)
VALUES ('26333333-3333-4000-8000-000000000003', '25333333-3333-4000-8000-000000000003', 'dog', 'Paid');
INSERT INTO public.subscriptions (id, client_id, pet_id, cadence_days, currency, status)
VALUES ('27333333-3333-4000-8000-000000000003', '25333333-3333-4000-8000-000000000003',
        '26333333-3333-4000-8000-000000000003', 30, 'PLN', 'pending_activation');

CREATE TEMP TABLE _draftP AS
SELECT public.commerce_create_order_draft_with_outbox(
  'journey-key-supersede-paid',
  '{"context":{"mode":"one_time"}}'::jsonb,
  '{
     "contractVersion": "commerce.v0", "source": "commerce.order_draft.bff.v0",
     "status": "draft", "paymentStatus": "not_started", "currency": "PLN", "taxIncluded": "true",
     "lines": [ { "sku": "ORG-SKU-1", "productSlug": "organic-prod", "quantity": 1,
         "unitPriceGross": {"amountMinor": 990, "currency": "PLN"},
         "lineSubtotalGross": {"amountMinor": 990, "currency": "PLN"},
         "tax": {"vatRateBps": 800,
           "netAmount": {"amountMinor": 917, "currency": "PLN"},
           "vatAmount": {"amountMinor": 73, "currency": "PLN"},
           "grossAmount": {"amountMinor": 990, "currency": "PLN"}} } ],
     "totals": {
       "subtotalGross": {"amountMinor": 990, "currency": "PLN"},
       "discountTotalGross": {"amountMinor": 0, "currency": "PLN"},
       "netTotal": {"amountMinor": 917, "currency": "PLN"},
       "taxTotal": {"amountMinor": 73, "currency": "PLN"},
       "totalGross": {"amountMinor": 990, "currency": "PLN"} }
   }'::jsonb,
  '25333333-3333-4000-8000-000000000003'::uuid
) AS r;

CREATE TEMP TABLE _idsP AS
SELECT replace((SELECT r #>> '{orderDraft,orderId}' FROM _draftP), 'order_', '')::uuid AS orderP_id;

UPDATE public.commerce_orders
   SET subscription_id = '27333333-3333-4000-8000-000000000003',
       status = 'pending_payment',
       metadata = metadata || jsonb_build_object('paymentStatus', 'pending')
 WHERE id = (SELECT orderP_id FROM _idsP);
-- The payment-intent identity of this journey is opened FOR REAL, so the journey also
-- owns a `commerce_payment_state_transitions` row under
-- `journey-key-supersede-paid:payment-intent:intent_created`. Amount and currency are
-- read off the order so this fixture states no money vocabulary of its own.
CREATE TEMP TABLE _intentP AS
SELECT (public.commerce_payment_control_create_intent(
  'journey-key-supersede-paid:payment-intent',
  'one_time_order',
  (SELECT orderP_id FROM _idsP),
  NULL,
  NULL,
  (SELECT total_cents FROM public.commerce_orders WHERE id = (SELECT orderP_id FROM _idsP)),
  (SELECT currency FROM public.commerce_orders WHERE id = (SELECT orderP_id FROM _idsP)),
  '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

-- Money MOVED: a captured/succeeded payment row exists.
INSERT INTO public.commerce_payments (order_id, provider, amount_cents, status)
VALUES ((SELECT orderP_id FROM _idsP), 'tpay', 990, 'succeeded');
-- This journey also has a finalize identity. A refusal must keep BOTH rows: dropping
-- either one would let a journey that already took money be finalized a second time.
INSERT INTO public.commerce_idempotency_keys (scope, idempotency_key, request_fingerprint, status, metadata)
VALUES ('commerce.checkout_order_finalize', 'journey-key-supersede-paid', 'fp-finalize-paid', 'completed',
        jsonb_build_object('orderId', (SELECT orderP_id FROM _idsP)::text));
-- (the `commerce.payment_intent.create` row for this journey was written by the real
-- create_intent call above, not by hand.)
INSERT INTO public.commerce_idempotency_keys (scope, idempotency_key, request_fingerprint, status, metadata)
VALUES ('commerce.payment_attempt.prepare_provider', 'journey-key-supersede-paid:payment-execution:prepare-attempt', 'fp-prep-paid', 'completed',
        jsonb_build_object('orderId', (SELECT orderP_id FROM _idsP)::text));

SELECT is(
  public.commerce_supersede_pre_payment_order_draft('journey-key-supersede-paid'),
  false, 'MONEY MOVED: a succeeded payment refuses supersede (returns false)');
SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = (SELECT orderP_id FROM _idsP)),
  'pending_payment', 'the paid order is left untouched (not cancelled)');
SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = '27333333-3333-4000-8000-000000000003'),
  'pending_activation', 'the subscription of a paid order is left untouched');
SELECT is(
  (SELECT count(*)::int FROM public.commerce_idempotency_keys
    WHERE idempotency_key = 'journey-key-supersede-paid'
      AND scope = 'commerce.order_draft.create'),
  1, 'MONEY MOVED: the draft identity survives the refusal');
SELECT is(
  (SELECT count(*)::int FROM public.commerce_idempotency_keys
    WHERE idempotency_key = 'journey-key-supersede-paid'
      AND scope = 'commerce.checkout_order_finalize'),
  1, 'MONEY MOVED: the finalize identity survives, so a paid journey stays un-finalizable');
-- ⛔ The widened DELETE must not reach a journey that took money. Dropping this row
-- would let a paid journey open a SECOND payment intent against the same order.
SELECT is(
  (SELECT count(*)::int FROM public.commerce_idempotency_keys
    WHERE idempotency_key = 'journey-key-supersede-paid:payment-intent'
      AND scope = 'commerce.payment_intent.create'),
  1, 'MONEY MOVED: the payment-intent identity survives the refusal too');
SELECT is(
  (SELECT count(*)::int FROM public.commerce_idempotency_keys
    WHERE idempotency_key = 'journey-key-supersede-paid:payment-execution:prepare-attempt'),
  1, 'MONEY MOVED: the prefix match does not reach a journey that took money either');
-- ⛔ The ledger rename must not reach a journey that took money either. A renamed row
-- would say the payment events of a LIVE journey belong to a superseded one.
SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_state_transitions
    WHERE idempotency_key = 'journey-key-supersede-paid:payment-intent:intent_created'),
  1, 'MONEY MOVED: the ledger row keeps the key it was written under');


-- ---- LEDGER: the transitions keys a superseded journey leaves behind ------------
-- The re-created draft above (`_draft2`, still under journey key
-- `journey-key-supersede-0001`) now walks the real saga: create_intent, then
-- prepare_provider_attempt. Both write an audit row into
-- `commerce_payment_state_transitions`, whose `idempotency_key` is UNIQUE and is
-- derived INSIDE SQL from the caller's key (`:intent_created`, `:attempt_prepared`).
-- Amount, currency and the attempt's provider are read off the rows the fixture
-- already built, so this section introduces no money or provider vocabulary of its own.
CREATE TEMP TABLE _ledger_ids AS
SELECT replace((SELECT r #>> '{orderDraft,orderId}' FROM _draft2), 'order_', '')::uuid AS order_a_id;

CREATE TEMP TABLE _ledger_intent_a AS
SELECT (public.commerce_payment_control_create_intent(
  'journey-key-supersede-0001:payment-intent',
  'one_time_order',
  (SELECT order_a_id FROM _ledger_ids),
  NULL,
  NULL,
  (SELECT total_cents FROM public.commerce_orders WHERE id = (SELECT order_a_id FROM _ledger_ids)),
  (SELECT currency FROM public.commerce_orders WHERE id = (SELECT order_a_id FROM _ledger_ids)),
  '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _ledger_prepared_a AS
SELECT public.commerce_payment_control_prepare_provider_attempt(
  'journey-key-supersede-0001:payment-execution:prepare-attempt',
  (SELECT intent_id FROM _ledger_intent_a),
  (SELECT provider FROM public.commerce_payments
    WHERE order_id = (SELECT order_a_id FROM _ledger_ids) ORDER BY created_at DESC LIMIT 1),
  'reference:attempt:ledger:1',
  'reference|ledger|1',
  'one_time_payment',
  NULL,
  '{"source":"pgTAP"}'::jsonb
) AS response;

-- The rows this journey now owns, captured by id so the rename can be shown to KEEP
-- them rather than delete them.
CREATE TEMP TABLE _ledger_before AS
SELECT id, idempotency_key
  FROM public.commerce_payment_state_transitions
 WHERE left(idempotency_key, length('journey-key-supersede-0001') + 1) = 'journey-key-supersede-0001:';

SELECT is((SELECT count(*)::int FROM _ledger_before), 2,
  'the journey leaves two ledger rows: the created intent and the prepared attempt');

SELECT is(
  public.commerce_supersede_pre_payment_order_draft('journey-key-supersede-0001'),
  true, 'a journey that opened a REAL intent and attempt is still superseded');

SELECT is(
  (SELECT count(*)::int
     FROM public.commerce_payment_state_transitions t
     JOIN _ledger_before b ON b.id = t.id
    WHERE t.idempotency_key = 'superseded:' || t.id::text || ':' || b.idempotency_key),
  2, 'every ledger row is RENAMED in place: same id, same trail, `superseded:` prefix');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_state_transitions
    WHERE left(idempotency_key, length('journey-key-supersede-0001') + 1) = 'journey-key-supersede-0001:'),
  0, 'no ledger row still holds a key derived from the superseded journey');

-- The resubmit: the identical draft under the same journey key, then the same two RPCs.
-- ⛔ Without the rename above, the create_intent below aborts with 23505 on
-- `commerce_payment_state_transitions_idempotency_key_key` — the raw failure five
-- production buyers met, one statement after every idempotency-key row was dropped.
CREATE TEMP TABLE _draft3 AS
SELECT public.commerce_create_order_draft_with_outbox(
  'journey-key-supersede-0001',
  (SELECT metadata->'quoteSnapshot' FROM public.commerce_orders WHERE id = (SELECT order_a_id FROM _ledger_ids)),
  (SELECT metadata->'orderDraftSnapshot' FROM public.commerce_orders WHERE id = (SELECT order_a_id FROM _ledger_ids)),
  '21111111-1111-4000-8000-000000000001'::uuid
) AS r;

CREATE TEMP TABLE _ledger_ids_b AS
SELECT replace((SELECT r #>> '{orderDraft,orderId}' FROM _draft3), 'order_', '')::uuid AS order_b_id;

SELECT lives_ok(
  $$SELECT public.commerce_payment_control_create_intent(
      'journey-key-supersede-0001:payment-intent',
      'one_time_order',
      (SELECT order_b_id FROM _ledger_ids_b),
      NULL,
      NULL,
      (SELECT total_cents FROM public.commerce_orders WHERE id = (SELECT order_b_id FROM _ledger_ids_b)),
      (SELECT currency FROM public.commerce_orders WHERE id = (SELECT order_b_id FROM _ledger_ids_b)),
      '{}'::jsonb)$$,
  'the re-drafted order opens its own intent under the SAME journey key');

CREATE TEMP TABLE _ledger_intent_b AS
SELECT id AS intent_id FROM public.commerce_payment_intents
 WHERE order_id = (SELECT order_b_id FROM _ledger_ids_b);

SELECT lives_ok(
  $$SELECT public.commerce_payment_control_prepare_provider_attempt(
      'journey-key-supersede-0001:payment-execution:prepare-attempt',
      (SELECT intent_id FROM _ledger_intent_b),
      (SELECT provider FROM public.commerce_payments
        WHERE order_id = (SELECT order_b_id FROM _ledger_ids_b) ORDER BY created_at DESC LIMIT 1),
      'reference:attempt:ledger:2',
      'reference|ledger|2',
      'one_time_payment',
      NULL,
      '{"source":"pgTAP"}'::jsonb)$$,
  'and prepares its own provider attempt one call further down the same saga');

SELECT * FROM finish();
ROLLBACK;
