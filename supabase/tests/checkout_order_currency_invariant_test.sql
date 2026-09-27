-- pgTAP: the two-part currency invariant on the two writers of canonical order money.
--
-- Covers what 20260816164246 changed and nothing else. The happy paths, the
-- persisted amounts, the allocation arithmetic and the outbox contract of both
-- RPCs stay pinned where they already were, in canonical_order_money_test.sql;
-- this suite proves the four things that migration is responsible for:
--
--   1. the two functions kept exactly the reach they had. The migration restates
--      no REVOKE and issues no GRANT, on the argument that CREATE OR REPLACE
--      preserves a function's ACL - so that argument is asserted rather than
--      trusted;
--   2. invariant 1 refuses a snapshot whose money nodes disagree, INSTEAD OF
--      normalising it to one of the currencies it found;
--   3. invariant 2 refuses a self-consistent snapshot in a currency this
--      deployment does not settle, under a DIFFERENT name, so the two faults are
--      distinguishable by an operator reading a log;
--   4. with the settlement row gone, both functions refuse rather than assuming.
--
-- The suite names no currency. It reads the deployment's own code through
-- platform_settlement_currency() and templates it into the snapshots, and uses
-- XTS - the ISO 4217 code reserved for testing, which no deployment settles in -
-- as the foreign one. That is also why the expected refusal messages are composed
-- at runtime instead of being written out: the text contains the deployment's
-- code, and hard-coding it here would put back the literal the migration removed.
--
-- Run via: npm run test:db:local

BEGIN;
SELECT plan(22);

-- The deployment's own code, captured once. It has to be captured rather than
-- called inline, because the fail-closed cases below delete the row it comes from
-- and still need to build a snapshot afterwards.
CREATE TEMP TABLE _platform AS SELECT public.platform_settlement_currency() AS code;
GRANT SELECT ON TABLE _platform TO service_role;

-- One known-good snapshot shape per RPC, currency-templated. The amounts are the
-- canonical fixture's: two lines at 4470 and 2980 minor units against an 800 bps
-- inclusive rate, a half-price discount, and a shipping charge fully cancelled by
-- a shipping discount - which is what puts BOTH shipping nodes in the snapshot,
-- so the mixed-currency case below can put the subtotal and the shipping in
-- different currencies exactly as the programme plan requires.
CREATE FUNCTION pg_temp.checkout_snapshot(p_currency text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT replace($json${
    "contractVersion":"commerce.v0",
    "source":"commerce.order_draft.bff.v0",
    "status":"draft",
    "paymentStatus":"not_started",
    "currency":"@CUR@",
    "taxIncluded":"true",
    "lines":[
      {
        "sku":"CURINV-A","productSlug":"curinv-a","quantity":3,
        "unitPriceGross":{"amountMinor":1490,"currency":"@CUR@"},
        "lineSubtotalGross":{"amountMinor":4470,"currency":"@CUR@"},
        "tax":{"vatRateBps":800,
          "netAmount":{"amountMinor":4139,"currency":"@CUR@"},
          "vatAmount":{"amountMinor":331,"currency":"@CUR@"},
          "grossAmount":{"amountMinor":4470,"currency":"@CUR@"}}
      },
      {
        "sku":"CURINV-B","productSlug":"curinv-b","quantity":2,
        "unitPriceGross":{"amountMinor":1490,"currency":"@CUR@"},
        "lineSubtotalGross":{"amountMinor":2980,"currency":"@CUR@"},
        "tax":{"vatRateBps":800,
          "netAmount":{"amountMinor":2759,"currency":"@CUR@"},
          "vatAmount":{"amountMinor":221,"currency":"@CUR@"},
          "grossAmount":{"amountMinor":2980,"currency":"@CUR@"}}
      }
    ],
    "totals":{
      "subtotalGross":{"amountMinor":7450,"currency":"@CUR@"},
      "discountTotalGross":{"amountMinor":3725,"currency":"@CUR@"},
      "shippingGross":{"amountMinor":1500,"currency":"@CUR@"},
      "shippingDiscountGross":{"amountMinor":1500,"currency":"@CUR@"},
      "netTotal":{"amountMinor":3449,"currency":"@CUR@"},
      "taxTotal":{"amountMinor":276,"currency":"@CUR@"},
      "totalGross":{"amountMinor":3725,"currency":"@CUR@"}
    }
  }$json$, '@CUR@', p_currency)::jsonb;
$fn$;

CREATE FUNCTION pg_temp.renewal_snapshot(p_currency text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT jsonb_set(
    jsonb_set(
      jsonb_set(pg_temp.checkout_snapshot(p_currency), '{source}', '"subscription.own_engine.v0"'),
      '{status}', '"pending_payment"'),
    '{paymentStatus}', '"pending"');
$fn$;

-- The message invariant 1 must produce, composed the way the body composes it:
-- the distinct set, sorted under the C collation the migration pins for exactly
-- this reason. Computing it here rather than writing it out keeps this file free
-- of a currency literal AND makes the assertion exact rather than a substring.
CREATE FUNCTION pg_temp.mixed_message(p_prefix text, p_other text)
RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT p_prefix || '_mixed_currency: ' || array_to_string(
    ARRAY(SELECT c FROM (VALUES ((SELECT code FROM _platform)), (p_other)) AS t(c)
           ORDER BY c COLLATE "C"), ', ');
$fn$;

-- ---- 1. reach is unchanged, which the migration asserts by omission ----------
SELECT ok(has_function_privilege('service_role',
  'public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)', 'EXECUTE'),
  'service_role still executes the order-draft writer after the body replace');
SELECT ok(NOT has_function_privilege('anon',
  'public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)', 'EXECUTE'),
  'anon still cannot execute the order-draft writer');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid)', 'EXECUTE'),
  'authenticated still cannot execute the order-draft writer');
