-- Future package edits use a content-keyed preview and a separate command key.
-- Existing command routines and frozen cycle/operation snapshots are unchanged.
ALTER TABLE public.subscriptions ADD COLUMN composition_constraint jsonb;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_composition_constraint_check
 CHECK (composition_constraint IS NULL OR jsonb_typeof(composition_constraint) = 'object') NOT VALID;

CREATE TABLE public.subscription_quote_previews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 subscription_id uuid NOT NULL REFERENCES public.subscriptions(id),
 client_id uuid NOT NULL REFERENCES public.clients(id),
 actor_id uuid NOT NULL,
 action text NOT NULL,
 quote_hash text NOT NULL CHECK (char_length(quote_hash) = 64),
 template_version integer NOT NULL,
 expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed','accepted')),
 request_payload jsonb NOT NULL,
 quote_snapshot jsonb NOT NULL,
 totals jsonb NOT NULL,
 accepted_at timestamptz,
 accepted_idempotency_key text,
 accepted_event_id uuid REFERENCES public.subscription_events(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT subscription_quote_previews_acceptance_check CHECK (
  (status = 'previewed' AND accepted_at IS NULL AND accepted_idempotency_key IS NULL AND accepted_event_id IS NULL)
  OR (status = 'accepted' AND accepted_at IS NOT NULL AND accepted_idempotency_key IS NOT NULL AND accepted_event_id IS NOT NULL))
);
CREATE INDEX subscription_quote_previews_lookup ON public.subscription_quote_previews
 (subscription_id,action,quote_hash,template_version,created_at DESC);
CREATE INDEX subscription_quote_previews_expiry ON public.subscription_quote_previews(status,expires_at);
CREATE UNIQUE INDEX subscription_quote_previews_open ON public.subscription_quote_previews
 (subscription_id,client_id,action,quote_hash,template_version) WHERE status = 'previewed';
ALTER TABLE public.subscription_quote_previews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_quote_previews FROM PUBLIC;

INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('subscription_quote_previews', 'block', 'Quote previews belong to the subscriptions they price, which already block absorption.');

CREATE FUNCTION public.subscription_quote_variant_qty_request(p_lines jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_lines)='array' THEN COALESCE((SELECT jsonb_agg(
  jsonb_build_object('variantId',v->>'variantId','qty',CASE WHEN COALESCE(v->>'qty','') ~ '^-?[0-9]+$'
   THEN (v->>'qty')::integer ELSE NULL END) ORDER BY ord)
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY x(v,ord)),'[]'::jsonb) ELSE NULL END;
$$;

