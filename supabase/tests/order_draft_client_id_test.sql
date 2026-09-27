-- pgTAP: order-draft producer persists the order client_id (20260613120000).
--   * calling the RPC WITH p_client_id => the commerce_orders row has that client_id
--     (ORGANIC checkout: recipient port can resolve clients.email)
--   * calling the 3-arg form (omit p_client_id) => the order row has client_id NULL
--     (anonymous /api/bff/commerce/order-draft: backward-compatible, unchanged)
--   * the outbox_events payload is unchanged: same keys, NO client_id key
--     (client_id lives on the order row only, resolved by the recipient port)
--   * outbox email semantics are marked as saved-draft, not paid confirmation
--   * the same client+snapshot only creates one outbox email event
--   * grants: anon and authenticated cannot EXECUTE the new 4-arg function
--
-- Run via: supabase test db

BEGIN;
SELECT plan(10);

-- ---- Fixture --------------------------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('11111111-1111-1111-1111-111111111111', 'order-draft-organic@example.invalid');

-- ---- Shared minimal-but-valid snapshots -----------------------------------
-- quote snapshot: only required to be a non-null jsonb object.
-- order-draft snapshot: must satisfy the validation block + supply totals keys
-- (subtotalGross/discountTotalGross/taxTotal/totalGross.amountMinor) and one
-- line with quantity + unitPriceGross/lineSubtotalGross.amountMinor.

-- ---- Call 1: WITH p_client_id (the ORGANIC checkout SAGA path) -------------
CREATE TEMP TABLE _organic AS
SELECT public.commerce_create_order_draft_with_outbox(
  'organic-idem-0001',
  '{"context":{"mode":"one_time"}}'::jsonb,
  '{
     "contractVersion": "commerce.v0",
     "source": "commerce.order_draft.bff.v0",
     "status": "draft",
     "paymentStatus": "not_started",
     "currency": "PLN",
     "taxIncluded": "true",
     "lines": [
       {
         "sku": "ORG-SKU-1",
         "productSlug": "organic-prod",
         "quantity": 2,
         "unitPriceGross": {"amountMinor": 1340, "currency": "PLN"},
         "lineSubtotalGross": {"amountMinor": 2680, "currency": "PLN"},
         "tax": {
           "vatRateBps": 800,
           "netAmount": {"amountMinor": 2481, "currency": "PLN"},
           "vatAmount": {"amountMinor": 199, "currency": "PLN"},
           "grossAmount": {"amountMinor": 2680, "currency": "PLN"}
         }
       }
     ],
     "totals": {
       "subtotalGross": {"amountMinor": 2680, "currency": "PLN"},
       "discountTotalGross": {"amountMinor": 0, "currency": "PLN"},
       "netTotal": {"amountMinor": 2481, "currency": "PLN"},
       "taxTotal": {"amountMinor": 199, "currency": "PLN"},
       "totalGross": {"amountMinor": 2680, "currency": "PLN"}
     }
   }'::jsonb,
  '11111111-1111-1111-1111-111111111111'::uuid
) AS r;

-- ---- Call 2: 3-arg form (anonymous order-draft route, client_id stays NULL) -
CREATE TEMP TABLE _anon AS
SELECT public.commerce_create_order_draft_with_outbox(
  'anon-idem-0001',
  '{"context":{"mode":"one_time"}}'::jsonb,
  '{
     "contractVersion": "commerce.v0",
     "source": "commerce.order_draft.bff.v0",
     "status": "draft",
     "paymentStatus": "not_started",
     "currency": "PLN",
     "taxIncluded": "true",
     "lines": [
       {
         "sku": "ANON-SKU-1",
         "productSlug": "anon-prod",
         "quantity": 1,
         "unitPriceGross": {"amountMinor": 990, "currency": "PLN"},
         "lineSubtotalGross": {"amountMinor": 990, "currency": "PLN"},
         "tax": {
           "vatRateBps": 800,
           "netAmount": {"amountMinor": 917, "currency": "PLN"},
           "vatAmount": {"amountMinor": 73, "currency": "PLN"},
           "grossAmount": {"amountMinor": 990, "currency": "PLN"}
         }
       }
     ],
     "totals": {
       "subtotalGross": {"amountMinor": 990, "currency": "PLN"},
       "discountTotalGross": {"amountMinor": 0, "currency": "PLN"},
       "netTotal": {"amountMinor": 917, "currency": "PLN"},
       "taxTotal": {"amountMinor": 73, "currency": "PLN"},
       "totalGross": {"amountMinor": 990, "currency": "PLN"}
     }
   }'::jsonb
) AS r;