SELECT ok(has_function_privilege('service_role',
  'public.subscription_create_cycle_order_with_outbox(text,uuid,integer,timestamptz,jsonb,jsonb,jsonb)',
  'EXECUTE'),
  'service_role still executes the cycle-order writer after the body replace');
SELECT ok(NOT has_function_privilege('anon',
  'public.subscription_create_cycle_order_with_outbox(text,uuid,integer,timestamptz,jsonb,jsonb,jsonb)',
  'EXECUTE'),
  'anon still cannot execute the cycle-order writer');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.subscription_create_cycle_order_with_outbox(text,uuid,integer,timestamptz,jsonb,jsonb,jsonb)',
  'EXECUTE'),
  'authenticated still cannot execute the cycle-order writer');

-- ---- 2. the happy path still works, executed as the principal the app uses ----
-- This is the case that settles the wave's riskiest assumption: the RPC is
-- definer-rights and the settlement reader it now calls is invoker-rights with
-- its PUBLIC execute grant revoked and no compensating GRANT. If the definer
-- could not reach the reader, this call raises instead of writing.
SET LOCAL ROLE service_role;
CREATE TEMP TABLE _accepted AS
SELECT public.commerce_create_order_draft_with_outbox(
  'currency-invariant-accepted-1',
  '{"contractVersion":"commerce.v0"}'::jsonb,
  pg_temp.checkout_snapshot((SELECT code FROM _platform))
) AS result;
RESET ROLE;

SELECT is(
  (SELECT result#>>'{orderDraft,status}' FROM _accepted),
  'draft',
  'a snapshot in the settled currency is still accepted, called as service_role');

SELECT is(
  (SELECT orders.currency
     FROM public.commerce_orders AS orders
    WHERE orders.id = (SELECT replace(result#>>'{orderDraft,orderId}', 'order_', '')::uuid
                         FROM _accepted)),
  (SELECT code FROM _platform),
  'the stored order carries the settled currency, written from the snapshot rather than a literal');

-- ---- 3. invariant 1: a mixed cart is refused, not normalised -----------------
-- Subtotal in the settled currency, shipping in another. Every amount still
-- closes arithmetically - that is the point. Before this migration the totals
-- guard caught this only because it compared each node to one hard-coded code;
-- the structural version catches it by counting.
SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
      'currency-invariant-mixed-1',
      '{"contractVersion":"commerce.v0"}'::jsonb,
      jsonb_set(
        pg_temp.checkout_snapshot((SELECT code FROM _platform)),
        '{totals,shippingGross,currency}', '"XTS"'))$$,
  '22023',
  pg_temp.mixed_message('commerce_order_draft', 'XTS'),
  'checkout refuses a snapshot whose subtotal and shipping are in different currencies');

SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_idempotency_keys
    WHERE scope = 'commerce.order_draft.create'
      AND idempotency_key = 'currency-invariant-mixed-1'),
  0,
  'the refused mixed cart left no idempotency row, so nothing was normalised and stored');

-- The same rule reaches into a line, which is where the old per-line guard lived.
SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
      'currency-invariant-mixed-line-1',
      '{"contractVersion":"commerce.v0"}'::jsonb,
      jsonb_set(
        pg_temp.checkout_snapshot((SELECT code FROM _platform)),
        '{lines,0,tax,vatAmount,currency}', '"XTS"'))$$,
  '22023',
  pg_temp.mixed_message('commerce_order_draft', 'XTS'),
  'checkout refuses a line money node in a different currency from the totals');

-- A money node carrying no currency at all is the same violation, and says so.
SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
      'currency-invariant-absent-1',
      '{"contractVersion":"commerce.v0"}'::jsonb,
      pg_temp.checkout_snapshot((SELECT code FROM _platform)) #- '{totals,taxTotal,currency}')$$,
  '22023',
  pg_temp.mixed_message('commerce_order_draft', '(absent)'),
  'checkout refuses a money node that carries no currency, and names it as absent');

-- ---- 4. invariant 2: a settled-shape cart in an unsettled currency -----------
-- Internally consistent - invariant 1 passes - and refused by the second rule
-- under its own name. This is the pair that makes the two faults distinguishable.
SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
      'currency-invariant-foreign-1',
      '{"contractVersion":"commerce.v0"}'::jsonb,
      pg_temp.checkout_snapshot('XTS'))$$,
  '22023',
  'commerce_order_draft_currency_not_accepted: XTS',
  'checkout refuses a self-consistent order in a currency this deployment does not settle');

-- ---- 5. renewal writer, same three rules ------------------------------------
-- The cycle writer reaches its currency invariants after locking the
-- subscription and before resolving any SKU, so the refusal cases need a client
-- and an active subscription and nothing else. The renewal HAPPY path, with its
-- full catalog and provider-stock fixture, is already pinned by
-- canonical_order_money_test.sql and is deliberately not duplicated here.
INSERT INTO public.clients (id, email)
VALUES ('c0000000-0000-4000-8000-0000000000c1', 'currency-invariant@example.invalid');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, region_code, status, next_cycle_at,
  template_version, payment_method_kind, payment_method_ref
) VALUES (
  'c0000000-0000-4000-8000-0000000000c2',
  'c0000000-0000-4000-8000-0000000000c1',
  14,
  (SELECT code FROM _platform),
  public.platform_region_code(),
  'active',
  '2026-09-01T10:00:00Z',
  1, 'card', 'pm_currency_invariant'
);

SELECT throws_ok(
  $$SELECT public.subscription_create_cycle_order_with_outbox(
      'currency-invariant-renewal-mixed-1',
      'c0000000-0000-4000-8000-0000000000c2',
      1,
      '2026-09-01T10:00:00Z'::timestamptz,
      '{"cadence_days":14,"lines":[{"sku":"CURINV-A","quantity":1}]}'::jsonb,
      '{"source":"checkout_order_currency_invariant_test"}'::jsonb,
      jsonb_set(
        pg_temp.renewal_snapshot((SELECT code FROM _platform)),
        '{totals,shippingGross,currency}', '"XTS"'))$$,
  '22023',
  pg_temp.mixed_message('subscription_cycle_order', 'XTS'),
  'renewal refuses a cycle order whose subtotal and shipping are in different currencies');

SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_idempotency_keys
    WHERE scope = 'subscription.cycle_order.create'
      AND idempotency_key = 'currency-invariant-renewal-mixed-1'),
  0,
  'the refused mixed renewal left no idempotency row');

