CREATE OR REPLACE FUNCTION public.tax_calculation_check_domain_v1(p_invocation jsonb, p_pin jsonb, p_seal jsonb, p_complete boolean) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  -- A null completion flag rechecks stored pin and seal data without an invocation.
  WITH RECURSIVE
  pin AS (SELECT p_pin->'request' AS request, p_pin->>'kind'='fiscal_profile' AS fiscal,
    p_pin ? 'composition' AS composition_present),
  seal_parts AS (SELECT
    '{"snapshotRef":"string","destinationDigest":"string","schemaVersion":"number","policyRevision":"string"}'::jsonb AS binding,
    '{"target":{"kind":"string","key":"string","taxClass?":"string","assignmentRef?":"string","deliveryKey?":"string"},
      "jurisdiction":"string","level":"string","taxKind":"string","sourcing":"string"}'::jsonb AS cell,
    '{"from":"date","until?":"date"}'::jsonb AS effective,
    '[{"positionRef":"string","jurisdictionRef":"string","level":"string","taxKind":"string","taxabilityReason":"string","ruleRef":"string",
      "resolution":{"assignmentRef":"string","policyRevision":"string","sourceRef":"string","sourceDigest?":"string",
        "effective":{"from":"date","until?":"date"}},
      "resolutionDigest":"string","providerLineRef?":"string","rateDecimal?":"string","taxableMinor":"number","taxMinor":"number"}]'::jsonb
      AS quote_positions
  ),
  seal_components AS (SELECT seal_parts.*,
    jsonb_build_object('basisMinor','number','netMinor','number','taxMinor','number','taxPositions',quote_positions) AS money_state
    FROM seal_parts
  ),
  seal_money AS (SELECT seal_components.*,
    '{"preDiscountMinor":"number","effectiveMinor":"number","netMinor":"number","taxMinor":"number","lineTotalMinor":"number"}'::jsonb
    || jsonb_build_object('taxPositions',quote_positions,'discountAllocations',jsonb_build_array(
      '{"allocationId":"string","adjustmentRef":"string","sequence":"number","source":"string","basisReductionMinor":"number",
        "netReductionMinor":"number","taxReductionMinor":"number","evidenceRef":"string"}'::jsonb
      || jsonb_build_object('before',money_state,'after',money_state))) AS component
    FROM seal_components
  ),
  seal_documents AS (SELECT binding,
    '{
      "catalogueEvidenceRef":"string","mode":"string","coverageDigest":"string","currency":"string","deliverySelectionRef":"string",
      "cadence?":{"schemaVersion":"number","kind":"string","days":"number"},
      "paymentLimits":{"profileRef":"string","revision":"string","channelKey":"string","currency":"string","minMinor":"number","maxMinor":"number"},
      "price":{"priceListRef":"string","priceContextDigest":"string","priceEvidenceRef":"string","classMapRevision":"string"},
      "netTotal":"number","taxTotal":"number","feeTotal":"number","payableMinor":"number",
      "feeLines":[{"feeKey":"string","jurisdictionRef":"string","feeKind":"string","amountMinor":"number",
        "scope":{"kind":"string","bucketKey?":"string"},"refundRule":{"ref":"string","revision":"string"},"providerPositionRef?":"string"}],
      "amountBasis":"string","promotion":{"engine":"string","rankingRuleRef":"string"},
      "taxEvidence":{"calculationId":"string","evidenceDigest":"string","taxDate":"date","expiresAt":"date","kind":"string"},
      "contractVersion":"string","schemaVersion":"number","quoteId":"string","status":"string","moneyDigest":"string","quoteDigest":"string"
    }'::jsonb || jsonb_build_object('destination',binding,'lines',jsonb_build_array(component ||
      '{"taxClassKey":"string","assignmentRef":"string","lineKey":"string","sourceOrdinal":"number","sku":"string",
        "mode":"string","quantity":"number","unitBasisMinor":"number"}'::jsonb),
      'deliveryBuckets',jsonb_build_array(
        '{"taxClassKey":"string","assignmentRef":"string","bucketKey":"string","kind":"string","carrierRef":"string","serviceRef":"string",
          "cost":{"ref":"string","currency":"string","amountMinor":"number"},"separatelyStated":"boolean"}'::jsonb
        || jsonb_build_object('parts',jsonb_build_array(component || '{"sourceOrdinal?":"number"}'::jsonb)))) AS quote,
    '{
      "requestKey":"string","scope":{"adapter":"string","adapterVersion":"string","accountRef":"string","mode":"string"},
      "calculationRef":"string","status":"string","calculatedAt":"date","expiresAt":"date","taxDate":"date",
      "destinationDigest":"string","shipFromRef":"string","inputDigest":"string","policyRevision":"string","classMapRevision":"string",
      "fiscalDigest":"string","providerLines?":[{"lineKey":"string","providerLineRef":"string"}]
    }'::jsonb || jsonb_build_object('coverage',jsonb_build_object('digest','string','vector',jsonb_build_array(
      '{"decision":"string","treatment?":{"kind":"string","reason":"string","ruleRef":"string"}}'::jsonb
      || jsonb_build_object('cell',cell,
        'declaration?', '{"jurisdiction":"string","taxKind":"string","status":"string","actorRef":"string","recordedAt":"date",
          "acknowledgementRef?":"string"}'::jsonb || jsonb_build_object('effective',effective),
        'registration?', '{"state":"string","evidenceRef":"string"}'::jsonb || jsonb_build_object('effective',effective)))),
      'positions',jsonb_build_object('tax',jsonb_build_array(
        '{"positionRef":"string","taxabilityReason":"string","ruleRef":"string","resolutionDigest":"string",
          "ratePercent?":"string","providerLineRef?":"string"}'::jsonb || jsonb_build_object('cell',cell,'resolution',
          '{"assignmentRef":"string","policyRevision":"string","sourceRef":"string","sourceDigest?":"string"}'::jsonb
          || jsonb_build_object('effective',effective))),
        'fees','[{"feeKey":"string","jurisdiction":"string","feeKind":"string","scope":{"kind":"string","key?":"string"},
          "refundRule":{"ref":"string","revision":"string"},"providerPositionRef?":"string"}]'::jsonb)) AS adapter_evidence
    FROM seal_money
  ),
  composition_parts AS (SELECT
    '{"country":"country","category":"ref","vatRateBps":"basis_points","legalBasis":"ref"}'::jsonb AS facts,
    '{"installationRef":"ref","marketRef":"ref","packId":"ref","packVersion":"ref"}'::jsonb AS coordinates,
    '{"amountBasis":"string","deliverySelectionRef":"ref",
      "delivery":[{"taxClassKey":"ref","assignmentRef":"ref","bucketKey":"money_ref","kind":"string",
        "carrierRef":"ref","serviceRef":"ref","cost":{"ref":"ref","currency":"currency","amountMinor":"minor"},
        "separatelyStated":"boolean","amountMinor":"minor","threshold?":{"flatMinor":"minor","freeThresholdMinor":"minor"}}],
      "feeLines":[{"feeKey":"money_ref","jurisdictionRef":"ref","feeKind":"ref","amountMinor":"minor",
        "scope":{"kind":"string","bucketKey?":"money_ref"},"refundRule":{"ref":"ref","revision":"ref"},"providerPositionRef?":"ref"}]}'::jsonb AS candidate
  ),
  composition_shape AS (SELECT facts,coordinates,
    '{"catalogueEvidenceRef":"ref","evidenceExpiresAt":"instant",
      "selection":{"kind":"checkout","scopeRef":"uuid","selectionRevision":"uuid"},
      "service":{"deliverySelectionRef":"ref","providerRef":"ref","carrierRef":"ref","serviceRef":"ref",
        "servicePolicyRevision":"ref","adapterRevision":"ref"},
      "limits":{"installationRef":"limits_ref","channelKey":"limits_ref","methodKey":"limits_ref",
        "providerKey":"limits_ref","accountRef":"limits_ref","mode":"limits_mode","currency":"currency",
        "profileRef":"limits_ref","revision":"revision","minMinor":"minor","maxMinor":"minor",
        "effective":{"minMinor":"minor","maxMinor":"minor"}}}'::jsonb
    || jsonb_build_object('planInput',
      '{"currency":"currency","listBasis":"string|null","engine":"string",
        "price":{"priceListRef":"ref","priceContextDigest":"digest","priceEvidenceRef":"ref","classMapRevision":"ref"},
        "lines":[{"lineKey":"money_ref","sourceOrdinal":"positive","sku":"ref","mode":"string","quantity":"number",
          "unitBasisMinor":"minor","taxClassKey":"ref","assignmentRef":"ref","amountKind":"string"}]}'::jsonb
      || jsonb_build_object('baseline',candidate,'selected?',candidate ||
        '{"adjustments":[{"amountOffMinor":"positive","adjustmentRef":"money_ref","evidenceRef":"ref",
          "appliesTo":"string","target":{"lineKeys?":["money_ref"],"bucketKey?":"money_ref"}}]}'::jsonb))
    AS composition FROM composition_parts
  ),
  -- Object keys ending in ? are optional, including keys specific to one variant.
  -- [shape] checks every element, [] admits only an empty array, and strings name JSON types.
  roots(field, value, expected) AS (
    SELECT '/pin', p_pin, '{
      "kind":"string", "validUntil":"string", "requestDigest":"string",
      "invocationDigest?":"string", "documentDigest?":"string",
      "destination":{"snapshotRef":"string","destinationDigest":"string","schemaVersion":"number","policyRevision":"string"}
    }'::jsonb || CASE WHEN fiscal THEN '{
      "coverage":"null", "recovery":"null", "request":{"basis":"string","taxDate":"string"}
    }'::jsonb ELSE '{
      "coverage":{"accountRef":"string","revision":"string","digest":"string"}, "recovery":"string|null",
      "request":{"key":"string","inputDigest":"string","input":{
        "scope":{"adapter":"string","adapterVersion":"string","accountRef":"string","mode":"string"},
        "market":"string","currency":"string","purpose":"string","taxDate":"date",
        "shipFromRef":"string","policyRevision":"string","classMapRevision":"string",
        "destination":{"snapshotRef":"string","digest":"string","policyRevision":"string"},
        "money":{
          "amountBasis":"string","fees":[],
          "sources":[{"lineKey":"string","sourceOrdinal":"number","quantity":"number","unitBasisMinor":"number"}],
          "delivery":[{"bucketKey":"string","deliveryKind":"string","amountMinor":"number"}],
          "adjustments":[{"adjustmentRef":"string","sequence":"number","amountMinor":"number",
            "target":{"lineKeys?":["string"],"bucketKey?":"string"}}]
        },
        "lines":[{"taxClass":"string","assignmentRef":"string","lineKey":"string","sku":"string","mode":"string"}],
        "delivery":[{"taxClass":"string","assignmentRef":"string","bucketKey":"string","carrierRef":"string",
          "serviceRef":"string","separatelyStated":"boolean","cost":{"ref":"string","currency":"string","amountMinor":"number"}}],
        "required":[{"target":{"kind":"string","key":"string","taxClass?":"string","assignmentRef?":"string","deliveryKey?":"string"},
          "jurisdiction":"string","level":"string","taxKind":"string","sourcing":"string"}],
        "coverage":{"schemaVersion":"number","accountRef":"string","revision":"string","declarations":[
          {"jurisdiction":"string","taxKind":"string","status":"string","actorRef":"string","recordedAt":"date",
            "acknowledgementRef?":"string","effective":{"from":"date","until?":"date"}}]}
      }}
    }'::jsonb END || CASE WHEN composition_present THEN jsonb_build_object('composition', composition ||
      CASE WHEN fiscal THEN jsonb_build_object('fiscal',jsonb_build_object('facts',facts,'coordinates',coordinates))
        ELSE '{}'::jsonb END) ELSE '{}'::jsonb END
    FROM pin CROSS JOIN composition_shape
    UNION ALL
    SELECT '/seal', p_seal,
      '{"kind":"string","requestDigest":"string","validUntil":"string","contradiction":"boolean","disposition":"string"}'::jsonb
      || jsonb_build_object('destination',binding,'outcome',CASE p_seal#>>'{outcome,kind}'
        WHEN 'indeterminate' THEN '{"kind":"string"}'::jsonb
        WHEN 'refused' THEN '{"kind":"string","code":"string","field":"string","remedy":"string"}'::jsonb
        WHEN 'unavailable' THEN '{"kind":"string","code":"string","field":"string","remedy":"string","effect":"string"}'::jsonb
        WHEN 'final' THEN jsonb_build_object('kind','string','quote',quote)
        WHEN 'estimate' THEN jsonb_build_object('kind','string','quote',quote) END,
        'evidence', CASE WHEN p_seal#>>'{outcome,kind}' IN ('final','estimate') THEN
          CASE WHEN fiscal AND composition_present THEN
            '{"policyRevision":"digest","calculationId":"uuid","coverage":{"kind":"string"},"posting":"string"}'::jsonb
              || jsonb_build_object('facts',facts,'coordinates',coordinates)
          WHEN fiscal THEN '{"policyRevision":"string","posting":"string"}'::jsonb
          ELSE jsonb_build_object('adapterDigest','string','adapterEvidence',adapter_evidence) END
          || CASE WHEN composition_present THEN '{"compositionDigest":"digest"}'::jsonb ELSE '{}'::jsonb END
        ELSE '"null"'::jsonb END)
    FROM seal_documents CROSS JOIN pin CROSS JOIN composition_shape WHERE p_complete IS DISTINCT FROM false
  ),
  shape(field, value, expected) AS (
    SELECT field, value, expected FROM roots
    UNION ALL
    SELECT shape.field, child.value, child.expected
    FROM shape
    CROSS JOIN LATERAL (
      SELECT member.value, CASE WHEN right(member.key,1) <> '?' THEN
        coalesce(shape.expected->member.key,shape.expected->(member.key || '?')) END AS expected
      FROM jsonb_each(CASE WHEN jsonb_typeof(shape.value) = 'object' THEN shape.value ELSE '{}'::jsonb END) member
      UNION ALL
      SELECT item.value, shape.expected->0
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(shape.value) = 'array' THEN shape.value ELSE '[]'::jsonb END) item
    ) child
    WHERE jsonb_typeof(shape.expected) IN ('object','array')
  ),
  invalid_shapes AS (
    SELECT field FROM shape CROSS JOIN pin
    CROSS JOIN LATERAL (SELECT value #>> '{}' AS scalar) leaf
    CROSS JOIN LATERAL (SELECT CASE WHEN expected='"date"'::jsonb
        THEN regexp_replace(scalar,'^0000','2000') ELSE scalar END AS date_value) clock
    CROSS JOIN LATERAL (SELECT CASE
      WHEN date_value COLLATE "C" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND pg_input_is_valid(date_value,'timestamp with time zone')
      THEN to_char(date_value::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=date_value END AS canonical_date) dates
    WHERE (CASE jsonb_typeof(expected)
      WHEN 'object' THEN jsonb_typeof(value) = 'object' AND value ?& ARRAY(
        SELECT key FROM jsonb_object_keys(expected) key WHERE right(key,1) <> '?')
      WHEN 'array' THEN jsonb_typeof(value) = 'array'
      WHEN 'string' THEN CASE expected #>> '{}'
        WHEN 'checkout' THEN value = '"checkout"'::jsonb
        WHEN 'limits_mode' THEN value IN ('"test"'::jsonb,'"live"'::jsonb)
        WHEN 'ref' THEN jsonb_typeof(value)='string' AND char_length(scalar) BETWEEN 1 AND 256
        WHEN 'money_ref' THEN public.catalog_publication_text_valid(value,128,false)
        WHEN 'limits_ref' THEN jsonb_typeof(value)='string' AND octet_length(scalar) BETWEEN 1 AND 200
        WHEN 'currency' THEN jsonb_typeof(value)='string' AND scalar COLLATE "C" ~ '^[A-Z]{3}$'
        WHEN 'country' THEN jsonb_typeof(value)='string' AND scalar COLLATE "C" ~ '^[A-Z]{2}$'
        WHEN 'digest' THEN jsonb_typeof(value)='string' AND scalar COLLATE "C" ~ '^[0-9a-f]{64}$'
        WHEN 'uuid' THEN jsonb_typeof(value)='string' AND scalar COLLATE "C" ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        WHEN 'revision' THEN jsonb_typeof(value)='number' AND scalar COLLATE "C" ~ '^[1-9][0-9]{0,9}$'
          AND value <= '2147483647'::jsonb
        WHEN 'basis_points' THEN jsonb_typeof(value)='number' AND scalar COLLATE "C" ~ '^[0-9]{1,5}$'
          AND value <= '10000'::jsonb
        WHEN 'minor' THEN jsonb_typeof(value)='number' AND scalar COLLATE "C" ~ '^[0-9]+$' AND value <= '9007199254740991'::jsonb
        WHEN 'positive' THEN jsonb_typeof(value)='number' AND scalar COLLATE "C" ~ '^[1-9][0-9]*$' AND value <= '9007199254740991'::jsonb
        WHEN 'date' THEN jsonb_typeof(value)='string' AND (NOT composition_present OR canonical_date)
        WHEN 'instant' THEN jsonb_typeof(value)='string' AND canonical_date
        ELSE jsonb_typeof(value) = ANY(string_to_array(expected #>> '{}','|'))
      END
    END) IS DISTINCT FROM true
  )
  SELECT CASE
    WHEN EXISTS (SELECT FROM invalid_shapes WHERE field = '/seal')
      OR (p_complete IS DISTINCT FROM false AND p_seal->'kind' IS DISTINCT FROM p_pin->'kind') THEN '/seal'
    WHEN NOT coalesce(p_pin->>'kind' IN ('fiscal_profile','tax_calculation'), false)
      OR EXISTS (SELECT FROM invalid_shapes WHERE field = '/pin')
      OR (fiscal AND request->>'basis' IS DISTINCT FROM 'inclusive')
      OR (p_pin->'recovery' IS DISTINCT FROM 'null'::jsonb
        AND NOT coalesce(p_pin->>'recovery' COLLATE "C" ~ '^[0-9a-f]{64}$',false)) THEN '/pin'
    WHEN char_length(p_pin#>>'{destination,policyRevision}') > 256 THEN '/pin/destination/policyRevision'
    WHEN p_complete IS NOT NULL AND jsonb_typeof(p_invocation->'lines') IS DISTINCT FROM 'array' THEN '/invocation/lines'
    ELSE coalesce(
      (SELECT path FROM (
        VALUES ('/invocation/deliverySelector',p_invocation->'deliverySelector'),
               ('/invocation/paymentSelector',p_invocation->'paymentSelector')
        UNION ALL SELECT '/invocation/lines/' || (position-1) || '/sku', line->'sku'
          FROM jsonb_array_elements(p_invocation->'lines') WITH ORDINALITY AS lines(line,position)
      ) refs(path,value) WHERE p_complete IS NOT NULL AND (public.catalog_publication_text_valid(value,240,true)
        AND octet_length(convert_to(value #>> '{}','UTF8')) <= 240) IS DISTINCT FROM true ORDER BY path LIMIT 1),
      (SELECT path FROM (VALUES
        ('/taxEvidence/expiresAt',p_pin->>'validUntil',true),
        ('/taxEvidence/expiresAt',p_seal->>'validUntil',p_complete IS DISTINCT FROM false),
        ('/pin/request/taxDate',CASE WHEN composition_present THEN request->>'taxDate'
          ELSE regexp_replace(request->>'taxDate','^0000','2000') END,fiscal)
      ) clocks(path,instant,required) WHERE required AND (CASE
        WHEN instant COLLATE "C" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
          AND pg_input_is_valid(instant,'timestamp with time zone')
        THEN to_char(instant::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=instant END) IS DISTINCT FROM true
      ORDER BY path LIMIT 1))
  END
  FROM pin;
$$;

CREATE OR REPLACE FUNCTION public.tax_calculation_terminal_v1(r public.tax_calculations) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  body jsonb;
  outcome jsonb;
  quote jsonb;
  approved_remedy text;
  composition_present boolean := r.pin ? 'composition';
  composition jsonb := r.pin->'composition';
  evidence jsonb;
  limits jsonb;
  envelope_keys constant text[] := ARRAY['calculationId','invocationDigest','requestDigest','generation',
    'destination','kind','evidence','disposition','validUntil'];
  identity_keys constant text[] := ARRAY['installationRef','clientId','principalRef','scopeRef','evaluationKey'];
BEGIN
  IF r.outcome_digest IS DISTINCT FROM encode(sha256(convert_to(r.outcome_text,'UTF8')),'hex')
    OR r.pin_digest IS DISTINCT FROM public.tax_calculation_hash_v1('evaluation-pin',r.pin)
    OR r.locator IS DISTINCT FROM public.tax_calculation_hash_v1('evaluation-key',r.identity)
    OR r.pin#>'{destination,snapshotRef}' IS DISTINCT FROM to_jsonb(r.snapshot_ref) THEN RETURN NULL; END IF;
  body := (r.outcome_text::jsonb)->1;
  IF r.outcome_text IS DISTINCT FROM public.tax_calculation_frame_v1('evaluation-outcome',body)
    OR body->'calculationId' IS DISTINCT FROM to_jsonb(r.calculation_id)
    OR body->'generation' IS DISTINCT FROM to_jsonb(r.generation)
    OR body->'invocationDigest' IS DISTINCT FROM r.pin->'invocationDigest'
    OR body->'requestDigest' IS DISTINCT FROM r.pin->'requestDigest'
    OR NOT coalesce(jsonb_typeof(body->'invocationDigest')='string' AND body->>'invocationDigest' COLLATE "C" ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(body->'requestDigest')='string' AND body->>'requestDigest' COLLATE "C" ~ '^[0-9a-f]{64}$',false)
    OR body->'destination' IS DISTINCT FROM r.pin->'destination'
    OR body->'kind' IS DISTINCT FROM r.pin->'kind'
    OR NOT coalesce(body->>'kind' IN ('tax_calculation','fiscal_profile'),false)
    OR NOT coalesce((body->>'validUntil')::timestamptz <= (r.pin->>'validUntil')::timestamptz,false)
    OR body->'providerDigest' IS DISTINCT FROM coalesce(to_jsonb(r.provider_digest),'null'::jsonb)
    OR body->'contradiction' IS DISTINCT FROM to_jsonb(r.contradiction) THEN RETURN NULL; END IF;
  outcome := body->'outcome';
  IF composition_present THEN
    evidence := body->'evidence';
    IF NOT (r.identity ?& identity_keys AND body ?& envelope_keys)
      OR r.identity - identity_keys <> '{}'::jsonb
      OR EXISTS (SELECT FROM jsonb_each(r.identity) member WHERE jsonb_typeof(member.value) <> 'string')
      OR body - envelope_keys - ARRAY['outcome','submissionDigest','providerDigest','contradiction'] <> '{}'::jsonb
      OR NOT coalesce(jsonb_typeof(body->'submissionDigest')='string'
        AND body->>'submissionDigest' COLLATE "C" ~ '^[0-9a-f]{64}$',false)
      OR public.tax_calculation_check_domain_v1(NULL,r.pin,
        body - ARRAY['calculationId','invocationDigest','generation','submissionDigest','providerDigest'],NULL) IS NOT NULL
      THEN RETURN NULL; END IF;
  END IF;
  CASE outcome->>'kind'
    WHEN 'final', 'estimate' THEN
      quote := outcome->'quote';
      IF quote->'status' IS DISTINCT FROM outcome->'kind' OR quote->'destination' IS DISTINCT FROM body->'destination'
        OR quote#>'{taxEvidence,calculationId}' IS DISTINCT FROM body->'calculationId'
        OR quote#>'{taxEvidence,kind}' IS DISTINCT FROM body->'kind'
        OR quote#>'{taxEvidence,expiresAt}' IS DISTINCT FROM body->'validUntil'
        OR quote#>>'{taxEvidence,evidenceDigest}' IS DISTINCT FROM
          public.tax_calculation_hash_v1('evaluation-evidence',body - ARRAY['outcome','submissionDigest','providerDigest','contradiction'])
        OR quote->>'quoteDigest' IS DISTINCT FROM encode(sha256(convert_to(public.catalog_publication_canonical(
          jsonb_build_array('commerce.quote.v2',quote - 'quoteDigest'),0),'UTF8')),'hex') THEN RETURN NULL; END IF;
      IF composition_present THEN
        limits := composition->'limits';
        IF evidence->>'compositionDigest' IS DISTINCT FROM public.tax_calculation_hash_v1('evaluation-composition',composition)
          OR quote->'paymentLimits' IS DISTINCT FROM jsonb_build_object(
            'profileRef',limits->'profileRef','revision',trim_scale((limits->>'revision')::numeric)::text,
            'channelKey',limits->'channelKey','currency',limits->'currency',
            'minMinor',limits#>'{effective,minMinor}','maxMinor',limits#>'{effective,maxMinor}')
          OR quote->>'moneyDigest' IS DISTINCT FROM encode(sha256(convert_to(public.catalog_publication_canonical(
            jsonb_build_array('commerce.quote-money.v2',
              quote - ARRAY['quoteDigest','moneyDigest','quoteId','status','schemaVersion','contractVersion']),0),'UTF8')),'hex')
          THEN RETURN NULL; END IF;
        IF r.pin->>'kind' = 'fiscal_profile' THEN
          IF evidence->'facts' IS DISTINCT FROM composition#>'{fiscal,facts}'
            OR evidence->'coordinates' IS DISTINCT FROM composition#>'{fiscal,coordinates}'
            OR evidence->>'policyRevision' IS DISTINCT FROM public.tax_calculation_hash_v1('fiscal-profile',
              jsonb_build_array(evidence->'facts',evidence->'coordinates'))
            OR evidence->'calculationId' IS DISTINCT FROM body->'calculationId'
            OR evidence->'coverage' IS DISTINCT FROM '{"kind":"not_applicable"}'::jsonb
            OR quote->>'coverageDigest' IS DISTINCT FROM public.tax_calculation_hash_v1('fiscal-coverage',evidence->'coverage')
            OR quote#>'{taxEvidence,taxDate}' IS DISTINCT FROM r.pin#>'{request,taxDate}'
            OR quote->>'amountBasis' IS DISTINCT FROM 'inclusive'
            OR evidence->>'posting' IS DISTINCT FROM 'no_provider_posting'
            OR evidence->'posting' IS DISTINCT FROM body->'disposition'
            OR r.provider_digest IS NOT NULL THEN RETURN NULL; END IF;
        ELSIF quote->>'amountBasis' IS DISTINCT FROM 'exclusive'
          OR NOT coalesce(body->>'disposition' IN ('skip','required')
            AND evidence->>'adapterDigest' COLLATE "C" ~ '^[0-9a-f]{64}$',false)
          OR r.provider_digest IS NULL THEN RETURN NULL;
        END IF;
      END IF;
      RETURN body || jsonb_build_object('outcome',jsonb_build_object('kind',outcome->'kind','quote',quote));
    WHEN 'refused', 'unavailable' THEN
      IF composition_present AND (body->'disposition' IS DISTINCT FROM outcome->'kind'
        OR r.provider_digest IS NOT NULL
        OR (outcome->>'code'='tax_coverage_inconsistent' AND NOT r.contradiction)
        OR (outcome->>'kind'='unavailable' AND outcome->>'effect' IS DISTINCT FROM 'none')) THEN RETURN NULL; END IF;
      SELECT permitted.remedy INTO approved_remedy FROM (VALUES
        ('refused','all','tax_provider_reference_conflict','/taxEvidence','Reconcile the original calculation with the tax adapter owner before further work.'),
        ('refused','all','tax_evaluation_integrity_invalid','/taxEvidence','Recover the original evaluation from its authoritative owner.'),
        ('refused','all','tax_calculation_expired','/taxEvidence/expiresAt','Select the destination again and obtain a fresh quote.'),
        ('refused','all','commerce_destination_owner_mismatch','/destination/snapshotRef','Re-obtain evidence through the authenticated owner.'),
        ('refused','all','destination_digest_mismatch','/destination/destinationDigest','Replay the original document and its digest.'),
        ('refused','all','tax_reference_conflict','/coverage','Recover the verified original history through its owner.'),
        ('unavailable','all','tax_adapter_unavailable','/taxEvidence','Request a new quote when the tax service is available.'),
        ('unavailable','all','tax_coverage_evidence_unavailable','/taxEvidence','Request a new quote when the tax service is available.'),
        ('refused','composition_exclusive','tax_invalid_input','/input','Correct the documented quote input and obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_invalid_input','/coverage/declarations','Have the coverage owner correct the declarations under /coverage/declarations, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_invalid_input','/required','Have the coverage owner supply valid required coverage within the evidence limit under /required, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_invalid_input','/now','Have the quote host supply a supported tax clock and obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_scope_mismatch','/input/scope','Use the authorized tax binding for the original scope, market and currency.'),
        ('refused','composition_exclusive','tax_scope_mismatch','/input/money/amountBasis','Use the inclusive quote path for an inclusive price list or obtain an exclusive quote on the published exclusive basis.'),
        ('refused','composition_exclusive','tax_scope_mismatch','/coverage/accountRef','Recover the original coverage history for the authorized tax account.'),
        ('refused','composition_exclusive','tax_scope_mismatch','/taxEvidence','Have the tax adapter owner reconcile the calculation account, mode and sourcing with the authorized tax binding, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_class_missing','/input/lines','Have the coverage owner supply the required tax class mapping for /input/lines, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_class_missing','/input/delivery','Have the coverage owner supply the required tax class mapping for /input/delivery, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_class_missing','/input/required','Have the coverage owner supply the required tax class mapping for /input/required, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_rule_missing','/input/required','Have the coverage owner supply an effective rule or explicit exemption for /input/required, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_rule_missing','/input/policyRevision','Have the coverage owner recover the rules for the original policy revision before requesting another quote.'),
        ('refused','composition_exclusive','tax_rule_missing','/input/classMapRevision','Have the coverage owner recover the original class map before requesting another quote.'),
        ('refused','composition_exclusive','tax_rule_missing','/input/shipFromRef','Have the coverage owner qualify the original shipping origin for /input/shipFromRef, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_rule_missing','/input/destination/address/subdivisionCode','Have the coverage owner qualify the destination subdivision for /input/destination/address/subdivisionCode, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_rule_missing','/calculation/tax_breakdown','Have the coverage owner qualify the fee and jurisdiction rules for /calculation/tax_breakdown, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_rule_missing','/calculation/shipping_cost/tax_breakdown','Have the coverage owner qualify the shipping jurisdiction and tax rule for /calculation/shipping_cost/tax_breakdown, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_rule_missing','/line_items','Have the coverage owner qualify the merchandise jurisdiction and tax rules for /line_items, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_coverage_undeclared','/coverage/declarations','Have the coverage owner supply the required effective declarations under /coverage/declarations, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_coverage_inconsistent','/observations','Have the coverage owner reconcile registration, treatment and assessment for /observations, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_breakdown_incomplete','/taxEvidence','Have the tax adapter owner resolve the incomplete calculation breakdown, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_amount_out_of_range','/input/money','Use supported basket amounts, including the combined basis, and obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_amount_out_of_range','/taxEvidence','Recover the original calculation with authoritative amounts within the supported range before requesting another quote.'),
        ('refused','composition_exclusive','tax_reference_conflict','/taxEvidence','Have the tax adapter owner resolve the conflicting request or response binding, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_calculation_unusable','/taxEvidence','Have the tax coverage owner supply coverage supported by effective observations, then obtain a fresh quote.'),
        ('refused','composition_exclusive','tax_operation_unsupported','/input/taxDate','Use a whole-second UTC tax instant on or after the Unix epoch.'),
        ('refused','composition_exclusive','tax_operation_unsupported','/input/money/sources','Use at least one merchandise line and keep every merchandise amount positive before and after discounts.'),
        ('refused','composition_exclusive','tax_operation_unsupported','/input/money/delivery','Use at most one shipping bucket and no handling buckets.'),
        ('refused','composition_exclusive','tax_operation_unsupported','/input/delivery/0','Use a qualified delivery service and matching cost currency.'),
        ('refused','composition_exclusive','tax_operation_unsupported','/input/money/delivery/0','Use a qualified zero-shipping route, supply independent inactivity evidence, or use a supported positive shipping charge.'),
        ('refused','composition_exclusive','tax_operation_unsupported','/input/money/adjustments','Use the undiscounted basket or a qualified promotion that fits the selected tax route.'),
        ('refused','composition_exclusive','tax_operation_unsupported','/calculation/tax_breakdown','Use a qualified calculation route for this tax breakdown.'),
        ('refused','composition_exclusive','tax_operation_unsupported','/calculation/shipping_cost/tax_breakdown','Use a qualified calculation route for the shipping breakdown.'),
        ('refused','composition_exclusive','tax_operation_unsupported','/line_items','Use a qualified calculation route for the merchandise breakdown.'),
        ('refused','composition_exclusive','tax_adapter_response_invalid','/taxEvidence','Resolve the unrecognised response with the tax adapter owner before requesting a new quote.')
      ) permitted(arm, pin_arm, code, field, remedy)
      WHERE to_jsonb(permitted.arm)=outcome->'kind' AND to_jsonb(permitted.code)=outcome->'code'
        AND to_jsonb(permitted.field)=outcome->'field'
        AND (permitted.pin_arm='all' OR (composition_present AND r.pin->>'kind'='tax_calculation'));
      IF approved_remedy IS NULL OR outcome->'remedy' IS DISTINCT FROM to_jsonb(approved_remedy) THEN RETURN NULL; END IF;
      RETURN body || jsonb_build_object('outcome',jsonb_build_object('kind',outcome->'kind','code',outcome->'code',
        'field',outcome->'field','remedy',approved_remedy) ||
        CASE WHEN outcome->>'kind' = 'unavailable' THEN '{"effect":"none"}'::jsonb ELSE '{}'::jsonb END);
    ELSE RETURN NULL;
  END CASE;
EXCEPTION WHEN data_exception OR check_violation THEN RETURN NULL;
END;
$$;