CREATE FUNCTION public.subscription_quote_line_projection(p_line jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE
            WHEN jsonb_typeof(p_line) <> 'object' THEN p_line
            WHEN jsonb_typeof(facts) <> 'object' THEN p_line
            WHEN (
              (
                facts->>'version' = 'catalog_facts_v1'
                AND ARRAY(SELECT key FROM jsonb_object_keys(facts) AS key ORDER BY key) = ARRAY[
                  'atTime', 'basePriceEntryId', 'baseUnitAmountMinor', 'currency', 'documentDigest',
                  'documentRevisionId', 'mode', 'resolvedLineAmountMinor', 'resolvedPriceEntryId',
                  'resolvedUnitAmountMinor', 'skuId', 'version'
                ]::text[]
                AND jsonb_typeof(facts->'resolvedPriceEntryId') = 'string'
                AND char_length(btrim(facts->>'resolvedPriceEntryId', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))
                    + regexp_count(btrim(facts->>'resolvedPriceEntryId', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') COLLATE "C", '[' || chr(65536) || '-' || chr(1114111) || ']') BETWEEN 1 AND 120
                AND facts->>'mode' IN ('one_time', 'subscription')
              )
              OR (
                facts->>'version' = 'catalog_facts_v2'
                AND ARRAY(SELECT key FROM jsonb_object_keys(facts) AS key ORDER BY key) = ARRAY[
                  'atTime', 'basePriceEntryId', 'baseUnitAmountMinor', 'currency', 'documentDigest',
                  'documentRevisionId', 'mode', 'policyDigest', 'policyRevisionId', 'resolvedLineAmountMinor',
                  'resolvedUnitAmountMinor', 'skuId', 'version'
                ]::text[]
                AND jsonb_typeof(facts->'policyRevisionId') = 'string'
                AND (facts->>'policyRevisionId') COLLATE "C" ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
                AND jsonb_typeof(facts->'policyDigest') = 'string'
                AND (facts->>'policyDigest') COLLATE "C" ~* '^[a-f0-9]{64}$'
                AND facts->>'mode' = 'subscription'
              )
            )
            AND jsonb_typeof(facts->'skuId') = 'string'
            AND (facts->>'skuId') COLLATE "C" ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
            AND jsonb_typeof(facts->'documentRevisionId') = 'string'
            AND (facts->>'documentRevisionId') COLLATE "C" ~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
            AND jsonb_typeof(facts->'documentDigest') = 'string'
            AND (facts->>'documentDigest') COLLATE "C" ~* '^[a-f0-9]{64}$'
            AND jsonb_typeof(facts->'basePriceEntryId') = 'string'
            AND char_length(btrim(facts->>'basePriceEntryId', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))
                + regexp_count(btrim(facts->>'basePriceEntryId', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') COLLATE "C", '[' || chr(65536) || '-' || chr(1114111) || ']') BETWEEN 1 AND 120
            AND jsonb_typeof(facts->'atTime') = 'string'
            AND (facts->>'atTime') COLLATE "C" ~ '^(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|(02)-(0[1-9]|1[0-9]|2[0-8])))T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
            AND jsonb_typeof(facts->'currency') = 'string'
            AND (facts->>'currency') COLLATE "C" ~ '^[A-Z]{3}$'
            AND jsonb_typeof(facts->'resolvedUnitAmountMinor') = 'number'
            AND (facts->>'resolvedUnitAmountMinor') COLLATE "C" ~ '^(0|[1-9][0-9]*)(\.0+)?$'
            AND CASE WHEN jsonb_typeof(facts->'resolvedUnitAmountMinor') = 'number' THEN (facts->>'resolvedUnitAmountMinor')::numeric <= 9007199254740991 ELSE FALSE END
            AND jsonb_typeof(facts->'resolvedLineAmountMinor') = 'number'
            AND (facts->>'resolvedLineAmountMinor') COLLATE "C" ~ '^(0|[1-9][0-9]*)(\.0+)?$'
            AND CASE WHEN jsonb_typeof(facts->'resolvedLineAmountMinor') = 'number' THEN (facts->>'resolvedLineAmountMinor')::numeric <= 9007199254740991 ELSE FALSE END
            AND jsonb_typeof(facts->'baseUnitAmountMinor') = 'number'
            AND (facts->>'baseUnitAmountMinor') COLLATE "C" ~ '^(0|[1-9][0-9]*)(\.0+)?$'
            AND CASE WHEN jsonb_typeof(facts->'baseUnitAmountMinor') = 'number' THEN (facts->>'baseUnitAmountMinor')::numeric <= 9007199254740991 ELSE FALSE END
            THEN jsonb_set(p_line, '{catalogFacts}', jsonb_build_object('validObservationTime', true, 'value', facts - 'atTime'))
            ELSE jsonb_set(p_line, '{catalogFacts}', jsonb_build_object('validObservationTime', false, 'value', facts))
          END FROM (SELECT p_line->'catalogFacts' AS facts) observed;
$$;

CREATE FUNCTION public.subscription_quote_variant_qty_lines(p_lines jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_lines)='array' THEN COALESCE((SELECT jsonb_agg(
  jsonb_build_object('variantId',v->>'variantId','qty',CASE WHEN COALESCE(v->>'qty','') ~ '^-?[0-9]+$'
   THEN (v->>'qty')::integer ELSE NULL END,'quoteLine',public.subscription_quote_line_projection(COALESCE(v->'quoteLine','{}'::jsonb))) ORDER BY ord)
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY x(v,ord)),'[]'::jsonb) ELSE NULL END;
$$;

CREATE FUNCTION public.subscription_quote_assert_jsonb_equal(p_left jsonb,p_right jsonb)
 RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_left IS NULL OR p_right IS NULL OR p_left<>p_right THEN
  RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023';
 END IF;
END;
$$;

CREATE FUNCTION public.subscription_quote_preview_record(
 p_actor_id uuid,p_client_id uuid,p_subscription_id uuid,p_action text,p_hash text,p_version integer,
 p_expires_at timestamptz,p_request jsonb,p_snapshot jsonb,p_totals jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; q public.subscription_quote_previews%ROWTYPE;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now) THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('update_package_template','update_bundle','update_plan_length','add_addon','remove_addon',
  'update_addon_quantity','swap_base_line','update_base_mix','update_portion','resize_bundle') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF p_version IS NULL OR p_version<1 THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 IF p_expires_at IS NULL OR NOT isfinite(p_expires_at) OR p_expires_at<=p_now THEN
  RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.template_version<>p_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 DELETE FROM public.subscription_quote_previews WHERE id IN (SELECT id FROM public.subscription_quote_previews
  WHERE status='previewed' AND expires_at<p_now-interval '7 days' ORDER BY expires_at,id LIMIT 500);
 INSERT INTO public.subscription_quote_previews(subscription_id,client_id,actor_id,action,quote_hash,template_version,
  expires_at,request_payload,quote_snapshot,totals,created_at,updated_at)
 VALUES(s.id,p_client_id,p_actor_id,p_action,p_hash,p_version,p_expires_at,p_request,p_snapshot,p_totals,p_now,p_now)
 ON CONFLICT (subscription_id,client_id,action,quote_hash,template_version) WHERE status='previewed' DO UPDATE SET
  actor_id=EXCLUDED.actor_id,expires_at=EXCLUDED.expires_at,request_payload=EXCLUDED.request_payload,
  quote_snapshot=EXCLUDED.quote_snapshot,totals=EXCLUDED.totals,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at
 RETURNING * INTO q;
 RETURN to_jsonb(q);
END;
$$;

CREATE FUNCTION public.subscription_quote_preview_take(
 p_actor_id uuid,p_client_id uuid,p_subscription_id uuid,p_action text,p_hash text,p_version integer,p_key text,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions%ROWTYPE; q public.subscription_quote_previews%ROWTYPE;
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180 THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('update_package_template','update_bundle','update_plan_length','add_addon','remove_addon',
  'update_addon_quantity','swap_base_line','update_base_mix','update_portion','resize_bundle') THEN
  RAISE EXCEPTION 'subscription_command_unsupported_action' USING ERRCODE='22023'; END IF;
 IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF p_version IS NULL OR p_version<1 OR s.template_version<>p_version THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 SELECT * INTO q FROM public.subscription_quote_previews WHERE subscription_id=s.id AND client_id=p_client_id
  AND action=p_action AND quote_hash=p_hash AND template_version=p_version ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF q.expires_at<=p_now THEN RAISE EXCEPTION 'subscription_edit_quote_expired' USING ERRCODE='22023'; END IF;
 IF q.accepted_at IS NOT NULL AND q.accepted_idempotency_key<>p_key THEN
  RAISE EXCEPTION 'subscription_edit_quote_already_used' USING ERRCODE='22023'; END IF;
 RETURN to_jsonb(q);
END;
$$;

CREATE FUNCTION public.subscription_quote_preview_mark_accepted(p_preview_id uuid,p_key text,p_event_id uuid,p_now timestamptz)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE q public.subscription_quote_previews%ROWTYPE;
BEGIN
 IF p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_event_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now) THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 SELECT * INTO q FROM public.subscription_quote_previews WHERE id=p_preview_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF q.accepted_at IS NOT NULL THEN
  IF q.accepted_idempotency_key=p_key AND q.accepted_event_id=p_event_id THEN RETURN; END IF;
  RAISE EXCEPTION 'subscription_edit_quote_already_used' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.subscription_events WHERE id=p_event_id AND subscription_id=q.subscription_id
  AND event_type='subscription.customer_self_service.'||q.action) THEN
  RAISE EXCEPTION 'subscription_edit_quote_drift' USING ERRCODE='22023'; END IF;
 UPDATE public.subscription_quote_previews SET status='accepted',accepted_at=p_now,accepted_idempotency_key=p_key,
  accepted_event_id=p_event_id,updated_at=p_now WHERE id=q.id;
END;
$$;

CREATE FUNCTION public.subscription_package_edit_apply(
 p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,p_payload jsonb,p_now timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
 s public.subscriptions%ROWTYPE; r public.subscription_command_receipts%ROWTYPE;
 command jsonb; fingerprint text; answer jsonb; q jsonb; event_id uuid; event_key text;
 core jsonb; addons jsonb; stored jsonb; line_pricing jsonb; constraint_value jsonb;
 plan integer; version integer; minimum_text text; minimum_units integer; line jsonb; ordinal integer:=0;
 core_matches boolean; addon_matches boolean; outcome text:='applied';
BEGIN
 IF p_actor_id IS NULL OR p_client_id IS NULL OR p_now IS NULL OR NOT isfinite(p_now)
  OR p_key IS NULL OR p_key<>btrim(p_key) OR char_length(p_key) NOT BETWEEN 8 AND 180
  OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
  OR p_payload->'request' IS NULL OR jsonb_typeof(p_payload->'request')<>'object' THEN
  RAISE EXCEPTION 'subscription_command_invalid_input' USING ERRCODE='22023'; END IF;
 command:=jsonb_build_object('clientId',p_client_id,'subscriptionId',p_subscription_id,
  'action','update_package_template','payload',p_payload->'request');
 fingerprint:=encode(sha256(convert_to(command::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||':'||p_key,0));
 SELECT * INTO r FROM public.subscription_command_receipts WHERE actor_id=p_actor_id AND idempotency_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id) THEN
   RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
  IF r.command_fingerprint<>fingerprint OR r.quote_hash IS DISTINCT FROM (p_payload#>>'{request,acceptedQuoteHash}') THEN
   RETURN jsonb_build_object('status','refused','reason','subscription_command_idempotency_conflict'); END IF;
  IF r.status IN ('applied','noop') THEN RETURN r.result||jsonb_build_object('status','replayed','originalStatus',r.status); END IF;
  IF r.status='refused' THEN RETURN r.result; END IF;
  RAISE EXCEPTION 'subscription_command_idempotency_conflict' USING ERRCODE='22023';
 END IF;
 core:=p_payload->'baseLines'; addons:=COALESCE(p_payload->'addonLines','[]'::jsonb);
 IF jsonb_typeof(core) IS DISTINCT FROM 'array' OR jsonb_array_length(core)=0 OR jsonb_typeof(addons)<>'array' THEN
  RAISE EXCEPTION 'subscription_edit_invalid_lines' USING ERRCODE='22023'; END IF;
 SELECT value_text INTO minimum_text FROM public.commerce_settings WHERE key='subscription_minimum_base_units';
 IF minimum_text IS NULL OR minimum_text !~ '^[1-9][0-9]*$' OR length(minimum_text)>10 THEN
  RAISE EXCEPTION 'subscription_reprice_minimum_base_units_unavailable' USING ERRCODE='22023'; END IF;
 BEGIN minimum_units:=minimum_text::integer;
 EXCEPTION WHEN numeric_value_out_of_range THEN
  RAISE EXCEPTION 'subscription_reprice_minimum_base_units_unavailable' USING ERRCODE='22023'; END;
 IF (SELECT COALESCE(sum((v->>'qty')::integer),0) FROM jsonb_array_elements(core) v)<minimum_units THEN
  RAISE EXCEPTION 'subscription_edit_below_minimum_order_units' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE id=p_subscription_id AND client_id=p_client_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023'; END IF;
 IF s.status<>'active' OR s.next_cycle_at IS NULL OR p_now>s.next_cycle_at-make_interval(hours=>s.edit_window_hours) THEN
  RAISE EXCEPTION 'subscription_edit_window_closed' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM public.subscription_dunning_cases WHERE subscription_id=s.id AND status='open')
  OR NOT EXISTS(SELECT 1 FROM public.subscription_method_states WHERE subscription_id=s.id AND health_state='healthy') THEN
  RAISE EXCEPTION 'subscription_command_payment_blocked' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'acceptedQuoteHash','') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'subscription_edit_quote_required' USING ERRCODE='22023'; END IF;
 IF COALESCE(p_payload->>'expectedTemplateVersion','') !~ '^[0-9]{1,9}$' THEN
  RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 version:=(p_payload->>'expectedTemplateVersion')::integer;
 IF version<>s.template_version THEN RAISE EXCEPTION 'subscription_edit_stale_template' USING ERRCODE='22023'; END IF;
 -- Bind the fingerprinted customer request to its server enrichment. Nominal
 -- cadence/version are intentionally server-resolved; price evidence is ledger-bound below.
 PERFORM public.subscription_quote_assert_jsonb_equal(p_payload#>'{request,acceptedQuoteHash}',p_payload->'acceptedQuoteHash');
 PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload#>'{request,base}'),
  public.subscription_quote_variant_qty_request(p_payload->'base'));
 PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload#>'{request,addons}'),
  public.subscription_quote_variant_qty_request(p_payload->'addons'));
 plan:=(p_payload->>'planDays')::integer;
 -- Set equality is order/price independent and aggregates repeated variants.
 SELECT bool_and(matches) FILTER(WHERE NOT is_addon),bool_and(matches) FILTER(WHERE is_addon)
 INTO core_matches,addon_matches FROM (
  SELECT is_addon,jsonb_typeof(wanted)='array' AND
   (SELECT COALESCE(jsonb_object_agg(variant,qty),'{}') FROM (
    SELECT (v->>'variantId')::uuid variant,sum((v->>'qty')::integer) qty FROM jsonb_array_elements(wanted) v
    WHERE COALESCE(v->>'variantId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND COALESCE(v->>'qty','') ~ '^[1-9][0-9]{0,5}$' GROUP BY (v->>'variantId')::uuid) desired)
   =(SELECT COALESCE(jsonb_object_agg(variant_id,qty),'{}') FROM (
    SELECT variant_id,sum(quantity) qty FROM public.subscription_lines WHERE subscription_id=s.id
     AND is_addon=inputs.is_addon GROUP BY variant_id) current_lines)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(wanted) v
    WHERE COALESCE(v->>'variantId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR COALESCE(v->>'qty','') !~ '^[1-9][0-9]{0,5}$') AS matches
  FROM (VALUES(false,core),(true,addons)) inputs(is_addon,wanted)
 ) line_sets;
 IF plan=s.cadence_days AND core_matches AND addon_matches THEN outcome:='noop';
 ELSE
  PERFORM public.subscription_lifecycle_assert_unlocked_cycle(s.id,s.next_cycle_at);
  PERFORM 1 FROM public.subscription_renewal_terms WHERE subscription_id=s.id AND currency_code=s.currency_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription_command_renewal_terms_missing' USING ERRCODE='22023'; END IF;
  q:=public.subscription_quote_preview_take(p_actor_id,p_client_id,s.id,'update_package_template',
   p_payload->>'acceptedQuoteHash',version,p_key,p_now);
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'planDays',q#>'{request_payload,planDays}');
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload->'base'),
   public.subscription_quote_variant_qty_request(q#>'{request_payload,base}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_request(p_payload->'addons'),
   public.subscription_quote_variant_qty_request(q#>'{request_payload,addons}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_lines(core),
   public.subscription_quote_variant_qty_lines(q#>'{quote_snapshot,baseLines}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(public.subscription_quote_variant_qty_lines(addons),
   public.subscription_quote_variant_qty_lines(q#>'{quote_snapshot,addonLines}'));
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'currentRecurringPrice',q#>'{totals,currentRecurringPrice}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'newRecurringPrice',q#>'{totals,newRecurringPrice}');
  PERFORM public.subscription_quote_assert_jsonb_equal(p_payload->'delta',q#>'{totals,delta}');
  IF plan IS NULL OR plan<1 THEN RAISE EXCEPTION 'subscription_edit_invalid_request' USING ERRCODE='22023'; END IF;
  constraint_value:=jsonb_set(COALESCE(s.composition_constraint,'{}'::jsonb),'{value}',to_jsonb(plan));
  IF COALESCE(q#>>'{request_payload,nominalPlanDays}','') ~ '^[1-9][0-9]{0,2}$' THEN
   constraint_value:=jsonb_set(constraint_value,'{value}',to_jsonb((q#>>'{request_payload,nominalPlanDays}')::integer));
  END IF;
  DELETE FROM public.subscription_lines WHERE subscription_id=s.id;
  DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=s.id;
  line_pricing:='[]'::jsonb;
  FOR line IN SELECT v||jsonb_build_object('isAddon',ord>jsonb_array_length(core))
   FROM jsonb_array_elements(core||addons) WITH ORDINALITY x(v,ord) ORDER BY ord LOOP
   ordinal:=ordinal+1;
   INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
   VALUES(s.id,(line->>'variantId')::uuid,(line->>'qty')::integer,ordinal-1,(line->>'isAddon')::boolean,
    (line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,s.currency_code);
   INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
   SELECT s.id,ordinal,sku.sku,(line->>'qty')::integer,(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint
    FROM public.catalog_skus sku WHERE sku.id=(line->>'variantId')::uuid;
   line_pricing:=line_pricing||jsonb_build_array(jsonb_build_object('sku',line#>>'{quoteLine,sku}',
    'quantity',(line->>'qty')::integer,'unitAmountMinor',(line#>>'{quoteLine,unitPriceGross,amountMinor}')::bigint,
    'isAddon',(line->>'isAddon')::boolean,'quoteLine',line->'quoteLine'));
  END LOOP;
  UPDATE public.subscription_renewal_terms SET updated_at=p_now WHERE subscription_id=s.id;
  UPDATE public.subscriptions SET cadence_days=plan,composition_constraint=constraint_value,
   template_version=template_version+1,updated_at=p_now WHERE id=s.id RETURNING * INTO s;
  event_key:='command:'||encode(sha256(convert_to(p_actor_id::text||':'||p_key,'UTF8')),'hex');
  INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload,occurred_at)
   VALUES(s.id,'subscription.customer_self_service.update_package_template',event_key,
    jsonb_build_object('action','update_package_template','quotePreviewId',q->>'id','linePricing',line_pricing,
     'payload',(p_payload->'request')-ARRAY['acceptedQuoteHash','expectedTemplateVersion'],
     'priceAgreementPolicy',jsonb_build_object('kind','lock_until_edit','proration','none','cycleEffect','future_unlocked_cycles_only')),p_now)
   RETURNING id INTO event_id;
  PERFORM public.subscription_quote_preview_mark_accepted((q->>'id')::uuid,p_key,event_id,p_now);
 END IF;
 answer:=jsonb_build_object('status',outcome,'subscriptionId',s.id,'action','update_package_template','subscriptionStatus',s.status,
  'nextCycleAt',s.next_cycle_at,'templateVersion',s.template_version,'eventId',event_id);
 INSERT INTO public.subscription_command_receipts(actor_id,idempotency_key,subscription_id,client_id,command_fingerprint,command,quote_hash,result,status)
 VALUES(p_actor_id,p_key,s.id,p_client_id,fingerprint,command,p_payload#>>'{request,acceptedQuoteHash}',answer,outcome);
 RETURN answer;
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_quote_variant_qty_request(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_quote_line_projection(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_quote_variant_qty_lines(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_quote_assert_jsonb_equal(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_quote_preview_record(uuid,uuid,uuid,text,text,integer,timestamptz,jsonb,jsonb,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_quote_preview_take(uuid,uuid,uuid,text,text,integer,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_quote_preview_mark_accepted(uuid,text,uuid,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_package_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz) FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_quote_previews FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_quote_variant_qty_request(jsonb), public.subscription_quote_line_projection(jsonb), public.subscription_quote_variant_qty_lines(jsonb), public.subscription_quote_assert_jsonb_equal(jsonb,jsonb), public.subscription_quote_preview_record(uuid,uuid,uuid,text,text,integer,timestamptz,jsonb,jsonb,jsonb,timestamptz), public.subscription_quote_preview_take(uuid,uuid,uuid,text,text,integer,text,timestamptz), public.subscription_quote_preview_mark_accepted(uuid,text,uuid,timestamptz), public.subscription_package_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz) FROM anon'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_quote_previews FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_quote_variant_qty_request(jsonb), public.subscription_quote_line_projection(jsonb), public.subscription_quote_variant_qty_lines(jsonb), public.subscription_quote_assert_jsonb_equal(jsonb,jsonb), public.subscription_quote_preview_record(uuid,uuid,uuid,text,text,integer,timestamptz,jsonb,jsonb,jsonb,timestamptz), public.subscription_quote_preview_take(uuid,uuid,uuid,text,text,integer,text,timestamptz), public.subscription_quote_preview_mark_accepted(uuid,text,uuid,timestamptz), public.subscription_package_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz) FROM authenticated'; END IF; END; $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.subscription_quote_previews FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_quote_variant_qty_request(jsonb), public.subscription_quote_line_projection(jsonb), public.subscription_quote_variant_qty_lines(jsonb), public.subscription_quote_assert_jsonb_equal(jsonb,jsonb), public.subscription_quote_preview_record(uuid,uuid,uuid,text,text,integer,timestamptz,jsonb,jsonb,jsonb,timestamptz), public.subscription_quote_preview_take(uuid,uuid,uuid,text,text,integer,text,timestamptz), public.subscription_quote_preview_mark_accepted(uuid,text,uuid,timestamptz), public.subscription_package_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz) FROM service_role'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_quote_preview_record(uuid,uuid,uuid,text,text,integer,timestamptz,jsonb,jsonb,jsonb,timestamptz), public.subscription_quote_preview_take(uuid,uuid,uuid,text,text,integer,text,timestamptz), public.subscription_quote_preview_mark_accepted(uuid,text,uuid,timestamptz), public.subscription_package_edit_apply(uuid,uuid,text,uuid,jsonb,timestamptz) TO service_role'; END IF; END; $$;