SELECT throws_ok(
  $$SELECT public.subscription_create_cycle_order_with_outbox(
      'currency-invariant-renewal-line-1',
      'c0000000-0000-4000-8000-0000000000c2',
      1,
      '2026-09-01T10:00:00Z'::timestamptz,
      '{"cadence_days":14,"lines":[{"sku":"CURINV-A","quantity":1}]}'::jsonb,
      '{"source":"checkout_order_currency_invariant_test"}'::jsonb,
      jsonb_set(
        pg_temp.renewal_snapshot((SELECT code FROM _platform)),
        '{lines,1,lineSubtotalGross,currency}', '"XTS"'))$$,
  '22023',
  pg_temp.mixed_message('subscription_cycle_order', 'XTS'),
  'renewal refuses a line money node in a different currency from the totals');

SELECT throws_ok(
  $$SELECT public.subscription_create_cycle_order_with_outbox(
      'currency-invariant-renewal-foreign-1',
      'c0000000-0000-4000-8000-0000000000c2',
      1,
      '2026-09-01T10:00:00Z'::timestamptz,
      '{"cadence_days":14,"lines":[{"sku":"CURINV-A","quantity":1}]}'::jsonb,
      '{"source":"checkout_order_currency_invariant_test"}'::jsonb,
      pg_temp.renewal_snapshot('XTS'))$$,
  '22023',
  'subscription_cycle_order_currency_not_accepted: XTS',
  'renewal refuses a self-consistent cycle order in a currency this deployment does not settle');

-- ---- 6. the shape gate on the envelope still refuses pre-idempotency ---------
-- The envelope's currency check became a shape check rather than a value check.
-- A malformed code is still an invalid snapshot, refused under the name it always
-- had; only a well-formed-but-unsettled code moves to invariant 2 above.
SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
      'currency-invariant-malformed-1',
      '{"contractVersion":"commerce.v0"}'::jsonb,
      jsonb_set(pg_temp.checkout_snapshot((SELECT code FROM _platform)),
                '{currency}', '"xts"'))$$,
  '22023',
  'commerce_order_draft_invalid_snapshot',
  'checkout still refuses a malformed envelope currency as an invalid snapshot');

SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
      'currency-invariant-nocurrency-1',
      '{"contractVersion":"commerce.v0"}'::jsonb,
      pg_temp.checkout_snapshot((SELECT code FROM _platform)) #- '{currency}')$$,
  '22023',
  'commerce_order_draft_invalid_snapshot',
  'checkout still refuses a snapshot with no envelope currency at all');

-- ---- 7. fail-closed: no settlement row, no order ----------------------------
-- Checked last, because it removes the row every case above depends on. The
-- reader from 20260816152909 raises 55000 rather than defaulting, and this is the
-- assertion that the raise reaches the money path instead of being swallowed or
-- coalesced somewhere between the two.
DELETE FROM public.commerce_settings WHERE key = 'settlement_currency';

SELECT throws_ok(
  $$SELECT public.commerce_create_order_draft_with_outbox(
      'currency-invariant-unseeded-1',
      '{"contractVersion":"commerce.v0"}'::jsonb,
      pg_temp.checkout_snapshot((SELECT code FROM _platform)))$$,
  '55000',
  NULL,
  'checkout refuses every order while the settlement currency is unconfigured');

SELECT throws_ok(
  $$SELECT public.subscription_create_cycle_order_with_outbox(
      'currency-invariant-renewal-unseeded-1',
      'c0000000-0000-4000-8000-0000000000c2',
      1,
      '2026-09-01T10:00:00Z'::timestamptz,
      '{"cadence_days":14,"lines":[{"sku":"CURINV-A","quantity":1}]}'::jsonb,
      '{"source":"checkout_order_currency_invariant_test"}'::jsonb,
      pg_temp.renewal_snapshot((SELECT code FROM _platform)))$$,
  '55000',
  NULL,
  'renewal refuses every cycle order while the settlement currency is unconfigured');

SELECT is(
  (SELECT count(*)::integer
     FROM public.commerce_idempotency_keys
    WHERE idempotency_key IN (
      'currency-invariant-unseeded-1',
      'currency-invariant-renewal-unseeded-1')),
  0,
  'an unconfigured deployment writes nothing at all rather than writing a guess');

SELECT * FROM finish();
ROLLBACK;
