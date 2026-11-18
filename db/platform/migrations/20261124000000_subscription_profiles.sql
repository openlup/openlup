-- Profile identities extend the existing catalogue acceptance proof. The
-- same retained reference assertion serves current admission and replay.
CREATE OR REPLACE FUNCTION public.catalog_accepted_reference_assert_v2(p_reference jsonb) RETURNS void
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE publication public.catalog_publications%ROWTYPE; revision public.catalog_sku_revisions%ROWTYPE;
 manifest jsonb; facts jsonb; reference jsonb; document_digest text; profile_ref jsonb;
BEGIN
 IF jsonb_typeof(p_reference) IS DISTINCT FROM 'object' OR p_reference->'schemaVersion' IS DISTINCT FROM '2'::jsonb
  OR NOT (p_reference ?& ARRAY['schemaVersion','skuId','skuCode','skuRevisionId','publicationHead','typeRef','definitionDigest','optionDigest','netContent'])
  OR p_reference - ARRAY['schemaVersion','skuId','skuCode','skuRevisionId','publicationHead','typeRef','definitionDigest','optionDigest','netContent','demandPolicyRef','subscriptionProfile'] <> '{}'::jsonb THEN
  RAISE EXCEPTION 'catalog_accepted_reference_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO publication FROM public.catalog_publications WHERE id=(p_reference#>>'{publicationHead,publicationId}')::uuid;
 SELECT * INTO revision FROM public.catalog_sku_revisions WHERE id=(p_reference->>'skuRevisionId')::uuid AND sku_id=(p_reference->>'skuId')::uuid;
 IF publication.id IS NULL OR revision.id IS NULL OR publication.product_id<>revision.product_id THEN
  RAISE EXCEPTION 'catalog_retained_revision_unavailable' USING ERRCODE='22023'; END IF;
 manifest:=publication.canonical_state::jsonb; facts:=revision.full_facts::jsonb;
 SELECT digest INTO document_digest FROM public.catalog_product_document_revisions WHERE id=publication.document_revision_id AND product_id=publication.product_id;
 IF encode(sha256(convert_to(publication.canonical_state,'UTF8')),'hex')<>publication.digest
  OR encode(sha256(convert_to(revision.full_facts,'UTF8')),'hex')<>revision.digest
  OR (manifest->'schemaVersion' IS NULL OR manifest->'schemaVersion' NOT IN ('3'::jsonb,'4'::jsonb)) OR facts->'schemaVersion' IS DISTINCT FROM '3'::jsonb
  OR p_reference->'publicationHead' IS DISTINCT FROM jsonb_build_object('publicationId',publication.id,'revision',publication.revision,'documentDigest',document_digest)
  OR facts->>'id' IS DISTINCT FROM p_reference->>'skuId' OR facts->>'code' IS DISTINCT FROM p_reference->>'skuCode'
  OR manifest->'product'->'type' IS DISTINCT FROM p_reference->'typeRef'
  OR manifest->'product'->'definitionDigest' IS DISTINCT FROM p_reference->'definitionDigest'
  OR facts->'optionDigest' IS DISTINCT FROM p_reference->'optionDigest' OR facts->'netContent' IS DISTINCT FROM p_reference->'netContent'
  OR (p_reference ? 'demandPolicyRef' AND facts->'demandPolicyRef' IS DISTINCT FROM p_reference->'demandPolicyRef')
  OR NOT EXISTS(SELECT 1 FROM public.catalog_type_versions t WHERE t.type_key=p_reference#>>'{typeRef,key}'
    AND t.version=(p_reference#>>'{typeRef,version}')::integer AND t.definition_digest=p_reference->>'definitionDigest')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(manifest->'skus') entry WHERE entry=jsonb_build_object('skuId',revision.sku_id,'revisionId',revision.id,'revision',revision.revision,'digest',revision.digest)) THEN
  RAISE EXCEPTION 'catalog_accepted_reference_mismatch' USING ERRCODE='22023'; END IF;
 IF p_reference ? 'subscriptionProfile' THEN
  SELECT t.definition->'subscriptionProfileRef' INTO profile_ref FROM public.catalog_type_versions t
   WHERE t.type_key=p_reference#>>'{typeRef,key}' AND t.version=(p_reference#>>'{typeRef,version}')::integer;
  IF jsonb_typeof(profile_ref) IS DISTINCT FROM 'object'
   OR manifest#>'{product,subscriptionProfileRef}' IS DISTINCT FROM profile_ref
   OR NOT coalesce(manifest#>>'{product,subscriptionProfileDigest}' ~ '^[0-9a-f]{64}$',false)
   OR p_reference->'subscriptionProfile' IS DISTINCT FROM
     (profile_ref||jsonb_build_object('digest',manifest#>'{product,subscriptionProfileDigest}')) THEN
   RAISE EXCEPTION 'policy_binding_missing' USING ERRCODE='22023'; END IF;
 END IF;
END;
$$;

-- These hooks run inside the existing writers' transactions. The narrow
-- read-only helper can compare governed facts under restricted runtime roles.
CREATE FUNCTION public.catalog_subscription_profile_assert_acceptance(p_proof jsonb,p_subscription_id uuid,p_boundary text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE retained jsonb;
BEGIN
 IF p_boundary IN ('renewal','legacy_edit') THEN
  SELECT catalog_acceptance INTO retained FROM public.subscription_renewal_terms WHERE subscription_id=p_subscription_id;
  IF jsonb_path_exists(retained,'$.lines[*].subscriptionProfile') OR jsonb_path_exists(p_proof,'$.lines[*].subscriptionProfile') THEN
   IF p_boundary='legacy_edit' THEN RAISE EXCEPTION 'policy_binding_missing' USING ERRCODE='22023'; END IF;
   IF p_proof IS DISTINCT FROM retained THEN RAISE EXCEPTION 'profile_attachment_invalid' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_boundary='renewal' THEN RETURN; END IF;
 END IF;
 IF p_boundary NOT IN ('order','payment','edit','legacy_edit') OR p_boundary IS NULL THEN
  RAISE EXCEPTION 'profile_attachment_invalid' USING ERRCODE='22023'; END IF;
 IF EXISTS (
   SELECT 1 FROM jsonb_array_elements(p_proof->'lines') ref
   JOIN public.catalog_publications p ON p.id=(ref#>>'{publicationHead,publicationId}')::uuid
   JOIN public.catalog_type_versions t ON t.type_key=ref#>>'{typeRef,key}'
     AND t.version=(ref#>>'{typeRef,version}')::integer
   WHERE NOT (ref ? 'subscriptionProfile') AND
    (p.canonical_state::jsonb->'product' ? 'subscriptionProfileRef' OR t.definition ? 'subscriptionProfileRef')
 ) THEN
  RAISE EXCEPTION 'policy_binding_missing' USING ERRCODE='22023'; END IF;
 IF p_boundary='payment' THEN PERFORM public.catalog_acceptance_assert_v2(p_proof); END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_subscription_profile_assert_acceptance(jsonb,uuid,text) FROM PUBLIC;

CREATE FUNCTION public.catalog_subscription_profile_acceptance_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE proof jsonb;
BEGIN
 proof:=NEW.catalog_acceptance;
 IF TG_TABLE_NAME='commerce_orders' THEN
  IF TG_OP='UPDATE' THEN
   IF OLD.status='paid' OR NEW.status IS DISTINCT FROM 'paid'
    OR NOT coalesce(jsonb_path_exists(OLD.catalog_acceptance,'$.lines[*].subscriptionProfile'),false) THEN RETURN NEW; END IF;
   IF NEW.metadata#>>'{quoteSnapshot,quote,context,mode}' IS DISTINCT FROM 'subscription'
    OR proof IS DISTINCT FROM OLD.catalog_acceptance
    OR proof->'lines' IS DISTINCT FROM (SELECT jsonb_agg(s->'reference' ORDER BY s#>>'{reference,skuId}')
    FROM jsonb_array_elements(NEW.metadata#>'{quoteSnapshot,catalogAdmission,skuRevisions}') s) THEN
    RAISE EXCEPTION 'profile_attachment_invalid' USING ERRCODE='22023'; END IF;
   PERFORM public.catalog_subscription_profile_assert_acceptance(proof,NULL,'payment');
  ELSIF proof IS NOT NULL AND NEW.metadata#>>'{orderDraftSnapshot,context,mode}'='subscription' THEN
   PERFORM public.catalog_subscription_profile_assert_acceptance(proof,NULL,'order');
   IF jsonb_path_exists(proof,'$.lines[*].subscriptionProfile')
    AND NEW.metadata#>>'{quoteSnapshot,quote,context,mode}' IS DISTINCT FROM 'subscription' THEN
    RAISE EXCEPTION 'profile_attachment_invalid' USING ERRCODE='22023'; END IF;
  END IF;
 ELSIF proof IS NOT NULL THEN
  -- Fresh actor-only legacy edits cannot supply server profile admission.
  PERFORM public.catalog_subscription_profile_assert_acceptance(proof,NEW.subscription_id,
   CASE WHEN TG_OP='UPDATE' AND NEW.event_type='subscription.customer_self_service.update_bundle' AND NEW.payload ? 'commandKeyIdentity'
    THEN 'legacy_edit' ELSE 'edit' END);

 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_subscription_profile_acceptance_guard() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.catalog_subscription_profile_assert_acceptance(jsonb,uuid,text) TO service_role'; END IF; END; $$;
CREATE TRIGGER commerce_orders_subscription_profile_acceptance BEFORE INSERT OR UPDATE OF status ON public.commerce_orders FOR EACH ROW EXECUTE FUNCTION public.catalog_subscription_profile_acceptance_guard();
CREATE TRIGGER subscription_events_profile_acceptance BEFORE INSERT OR UPDATE OF catalog_acceptance ON public.subscription_events FOR EACH ROW EXECUTE FUNCTION public.catalog_subscription_profile_acceptance_guard();

CREATE OR REPLACE FUNCTION public.subscription_claim_due_renewal(
  p_identity_key text,
  p_operation_fingerprint text,
  p_cycle_snapshot jsonb,
  p_worker_id text,
  p_lease_seconds integer DEFAULT 300,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_subscription_id uuid;
  v_scheduled_at timestamptz;
  v_cycle_number integer;
  v_subscription public.subscriptions%ROWTYPE;
  v_operation public.subscription_renewal_operations%ROWTYPE;
BEGIN
  IF p_identity_key IS NULL OR p_operation_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_cycle_snapshot IS NULL OR jsonb_typeof(p_cycle_snapshot) <> 'object'
    OR p_cycle_snapshot->>'contractVersion' <> 'platform.subscription.renewal.v1'
    OR btrim(COALESCE(p_worker_id, '')) = ''
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_input' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_subscription_id := (p_cycle_snapshot->>'subscriptionId')::uuid;
    v_scheduled_at := (p_cycle_snapshot->>'scheduledAt')::timestamptz;
    v_cycle_number := (p_cycle_snapshot->>'cycleNumber')::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_snapshot' USING ERRCODE = '22023';
  END;

  IF v_cycle_number < 1
    OR p_identity_key <> public.subscription_renewal_identity(v_subscription_id, v_scheduled_at)
    OR jsonb_typeof(p_cycle_snapshot->'lines') <> 'array'
    OR jsonb_array_length(p_cycle_snapshot->'lines') = 0
    OR p_cycle_snapshot->>'currency' !~ '^[A-Z]{3}$'
    OR (p_cycle_snapshot->>'totalAmountMinor')::bigint < 1
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_subscription
    FROM public.subscriptions
   WHERE id = v_subscription_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_renewal_claim_not_due' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_operation
    FROM public.subscription_renewal_operations
   WHERE subscription_id = v_subscription_id AND scheduled_at = v_scheduled_at
   FOR UPDATE;

  IF FOUND THEN
    IF v_operation.identity_key <> p_identity_key
      OR v_operation.operation_fingerprint <> p_operation_fingerprint
      OR v_operation.cycle_snapshot <> p_cycle_snapshot
    THEN
      RAISE EXCEPTION 'subscription_renewal_claim_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_operation.state IN ('succeeded', 'refused') THEN
      RETURN public.subscription_renewal_operation_response(v_operation, false, true, 'terminal');
    END IF;
  END IF;

  -- Historical terminal truth survives schedule advancement and cancellation.
  -- Nonterminal/new work still needs the original eligibility under both locks.
  IF v_subscription.status <> 'active'
    OR v_subscription.next_cycle_at IS DISTINCT FROM v_scheduled_at
    OR v_subscription.next_cycle_at > COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'subscription_renewal_claim_not_due' USING ERRCODE = '22023';
  END IF;

  IF v_operation.id IS NOT NULL THEN
    IF v_operation.lease_expires_at > COALESCE(p_now, now()) THEN
      RETURN public.subscription_renewal_operation_response(v_operation, false, true, 'lease_active');
    END IF;
    UPDATE public.subscription_renewal_operations
       SET claim_token = gen_random_uuid(),
           claim_generation = claim_generation + 1,
           claimed_by = p_worker_id,
           claimed_at = COALESCE(p_now, now()),
           lease_expires_at = COALESCE(p_now, now()) + make_interval(secs => p_lease_seconds),
           updated_at = COALESCE(p_now, now())
     WHERE id = v_operation.id
     RETURNING * INTO v_operation;
    RETURN public.subscription_renewal_operation_response(v_operation, true, true, 'lease_taken_over');
  END IF;

  PERFORM public.catalog_subscription_profile_assert_acceptance(
    CASE WHEN p_cycle_snapshot->>'frozenRevision'='native.purchase-renewal.v3' THEN p_cycle_snapshot->'catalogAcceptance' END,
    v_subscription_id,'renewal');

  INSERT INTO public.subscription_renewal_operations (
    subscription_id, scheduled_at, cycle_number, identity_key, operation_fingerprint,
    cycle_snapshot, claim_token, claimed_by, claimed_at, lease_expires_at, updated_at
  ) VALUES (
    v_subscription_id, v_scheduled_at, v_cycle_number, p_identity_key,
    p_operation_fingerprint, p_cycle_snapshot, gen_random_uuid(), p_worker_id,
    COALESCE(p_now, now()), COALESCE(p_now, now()) + make_interval(secs => p_lease_seconds),
    COALESCE(p_now, now())
  ) RETURNING * INTO v_operation;
  RETURN public.subscription_renewal_operation_response(v_operation, true, false, 'claimed');
END;
$$;

CREATE OR REPLACE FUNCTION public.catalog_definition_install(p_pack_id text, p_pack_version integer, p_manifest jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_manifest jsonb := (p_manifest->>'manifest')::jsonb;
  v_digest text := encode(sha256(convert_to(p_manifest->>'manifest', 'UTF8')), 'hex');
  v_install public.catalog_definition_installs%ROWTYPE;
  v_type jsonb;
  v_definition jsonb;
  v_definition_digest text;
  v_existing public.catalog_type_versions%ROWTYPE;
  v_receipt jsonb;
  v_profiles jsonb := v_manifest->'subscriptionProfileDefinitions';
BEGIN
  IF v_manifest->>'id' IS DISTINCT FROM p_pack_id
    OR (v_manifest->>'version')::integer IS DISTINCT FROM p_pack_version
    OR jsonb_typeof(p_manifest->'types') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_manifest->'taxClasses') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_manifest->'types') IS DISTINCT FROM jsonb_array_length(p_manifest->'types') THEN
    RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE = '22023';
  END IF;
  -- One catalogue-domain guard, acquired before definition, tax-key or install-ledger rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('openlup:catalog-definitions', 0));
  SELECT * INTO v_install FROM public.catalog_definition_installs
    WHERE pack_id = p_pack_id AND pack_version = p_pack_version;
  IF FOUND THEN
    IF v_install.manifest_digest IS DISTINCT FROM v_digest THEN
      RAISE EXCEPTION 'catalog_definition_install_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN v_install.receipt;
  END IF;
  FOR v_type IN SELECT value FROM jsonb_array_elements(p_manifest->'types')
    ORDER BY (value->>'canonicalDefinition')::jsonb->>'key', ((value->>'canonicalDefinition')::jsonb->>'version')::integer
  LOOP
    v_definition := (v_type->>'canonicalDefinition')::jsonb;
    v_definition_digest := encode(sha256(convert_to(v_type->>'canonicalDefinition', 'UTF8')), 'hex');
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_manifest->'types') t
      WHERE t->>'key' = v_definition->>'key' AND (t->>'version')::integer = (v_definition->>'version')::integer
        AND t->>'definitionDigest' = v_definition_digest) THEN
      RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.catalog_type_versions(type_key, version, definition, definition_digest, validator_ref)
      VALUES (v_definition->>'key', (v_definition->>'version')::integer, v_definition,
        v_definition_digest, v_definition->>'validatorRef') ON CONFLICT (type_key, version) DO NOTHING;
    SELECT * INTO STRICT v_existing FROM public.catalog_type_versions
      WHERE type_key = v_definition->>'key' AND version = (v_definition->>'version')::integer;
    IF v_existing.definition IS DISTINCT FROM v_definition OR v_existing.definition_digest IS DISTINCT FROM v_definition_digest
      OR v_existing.validator_ref IS DISTINCT FROM v_definition->>'validatorRef' THEN
      RAISE EXCEPTION 'catalog_type_install_refuses_redefinition' USING ERRCODE = '23505';
    END IF;
  END LOOP;
  IF v_profiles IS NOT NULL THEN
    IF jsonb_typeof(v_profiles) IS DISTINCT FROM 'array' OR jsonb_array_length(v_profiles)>100 THEN
      RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_profiles) p
      WHERE jsonb_typeof(p) IS DISTINCT FROM 'object'
        OR coalesce(p->>'key','') !~ '^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$'
        OR char_length(p->>'key')>120
        OR jsonb_typeof(p->'version') IS DISTINCT FROM 'number'
        OR coalesce(p->>'version','') !~ '^[1-9][0-9]*$')
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_profiles) p GROUP BY p->'key',p->'version' HAVING count(*)>1)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_profiles) p
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_manifest->'subscriptionProfiles') r
          WHERE r=jsonb_build_object('key',p->'key','version',p->'version'))) THEN
      RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.catalog_definition_installs i
      CROSS JOIN LATERAL jsonb_array_elements(i.receipt->'subscriptionProfileDefinitions') prior
      JOIN jsonb_array_elements(v_profiles) p ON prior->'key'=p->'key' AND prior->'version'=p->'version'
      WHERE prior IS DISTINCT FROM p) THEN
      RAISE EXCEPTION 'catalog_profile_install_refuses_redefinition' USING ERRCODE='23505';
    END IF;
  END IF;
  IF (SELECT COALESCE(jsonb_agg(value->>'key' ORDER BY value->>'key'), '[]'::jsonb)
      FROM jsonb_array_elements(p_manifest->'taxClasses')) IS DISTINCT FROM
    (SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb) FROM jsonb_array_elements(v_manifest->'taxClasses')) THEN
    RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.catalog_tax_classes(key, label, status)
    SELECT value->>'key', value->>'label', 'active' FROM jsonb_array_elements(p_manifest->'taxClasses')
    ORDER BY value->>'key' ON CONFLICT (key) DO NOTHING;
  v_receipt := jsonb_build_object('packId', p_pack_id, 'packVersion', p_pack_version,
    'manifestDigest', v_digest, 'installedAt', clock_timestamp(), 'types', v_manifest->'types');
  IF v_profiles IS NOT NULL THEN
    v_receipt := v_receipt || jsonb_build_object('subscriptionProfileDefinitions',v_profiles);
  END IF;
  INSERT INTO public.catalog_definition_installs(pack_id, pack_version, manifest_digest, receipt)
    VALUES (p_pack_id, p_pack_version, v_digest, v_receipt);
  RETURN v_receipt;
END;
$$;
