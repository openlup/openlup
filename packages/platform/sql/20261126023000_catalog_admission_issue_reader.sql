-- Add the private admission issue mode to the offer membership reader. Every other mode keeps its
-- earlier body byte for byte, and the header, owner and grants stay as installed.
CREATE OR REPLACE FUNCTION public.catalog_offer_memberships_page(p_offer_version text,p_cursor jsonb,p_limit integer,p_mode text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE authority jsonb; head_digest text; items jsonb; failed jsonb; next_id uuid; after_id uuid;
 invalid_projection boolean; live_drift boolean; offer_known boolean;
 admitted jsonb := jsonb_build_array(jsonb_build_object('offerVersion',p_offer_version,'admitted',true));
 denied jsonb := jsonb_build_array(jsonb_build_object('offerVersion',p_offer_version,'admitted',false));
 invalid CONSTANT jsonb := '{"kind":"refusal","reason":"invalid_request"}';
BEGIN
 -- The private admission issue mode. Its dispatch compares exact bytes, whatever the caller's collation.
 IF p_mode COLLATE pg_catalog."C" OPERATOR(pg_catalog.=) 'admission_issue' THEN
  DECLARE
   continued jsonb; start_at integer := 0; roster_size bigint; member_count bigint; chosen uuid; chosen_eligible boolean;
   page_keys jsonb; consulted jsonb;
   uuid_shape CONSTANT text := '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$';
   token_keys CONSTANT text[] := ARRAY['selectedSkuId','offset','offerVersion','mode','headDigest','limit','binding'];
   inconsistent CONSTANT jsonb := '{"kind":"refusal","reason":"inconsistent_evidence"}';
   moved CONSTANT jsonb := '{"kind":"refusal","reason":"head_moved"}';
  BEGIN
   -- Validate the closed input shape before any cast or read. A continuation's request context, binding,
   -- alignment and roster position are compared only after the head digest.
   IF public.catalog_publication_text_valid(to_jsonb(p_offer_version),240,true) IS DISTINCT FROM true
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR jsonb_typeof(p_cursor) IS DISTINCT FROM 'object' THEN RETURN invalid; END IF;
   continued := p_cursor->'continuation';
   IF p_cursor - ARRAY['selectedSkuId','continuation'] <> '{}'::jsonb
    OR (jsonb_typeof(p_cursor->'selectedSkuId')='string' AND p_cursor->>'selectedSkuId' COLLATE pg_catalog."C" ~ uuid_shape) IS DISTINCT FROM true
    OR (continued IS NOT NULL AND jsonb_typeof(continued) IS DISTINCT FROM 'object') THEN RETURN invalid; END IF;
   IF continued IS NOT NULL THEN
    IF NOT continued ?& token_keys OR continued - token_keys <> '{}'::jsonb
     OR (jsonb_typeof(continued->'selectedSkuId')='string' AND continued->>'selectedSkuId' COLLATE pg_catalog."C" ~ uuid_shape) IS DISTINCT FROM true
     OR jsonb_typeof(continued->'offerVersion') IS DISTINCT FROM 'string'
     OR continued->'mode' IS DISTINCT FROM '"admission_issue"'::jsonb
     OR (jsonb_typeof(continued->'headDigest')='string' AND continued->>'headDigest' COLLATE pg_catalog."C" ~ '^[0-9a-f]{64}$') IS DISTINCT FROM true
     OR (jsonb_typeof(continued->'binding')='string' AND continued->>'binding' COLLATE pg_catalog."C" ~ '^[0-9a-f]{64}$') IS DISTINCT FROM true
     OR (jsonb_typeof(continued->'limit')='number' AND continued->>'limit' COLLATE pg_catalog."C" ~ '^[1-9][0-9]{0,2}$') IS DISTINCT FROM true
     OR (jsonb_typeof(continued->'offset')='number' AND continued->>'offset' COLLATE pg_catalog."C" ~ '^[1-9][0-9]{0,2}$') IS DISTINCT FROM true
    THEN RETURN invalid; END IF;
    start_at := (continued->>'offset')::integer;
    IF (continued->>'limit')::integer > 100 OR start_at > 499 THEN RETURN invalid; END IF;
   END IF;
   chosen := (p_cursor->>'selectedSkuId')::uuid;
   authority := public.catalog_publication_read_head();
   IF authority->>'kind'='refusal' THEN RETURN authority; END IF;
   IF authority->>'kind'='legacy' THEN RETURN '{"kind":"refusal","reason":"unknown_offer"}'::jsonb; END IF;
   -- The same two-way sealed and live roster check as the other modes, keeping the member count.
   WITH sealed AS MATERIALIZED (
    SELECT h.product_id,(r->>'skuId')::uuid AS sku_id,m.body #> '{product,status}' AS product_status,
     CASE WHEN m.body->'schemaVersion'='3'::jsonb THEN m.body #> '{product,lifecycleState}' END AS product_lifecycle,
     f.memberships,f.status AS sku_status,
     CASE WHEN m.body->'schemaVersion'='3'::jsonb THEN f."lifecycleState" END AS sku_lifecycle,f."sellableStandalone" AS standalone,f."sellableInSubscription" AS subscription
    FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)
    CROSS JOIN LATERAL (SELECT p.canonical_state::jsonb AS body) m
    CROSS JOIN LATERAL jsonb_array_elements(m.body->'skus') r
    LEFT JOIN LATERAL jsonb_to_record(public.catalog_publication_read_sku_revision(h.product_id,r))
     AS f(memberships jsonb,status jsonb,"lifecycleState" jsonb,"sellableStandalone" jsonb,"sellableInSubscription" jsonb) ON true
   ), live AS (
    SELECT s.product_id,s.id AS sku_id,s.publication_facts->'memberships' AS memberships,to_jsonb(p.status) AS product_status,
     CASE WHEN p.publication_facts->'schemaVersion'='3'::jsonb THEN p.publication_facts->'lifecycleState' END AS product_lifecycle,
     to_jsonb(s.status) AS sku_status,
     CASE WHEN s.publication_facts->'schemaVersion'='3'::jsonb THEN s.publication_facts->'lifecycleState' END AS sku_lifecycle,to_jsonb(s.sellable_standalone) AS standalone,to_jsonb(s.sellable_in_subscription) AS subscription
    FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id
    JOIN public.catalog_publication_heads h ON h.product_id=s.product_id
    WHERE s.publication_facts->'memberships' @> admitted OR s.publication_facts->'memberships' @> denied
   )
   SELECT bool_or(s.sku_id IS NOT NULL AND (s.memberships IS NULL OR
     (s.product_status IN ('"draft"'::jsonb,'"active"'::jsonb,'"archived"'::jsonb,'"withdrawn"'::jsonb)) IS DISTINCT FROM true)),
    bool_or(coalesce(s.memberships @> admitted OR s.memberships @> denied,false) IS DISTINCT FROM (l.sku_id IS NOT NULL)
     OR (l.sku_id IS NOT NULL AND (l.memberships,l.product_status,l.sku_status,l.product_lifecycle,l.sku_lifecycle,l.standalone,l.subscription)
      IS DISTINCT FROM (s.memberships,s.product_status,s.sku_status,s.product_lifecycle,s.sku_lifecycle,s.standalone,s.subscription))),
    count(l.sku_id)
   INTO invalid_projection,live_drift,roster_size FROM sealed s FULL JOIN live l USING (product_id,sku_id);
   IF invalid_projection THEN RETURN inconsistent; END IF;
   IF live_drift THEN RETURN inconsistent || '{"detail":"catalog_publication_live_drift"}'::jsonb; END IF;
   IF roster_size=0 THEN RETURN '{"kind":"refusal","reason":"unknown_offer"}'::jsonb; END IF;
   IF roster_size>500 THEN RETURN inconsistent || '{"detail":"catalog_admission_membership_cap_exceeded"}'::jsonb; END IF;
   IF roster_size>20*p_limit THEN RETURN inconsistent || '{"detail":"catalog_admission_page_cap_exceeded"}'::jsonb; END IF;
   -- Materialize at most 500 candidate keys: the in-scope head digest, the selection's eligibility and the page.
   WITH roster AS MATERIALIZED (
    SELECT s.id AS sku_id,s.product_id,(s.publication_facts->'memberships' @> admitted AND s.status='active' AND p.status='active'
      AND (p.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb OR p.publication_facts->>'lifecycleState'='active')
      AND (s.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb OR s.publication_facts->>'lifecycleState'='active')
      AND s.sellable_in_subscription) IS TRUE AS eligible
    FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id
    JOIN public.catalog_publication_heads h ON h.product_id=s.product_id
    WHERE s.publication_facts->'memberships' @> admitted OR s.publication_facts->'memberships' @> denied
   )
   SELECT count(*),coalesce(bool_or(sku_id=chosen AND eligible),false),
    (SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(h.product_id,h.publication_id,h.revision,p.digest)
      ORDER BY h.product_id)::text,'UTF8')),'hex')
     FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)
     WHERE h.product_id IN (SELECT product_id FROM roster)),
    (SELECT jsonb_agg(jsonb_build_array(sku_id,product_id) ORDER BY sku_id)
     FROM (SELECT sku_id,product_id FROM roster ORDER BY sku_id OFFSET start_at LIMIT p_limit) slice)
   INTO member_count,chosen_eligible,head_digest,page_keys FROM roster;
   IF member_count IS DISTINCT FROM roster_size THEN RETURN inconsistent; END IF;
   IF continued IS NOT NULL THEN
    IF continued->'headDigest' IS DISTINCT FROM to_jsonb(head_digest) THEN RETURN moved; END IF;
    -- The binding covers the request's offer, selection and page size, the mode, the token's offset and the head digest.
    IF continued->'selectedSkuId' IS DISTINCT FROM p_cursor->'selectedSkuId' OR continued->'offerVersion' IS DISTINCT FROM to_jsonb(p_offer_version)
     OR continued->'limit' IS DISTINCT FROM to_jsonb(p_limit) OR continued->>'binding' IS DISTINCT FROM encode(sha256(convert_to(
      jsonb_build_array(p_offer_version,p_cursor->'selectedSkuId','admission_issue',p_limit,start_at,head_digest)::text,'UTF8')),'hex')
    THEN RETURN invalid; END IF;
    IF start_at % p_limit <> 0 OR start_at >= roster_size THEN RETURN invalid; END IF;
   END IF;
   IF NOT chosen_eligible THEN RETURN invalid || '{"detail":"catalog_admission_selection_ineligible"}'::jsonb; END IF;
   -- Resolve only the page. read_head authenticated every current head; after confirming the global head digest,
   -- each page product's head is parsed and its product-bound document checked against the head manifest.
   -- Each earlier issuing publication is authenticated once through its manifest, exact reference and document.
   WITH current_heads AS MATERIALIZED (
    SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(h.product_id,h.publication_id,h.revision,p.digest)
      ORDER BY h.product_id)::text,'UTF8')),'hex') AS digest
    FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)
   ), page AS MATERIALIZED (
    SELECT (k->>0)::uuid AS sku_id,(k->>1)::uuid AS product_id FROM jsonb_array_elements(page_keys) AS entry(k)
   ), heads AS MATERIALIZED (
    SELECT c.product_id,c.id AS head_id,c.canonical_state::jsonb AS body,
     jsonb_build_object('publicationId',c.id,'revision',c.revision,'documentDigest',d.digest) AS head,
     jsonb_build_object('id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,'schemaId',d.schema_id,
      'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest) AS document
    FROM (SELECT DISTINCT product_id FROM page) g
    JOIN public.catalog_publication_heads h ON h.product_id=g.product_id
    JOIN public.catalog_publications c ON (c.product_id,c.id,c.revision)=(h.product_id,h.publication_id,h.revision)
    LEFT JOIN public.catalog_product_document_revisions d ON (d.product_id,d.id)=(c.product_id,c.document_revision_id)
   ), members AS MATERIALIZED (
    SELECT g.sku_id,g.product_id,hd.head_id,hd.head,hd.body #> '{product,document}'=hd.document AS head_bound,
     ref.r AS reference,rev.id AS revision_id,rev.publication_id AS issue_id
    FROM page g LEFT JOIN heads hd USING (product_id)
    LEFT JOIN LATERAL (SELECT r FROM jsonb_array_elements(hd.body->'skus') r WHERE r->'skuId'=to_jsonb(g.sku_id)) ref ON true
    -- One exact sealed-revision lookup per page member; OFFSET 0 keeps it per member.
    LEFT JOIN LATERAL (SELECT s.id,s.publication_id FROM public.catalog_sku_revisions s WHERE s.id=(ref.r->>'revisionId')::uuid
     AND (s.product_id,s.sku_id,s.revision,s.digest)=(g.product_id,g.sku_id,(ref.r->>'revision')::integer,ref.r->>'digest') OFFSET 0) rev ON true
   ), origins AS MATERIALIZED (
    SELECT o.id,o.product_id,jsonb_build_object('publicationId',o.id,'revision',o.revision,'documentDigest',d.digest) AS issue,
     public.catalog_publication_read_manifest(o.product_id,o.canonical_state,o.digest) AS body,
     jsonb_build_object('id',d.id,'productId',d.product_id,'revisionNo',d.revision_no,'schemaId',d.schema_id,
      'documentRef',d.document_ref,'sourceRef',d.source_ref,'digest',d.digest) AS document
    FROM public.catalog_publications o
    JOIN public.catalog_product_document_revisions d ON (d.product_id,d.id)=(o.product_id,o.document_revision_id)
    WHERE (o.product_id,o.id) IN (SELECT product_id,issue_id FROM members WHERE issue_id<>head_id)
   ), checked AS (
    SELECT m.sku_id,m.product_id,m.revision_id,CASE WHEN m.issue_id=m.head_id THEN m.head ELSE o.issue END AS issue,
     CASE WHEN m.head_bound IS NOT TRUE OR m.revision_id IS NULL OR (m.issue_id<>m.head_id AND (o.body IS NULL
       OR o.body #> '{product,document}' IS DISTINCT FROM o.document
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(o.body->'skus') x WHERE x=m.reference))) THEN inconsistent END AS refusal
    FROM members m LEFT JOIN origins o ON (o.product_id,o.id)=(m.product_id,m.issue_id)
   )
   SELECT CASE WHEN (SELECT digest FROM current_heads) IS DISTINCT FROM authority->>'headDigest' THEN moved
     ELSE (array_agg(refusal ORDER BY sku_id) FILTER (WHERE refusal IS NOT NULL))[1] END,
    jsonb_agg(jsonb_build_object('kind',CASE WHEN sku_id=chosen THEN 'declaring' ELSE 'compared' END,'productId',product_id,
     'publicationId',issue->'publicationId','revision',issue->'revision','documentDigest',issue->'documentDigest',
     'skuRevisionId',revision_id) ORDER BY sku_id),
    (SELECT jsonb_agg(jsonb_build_object('productId',product_id) || head ORDER BY product_id) FROM heads)
   INTO failed,items,consulted FROM checked;
   IF failed IS NOT NULL THEN RETURN failed; END IF;
   IF jsonb_array_length(items) IS DISTINCT FROM least(p_limit::bigint,roster_size-start_at) THEN RETURN inconsistent; END IF;
   RETURN jsonb_build_object('kind','page','value',jsonb_build_object('issues',items,'consultedHeads',consulted,
    'rosterCount',roster_size,'nextCursor',CASE WHEN start_at+p_limit<roster_size THEN jsonb_build_object(
     'selectedSkuId',p_cursor->'selectedSkuId','offset',start_at+p_limit,'offerVersion',p_offer_version,
     'mode','admission_issue','headDigest',head_digest,'limit',p_limit,'binding',encode(sha256(convert_to(
      jsonb_build_array(p_offer_version,p_cursor->'selectedSkuId','admission_issue',p_limit,start_at+p_limit,head_digest)::text,'UTF8')),'hex')) END));
  END;
 END IF;
 IF public.catalog_publication_text_valid(to_jsonb(p_offer_version),240,true) IS DISTINCT FROM true
  OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_mode NOT IN ('one_time','subscription') THEN RETURN invalid; END IF;
 IF p_cursor IS NOT NULL THEN
  IF jsonb_typeof(p_cursor) IS DISTINCT FROM 'object' THEN RETURN invalid; END IF;
  IF p_cursor - ARRAY['skuId','headDigest','offerVersion','mode'] <> '{}'::jsonb
   OR (jsonb_typeof(p_cursor->'skuId')='string' AND p_cursor->>'skuId' COLLATE "C" ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS DISTINCT FROM true
   OR (jsonb_typeof(p_cursor->'headDigest')='string' AND p_cursor->>'headDigest' COLLATE "C" ~ '^[0-9a-f]{64}$') IS DISTINCT FROM true
   OR p_cursor->'offerVersion' IS DISTINCT FROM to_jsonb(p_offer_version)
   OR p_cursor->'mode' IS DISTINCT FROM coalesce(to_jsonb(p_mode),'null'::jsonb) THEN RETURN invalid; END IF;
  after_id := (p_cursor->>'skuId')::uuid;
 END IF;
 authority := public.catalog_publication_read_head();
 IF authority->>'kind'='refusal' THEN RETURN authority; END IF;
 head_digest := authority->>'headDigest';
 IF p_cursor IS NOT NULL AND head_digest IS DISTINCT FROM p_cursor->>'headDigest' THEN
  RETURN '{"kind":"refusal","reason":"head_moved"}'::jsonb;
 END IF;
 IF authority->>'kind'='legacy' THEN
  RETURN '{"kind":"page","value":{"protocol":"legacy","headDigest":null,"items":[],"nextCursor":null}}'::jsonb;
 END IF;
 -- The head reader authenticated these manifests in the same statement snapshot.
 -- Check both directions before trusting live offer existence or page filters.
 WITH sealed AS MATERIALIZED (
  SELECT h.product_id,(r->>'skuId')::uuid AS sku_id,m.body #> '{product,status}' AS product_status,
   CASE WHEN m.body->'schemaVersion'='3'::jsonb THEN m.body #> '{product,lifecycleState}' END AS product_lifecycle,
   f.memberships,f.status AS sku_status,
   CASE WHEN m.body->'schemaVersion'='3'::jsonb THEN f."lifecycleState" END AS sku_lifecycle,f."sellableStandalone" AS standalone,f."sellableInSubscription" AS subscription
  FROM public.catalog_publication_heads h JOIN public.catalog_publications p ON (p.product_id,p.id)=(h.product_id,h.publication_id)
  CROSS JOIN LATERAL (SELECT p.canonical_state::jsonb AS body) m
  CROSS JOIN LATERAL jsonb_array_elements(m.body->'skus') r
  LEFT JOIN LATERAL jsonb_to_record(public.catalog_publication_read_sku_revision(h.product_id,r))
   AS f(memberships jsonb,status jsonb,"lifecycleState" jsonb,"sellableStandalone" jsonb,"sellableInSubscription" jsonb) ON true
 ), live AS (
  SELECT s.product_id,s.id AS sku_id,s.publication_facts->'memberships' AS memberships,to_jsonb(p.status) AS product_status,
   CASE WHEN p.publication_facts->'schemaVersion'='3'::jsonb THEN p.publication_facts->'lifecycleState' END AS product_lifecycle,
   to_jsonb(s.status) AS sku_status,
   CASE WHEN s.publication_facts->'schemaVersion'='3'::jsonb THEN s.publication_facts->'lifecycleState' END AS sku_lifecycle,to_jsonb(s.sellable_standalone) AS standalone,to_jsonb(s.sellable_in_subscription) AS subscription
  FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id
  JOIN public.catalog_publication_heads h ON h.product_id=s.product_id
  WHERE s.publication_facts->'memberships' @> admitted OR s.publication_facts->'memberships' @> denied
 )
 SELECT bool_or(s.sku_id IS NOT NULL AND (s.memberships IS NULL OR
   (s.product_status IN ('"draft"'::jsonb,'"active"'::jsonb,'"archived"'::jsonb,'"withdrawn"'::jsonb)) IS DISTINCT FROM true)),
  bool_or(coalesce(s.memberships @> admitted OR s.memberships @> denied,false) IS DISTINCT FROM (l.sku_id IS NOT NULL)
   OR (l.sku_id IS NOT NULL AND (l.memberships,l.product_status,l.sku_status,l.product_lifecycle,l.sku_lifecycle,l.standalone,l.subscription)
    IS DISTINCT FROM (s.memberships,s.product_status,s.sku_status,s.product_lifecycle,s.sku_lifecycle,s.standalone,s.subscription))),
  count(l.sku_id)>0
 INTO invalid_projection,live_drift,offer_known FROM sealed s FULL JOIN live l USING (product_id,sku_id);
 IF invalid_projection THEN RETURN '{"kind":"refusal","reason":"inconsistent_evidence"}'::jsonb; END IF;
 IF live_drift THEN RETURN '{"kind":"refusal","reason":"inconsistent_evidence","detail":"catalog_publication_live_drift"}'::jsonb; END IF;
 IF NOT offer_known THEN
  RETURN '{"kind":"refusal","reason":"unknown_offer"}'::jsonb;
 END IF;
 WITH eligible AS MATERIALIZED (
  SELECT s.id,s.product_id,s.net_weight_g FROM public.catalog_skus s JOIN public.catalog_products p ON p.id=s.product_id
  JOIN public.catalog_publication_heads h ON h.product_id=p.id
  WHERE s.publication_facts->'memberships' @> admitted AND s.status='active' AND p.status='active'
   -- Defence in depth over the SQL rule that a non-active SKU has both sellable flags false.
   AND (p.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb OR p.publication_facts->>'lifecycleState'='active')
   AND (s.publication_facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb OR s.publication_facts->>'lifecycleState'='active')
   AND ((p_mode IS DISTINCT FROM 'subscription' AND s.sellable_standalone) OR (p_mode IS DISTINCT FROM 'one_time' AND s.sellable_in_subscription))
   AND (after_id IS NULL OR s.id>after_id) ORDER BY s.id LIMIT p_limit+1
 ), page AS MATERIALIZED (
  SELECT * FROM eligible ORDER BY id LIMIT p_limit
 ), members AS MATERIALIZED (
  SELECT *,public.catalog_publication_selected_evidence(product_id,id) AS e FROM page
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('skuId',id,'productId',product_id,'skuCode',e#>'{sku,code}',
  'productSlug',e#>'{product,slug}','netWeightG',net_weight_g,'sellableStandalone',e#>'{sku,sellableStandalone}',
  'sellableInSubscription',e#>'{sku,sellableInSubscription}','presentation',e#>'{product,presentation}',
  'logisticsRef',e#>'{sku,logisticsRef}','head',e->'head','document',e->'document','skuRevision',e->'skuRevision') ORDER BY id)
  FILTER (WHERE e->>'kind'='evidence'),'[]'::jsonb),
  (array_agg(coalesce(e,'{"kind":"refusal","reason":"inconsistent_evidence"}'::jsonb) ORDER BY id)
   FILTER (WHERE e->>'kind' IS DISTINCT FROM 'evidence'))[1],
  CASE WHEN (SELECT count(*) FROM eligible)>p_limit THEN (SELECT id FROM page ORDER BY id DESC LIMIT 1) END
 INTO items,failed,next_id FROM members;
 IF failed IS NOT NULL THEN RETURN failed; END IF;
 RETURN jsonb_build_object('kind','page','value',jsonb_build_object('protocol','governed','headDigest',head_digest,'items',items,'nextCursor',
  CASE WHEN next_id IS NOT NULL THEN jsonb_build_object('skuId',next_id,'headDigest',head_digest,'offerVersion',p_offer_version,'mode',p_mode) END));
END;
$$;
