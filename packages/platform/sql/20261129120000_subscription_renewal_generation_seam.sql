CREATE FUNCTION public.subscription_read_frozen_renewal_generation(operation_id uuid, commercial_generation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  operation public.subscription_renewal_operations%ROWTYPE;
  wire jsonb;
  acceptance jsonb;
  admission jsonb;
  projected jsonb;
BEGIN
  IF operation_id IS NULL OR commercial_generation_id IS NULL THEN
    RAISE EXCEPTION 'subscription_renewal_generation_invalid_input' USING ERRCODE = '22023',
      HINT = 'Recover both coordinates from the operation owner and recheck the lookup.';
  END IF;
  IF operation_id <> commercial_generation_id THEN
    RAISE EXCEPTION 'subscription_renewal_generation_mismatch' USING ERRCODE = '22023',
      HINT = 'Recover the original operation and generation binding through its owner and recheck it.';
  END IF;
  SELECT * INTO operation FROM public.subscription_renewal_operations WHERE id = operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commerce_renewal_operation_not_found' USING ERRCODE = '22023',
      HINT = 'Verify the selected installation and recover the stored operation through its owner. Recheck the original pair.';
  END IF;

  wire := operation.cycle_snapshot;
  IF operation.catalog_acceptance_fingerprint = operation.operation_fingerprint THEN
    acceptance := operation.catalog_acceptance;
    admission := acceptance->'admission';
  END IF;

  -- Project typed leaves before composing objects and ordered arrays.
  WITH arrays(kind, items) AS (VALUES
    ('line', wire->'lines'), ('pricing', wire#>'{pricingSnapshot,linePricing}'), ('roster', acceptance->'lines'),
    ('head', admission->'consultedHeads'), ('binding', admission->'lineBindings'), ('graduationBinding', admission#>'{graduation,lineBindings}')
  ), inputs(kind, ordinal, source) AS (
    SELECT kind, ordinal, value FROM arrays CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(items) = 'array' THEN items ELSE '[]'::jsonb END) WITH ORDINALITY AS item(value, ordinal)
    UNION ALL VALUES
      ('wire', 1, wire), ('template', 1, wire->'templateSnapshot'),
      ('cycle', 1, CASE WHEN wire#>'{cycle,status}' = '"correlated"'::jsonb THEN wire->'cycle' END),
      ('shipping', 1, wire#>'{pricingSnapshot,shippingTerms}'),
      ('discount', 1, jsonb_build_object('reasonCode', wire#>'{pricingSnapshot,acquisition,reasonCode}', 'acquisitionRef',
        NULLIF(wire#>'{orderSnapshot,acquisitionRef}', '""'::jsonb))),
      ('admission', 1, admission), ('offer', 1, admission->'offer'),
      ('review', 1, admission->'legacyReviewEvidence'), ('graduation', 1, admission->'graduation')
  ), shapes(kind, part, path, required, optional, numbers) AS (VALUES
    ('wire', 'main', '{}', '', 'clientId,currency,stockSourceKey,settlementChannelKey,authorizationRef,payerAccountRef,unattendedChargeAuthorizedAt', ''),
    ('wire', 'order', '{orderSnapshot}', '', 'shippingAddressRef', ''),
    ('cycle', 'main', '{}', 'activationCycleId,evidenceRef', '', ''),
    ('template', 'main', '{}', 'templateId', '', ''),
    ('line', 'main', '{}', 'sku,unitAmountMinor', '', 'unitAmountMinor'),
    ('shipping', 'main', '{}', 'version,currency,flatMinor,freeThresholdMinor', '', 'flatMinor,freeThresholdMinor'),
    ('discount', 'main', '{}', '', 'reasonCode,acquisitionRef', ''),
    ('pricing', 'main', '{}', 'sku', '', ''),
    ('pricing', 'facts', '{quoteLine,catalogFacts}', '', 'basePriceEntryId,basePriceListId,resolvedPriceEntryId,policyRevisionId,policyDigest,documentRevisionId,documentDigest,skuId,mode,currency,atTime', ''),
    ('roster', 'main', '{}', 'skuId,skuCode,skuRevisionId,definitionDigest,optionDigest', 'demandPolicyRef', ''),
    ('roster', 'publicationHead', '{publicationHead}', 'publicationId,documentDigest', '', ''),
    ('roster', 'typeRef', '{typeRef}', 'key', '', ''),
    ('roster', 'netContent', '{netContent}', 'dimension,unscaled,unit', '', ''),
    ('admission', 'main', '{}', 'quoteDigest,moneyVersion,priceEvidenceRef,policyEvidenceRef', 'quoteRef,acceptanceTokenDigest,destinationRef,destinationDigest', ''),
    ('head', 'main', '{}', 'productId,publicationId,documentDigest', '', ''),
    ('offer', 'main', '{}', 'ref,version', '', ''),
    ('review', 'main', '{}', 'identityComparison,priceEvidenceRef,policyEvidenceRef', 'priorPriceEvidenceRef,priorPolicyEvidenceRef', ''),
    ('graduation', 'main', '{}', 'phaseDigest', '', ''),
    ('binding', 'main', '{}', 'skuId,skuCode,mode,role,source', 'lineKey,skuRevisionId', '')
  ), parts AS (
    SELECT input.kind, ordinal, jsonb_object_agg(part, doc) AS docs, bool_and(doc IS NOT NULL) AS complete
    FROM inputs input JOIN shapes ON shapes.kind = CASE WHEN input.kind = 'graduationBinding' THEN 'binding' ELSE input.kind END
    CROSS JOIN LATERAL (
      SELECT CASE WHEN count(*) FILTER (WHERE key = ANY(string_to_array(required, ','))) = cardinality(string_to_array(required, ','))
        THEN coalesce(jsonb_object_agg(key, value), '{}'::jsonb) END AS doc
      FROM unnest(string_to_array(concat_ws(',', nullif(required, ''), nullif(optional, '')), ',')) AS keys(key)
      CROSS JOIN LATERAL (SELECT source #> (path::text[] || key) AS value) leaf
      WHERE jsonb_typeof(value) = CASE WHEN key = ANY(string_to_array(numbers, ',')) THEN 'number' ELSE 'string' END
    ) fields
    GROUP BY input.kind, ordinal
  ), elements AS (
    SELECT kind, ordinal, CASE
      WHEN NOT complete THEN NULL
      WHEN kind = 'wire' THEN docs->'main' || docs->'order'
      WHEN kind = 'roster' THEN (docs->'main') || (docs - 'main')
      WHEN kind = 'pricing' THEN CASE WHEN docs->'facts' <> '{}'::jsonb THEN (docs->'main') ||
        jsonb_build_object('quoteLine', jsonb_build_object('catalogFacts', (docs->'facts') || '{"provenance":"unverified-retained"}'::jsonb)) END
      WHEN kind IN ('binding', 'graduationBinding') AND docs#>'{main,source}' = '"legacy"'::jsonb THEN (docs->'main') - 'skuRevisionId'
      WHEN kind IN ('binding', 'graduationBinding') AND docs#>'{main,source}' IN ('"fresh"'::jsonb, '"retained"'::jsonb)
        AND NOT (docs->'main' ? 'skuRevisionId') THEN NULL
      WHEN kind = 'admission' AND NOT (docs->'main' ?& ARRAY['destinationRef','destinationDigest']) THEN (docs->'main') - ARRAY['destinationRef','destinationDigest']
      WHEN kind = 'review' AND (docs#>'{main,identityComparison}' = '"unavailable"'::jsonb
        OR NOT (docs->'main' ?& ARRAY['priorPriceEvidenceRef','priorPolicyEvidenceRef'])) THEN (docs->'main') - ARRAY['priorPriceEvidenceRef','priorPolicyEvidenceRef']
      ELSE docs->'main' END AS doc
    FROM parts
  ), groups AS (
    SELECT kind, CASE
      WHEN kind = 'pricing' THEN jsonb_agg(doc ORDER BY ordinal) FILTER (WHERE doc IS NOT NULL)
      WHEN kind IN ('line', 'roster', 'head', 'binding', 'graduationBinding') THEN
        CASE WHEN bool_and(doc IS NOT NULL) THEN jsonb_agg(doc ORDER BY ordinal) END
      ELSE (jsonb_agg(doc) FILTER (WHERE doc IS NOT NULL))->0 END AS doc
    FROM elements GROUP BY kind
  )
  SELECT jsonb_object_agg(kind, doc) FILTER (WHERE doc IS NOT NULL) INTO projected FROM groups;

  admission := CASE WHEN projected ?& ARRAY['admission','binding'] AND (projected ? 'head' OR admission->'consultedHeads' = '[]'::jsonb)
    THEN projected->'admission' || jsonb_build_object('consultedHeads', coalesce(projected->'head', '[]'::jsonb), 'lineBindings', projected->'binding')
      || jsonb_strip_nulls(jsonb_build_object('offer', projected->'offer', 'legacyReviewEvidence', projected->'review',
        'graduation', CASE WHEN projected ?& ARRAY['graduation','graduationBinding']
          THEN projected->'graduation' || jsonb_build_object('lineBindings', projected->'graduationBinding') END)) END;
  RETURN jsonb_build_object(
    'operationId', operation.id, 'commercialGenerationId', operation.id, 'subscriptionId', operation.subscription_id,
    'scheduledAt', to_char(operation.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'operationFingerprint', operation.operation_fingerprint, 'logicalCycle', projected->'cycle',
    'template', CASE WHEN projected ? 'template' THEN jsonb_build_object('id', projected#>'{template,templateId}') END,
    'lines', CASE WHEN wire->'lines' = '[]'::jsonb THEN '[]'::jsonb ELSE projected->'line' END,
    'catalogAcceptance', CASE WHEN projected ? 'roster' THEN jsonb_build_object('lines', projected->'roster')
      || jsonb_strip_nulls(jsonb_build_object('admission', admission)) END,
    'linePricing', coalesce(projected->'pricing', '[]'::jsonb),
    'discountTerms', CASE WHEN projected->'discount' <> '{}'::jsonb THEN '{"reasonCode":null}'::jsonb || (projected->'discount') END,
    'shippingTerms', projected->'shipping', 'clientId', projected#>'{wire,clientId}', 'currency', projected#>'{wire,currency}',
    'shippingAddressRef', projected#>'{wire,shippingAddressRef}', 'stockSourceKey', projected#>'{wire,stockSourceKey}',
    'settlementChannelKey', projected#>'{wire,settlementChannelKey}', 'authorizationRef', projected#>'{wire,authorizationRef}',
    'payerAccountRef', projected#>'{wire,payerAccountRef}', 'unattendedChargeAuthorizedAt', projected#>'{wire,unattendedChargeAuthorizedAt}');
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_read_frozen_renewal_generation(uuid,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_read_frozen_renewal_generation(uuid,uuid) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscription_read_frozen_renewal_generation(uuid,uuid) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscription_read_frozen_renewal_generation(uuid,uuid) TO service_role;';
END IF; END; $$;