-- ---- Resolve the created order UUIDs from the RPC response orderId ----------
-- response orderId is 'order_' || uuid; strip the prefix to get the row id.
CREATE TEMP TABLE _ids AS
SELECT
  replace((SELECT r #>> '{orderDraft,orderId}' FROM _organic), 'order_', '')::uuid AS organic_order_id,
  replace((SELECT r #>> '{orderDraft,orderId}' FROM _anon), 'order_', '')::uuid AS anon_order_id;

-- ---- Assertions -----------------------------------------------------------
SELECT is(
  (SELECT client_id FROM public.commerce_orders WHERE id = (SELECT organic_order_id FROM _ids)),
  '11111111-1111-1111-1111-111111111111'::uuid,
  'WITH p_client_id -> order row persists that client_id (recipient resolvable)');

SELECT is(
  (SELECT client_id FROM public.commerce_orders WHERE id = (SELECT anon_order_id FROM _ids)),
  NULL::uuid,
  '3-arg form -> order row client_id stays NULL (anonymous route unchanged)');

SELECT ok(
  NOT (
    (SELECT payload FROM public.outbox_events WHERE aggregate_id = (SELECT organic_order_id FROM _ids))
    ? 'client_id'
  ),
  'outbox payload carries NO client_id key (event contract unchanged)');

SELECT ok(
  (SELECT payload ? 'orderUuid' FROM public.outbox_events WHERE aggregate_id = (SELECT organic_order_id FROM _ids)),
  'outbox payload still carries orderUuid (recipient port resolves from it)');

SELECT ok(
  (SELECT payload ? 'orderId' FROM public.outbox_events WHERE aggregate_id = (SELECT organic_order_id FROM _ids)),
  'outbox payload still carries orderId');

SELECT is(
  (SELECT payload->>'emailIntent' FROM public.outbox_events WHERE aggregate_id = (SELECT organic_order_id FROM _ids)),
  'order_draft_saved',
  'outbox payload marks the email as saved-draft, not paid confirmation');

SELECT ok(
  (SELECT idempotency_key LIKE 'order_draft_saved:%'
     FROM public.outbox_events
    WHERE aggregate_id = (SELECT organic_order_id FROM _ids)),
  'outbox idempotency key is scoped to saved-draft email dedupe');

SELECT public.commerce_create_order_draft_with_outbox(
  'organic-idem-0002',
  '{"context":{"mode":"one_time"}}'::jsonb,
  '{
     "contractVersion": "commerce.v0",
     "source": "commerce.order_draft.bff.v0",
     "status": "draft",
     "paymentStatus": "not_started",
     "currency": "PLN",
     "taxIncluded": "true",
     "lines": [
       {
         "sku": "ORG-SKU-1",
         "productSlug": "organic-prod",
         "quantity": 2,
         "unitPriceGross": {"amountMinor": 1340, "currency": "PLN"},
         "lineSubtotalGross": {"amountMinor": 2680, "currency": "PLN"},
         "tax": {
           "vatRateBps": 800,
           "netAmount": {"amountMinor": 2481, "currency": "PLN"},
           "vatAmount": {"amountMinor": 199, "currency": "PLN"},
           "grossAmount": {"amountMinor": 2680, "currency": "PLN"}
         }
       }
     ],
     "totals": {
       "subtotalGross": {"amountMinor": 2680, "currency": "PLN"},
       "discountTotalGross": {"amountMinor": 0, "currency": "PLN"},
       "netTotal": {"amountMinor": 2481, "currency": "PLN"},
       "taxTotal": {"amountMinor": 199, "currency": "PLN"},
       "totalGross": {"amountMinor": 2680, "currency": "PLN"}
     }
   }'::jsonb,
  '11111111-1111-1111-1111-111111111111'::uuid
);

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE event_type = 'commerce.order_draft.created'
      AND idempotency_key = (
        SELECT idempotency_key
          FROM public.outbox_events
         WHERE aggregate_id = (SELECT organic_order_id FROM _ids)
      )),
  1,
  'same client+draft snapshot does not enqueue a duplicate saved-draft email');

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)',
    'EXECUTE'),
  'anon lacks EXECUTE on the 4-arg order-draft RPC');

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)',
    'EXECUTE'),
  'authenticated lacks EXECUTE on the 4-arg order-draft RPC');

SELECT * FROM finish();
ROLLBACK;
