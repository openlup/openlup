-- Native-only profile definitions extend the existing installation receipt.
CREATE FUNCTION public.catalog_subscription_profile_identity(p_key text, p_version integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('profileKey', p->'key', 'profileVersion', p->'version',
    'profileDigest', p->'profileDigest', 'policyRef', p->'policyRef', 'policyDigest', p->'policyDigest')
  FROM public.catalog_definition_installs i
  CROSS JOIN LATERAL jsonb_array_elements(i.receipt->'subscriptionProfileDefinitions') p
  WHERE p->>'key' = p_key AND p->'version' = to_jsonb(p_version)
  LIMIT 1
$$;

-- The original pack bytes and digest bind the profile list in install and restore.
CREATE FUNCTION public.catalog_definition_install_profile_manifest_matches(
  p_pack_id text, p_pack_version integer, p_digest text, p_receipt jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  canonical text := p_receipt->>'canonicalManifest';
  manifest jsonb;
BEGIN
  IF NOT (p_receipt ?| ARRAY['subscriptionProfileDefinitions', 'canonicalManifest']) THEN RETURN true; END IF;
  IF jsonb_typeof(p_receipt->'canonicalManifest') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_receipt->'subscriptionProfileDefinitions') IS DISTINCT FROM 'array'
    OR p_receipt->>'manifestDigest' IS DISTINCT FROM p_digest
    OR encode(sha256(convert_to(canonical, 'UTF8')), 'hex') IS DISTINCT FROM p_digest
    OR NOT pg_input_is_valid(canonical, 'jsonb') THEN
    RETURN false;
  END IF;
  manifest := canonical::jsonb;
  RETURN coalesce(manifest->'id' = to_jsonb(p_pack_id)
    AND manifest->'version' = to_jsonb(p_pack_version)
    AND p_receipt->'packId' = manifest->'id' AND p_receipt->'packVersion' = manifest->'version'
    AND p_receipt->'types' = manifest->'types'
    AND p_receipt->'subscriptionProfileDefinitions' = manifest->'subscriptionProfileDefinitions', false);
END;
$$;

CREATE FUNCTION public.catalog_definition_install_profile_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  profiles jsonb := NEW.receipt->'subscriptionProfileDefinitions';
  profile jsonb;
  ref jsonb;
  choice jsonb;
  days integer;
  prior_days integer;
  installed jsonb;
  profile_key_pattern CONSTANT text := '^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$';
  digest_pattern CONSTANT text := '^[0-9a-f]{64}$';
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.receipt ?| ARRAY['subscriptionProfileDefinitions', 'canonicalManifest']
      OR NEW.receipt ?| ARRAY['subscriptionProfileDefinitions', 'canonicalManifest'] THEN
      RAISE EXCEPTION 'catalog_definition_install_profile_immutable' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF profiles IS NULL AND NOT (NEW.receipt ? 'canonicalManifest') THEN RETURN NEW; END IF;

  -- Every profile receipt writer, including connected restore, shares the
  -- install lock and observes its predecessor in a fresh statement snapshot.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'catalog_profile_install_requires_read_committed' USING ERRCODE = '25000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('openlup:catalog-definitions', 0));
  IF NOT public.catalog_definition_install_profile_manifest_matches(NEW.pack_id, NEW.pack_version, NEW.manifest_digest, NEW.receipt) THEN
    RAISE EXCEPTION 'catalog_profile_install_manifest_mismatch' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(profiles) NOT BETWEEN 1 AND 100
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(profiles) p GROUP BY p->'key', p->'version' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'definition_profile_invalid' USING ERRCODE = '22023';
  END IF;

  FOR profile IN SELECT value FROM jsonb_array_elements(profiles) LOOP
    ref := profile->'policyRef';
    IF jsonb_typeof(profile) IS DISTINCT FROM 'object'
      OR profile - ARRAY['key', 'version', 'allowedCadences', 'maxFixedDays', 'policyRef', 'policyDigest', 'profileDigest'] <> '{}'::jsonb
      OR jsonb_typeof(profile->'policyDigest') IS DISTINCT FROM 'string'
      OR jsonb_typeof(profile->'profileDigest') IS DISTINCT FROM 'string'
      OR NOT coalesce(profile->>'policyDigest' ~ digest_pattern, false)
      OR NOT coalesce(profile->>'profileDigest' ~ digest_pattern, false)
      OR jsonb_typeof(ref) IS DISTINCT FROM 'object' OR ref - ARRAY['key', 'version'] <> '{}'::jsonb
      OR jsonb_typeof(profile->'allowedCadences') IS DISTINCT FROM 'array'
      OR (profile ? 'maxFixedDays' AND NOT (jsonb_typeof(profile->'maxFixedDays') = 'number'
        AND profile->>'maxFixedDays' ~ '^[1-9][0-9]*$' AND profile->'maxFixedDays' <= '3660'::jsonb)) THEN
      RAISE EXCEPTION 'definition_profile_invalid' USING ERRCODE = '22023';
    END IF;
    FOREACH ref IN ARRAY ARRAY[profile, ref] LOOP
      IF NOT coalesce(ref->>'key' ~ profile_key_pattern AND char_length(ref->>'key') <= 120
        AND jsonb_typeof(ref->'version') = 'number' AND ref->>'version' ~ '^[1-9][0-9]*$'
        AND ref->'version' <= '2147483647'::jsonb, false) THEN
        RAISE EXCEPTION 'definition_profile_invalid' USING ERRCODE = '22023';
      END IF;
    END LOOP;

    prior_days := 0;
    FOR choice IN SELECT value FROM jsonb_array_elements(profile->'allowedCadences') LOOP
      IF choice->>'kind' = 'calendar_months' THEN
        RAISE EXCEPTION 'cadence_kind_unsupported' USING ERRCODE = '22023';
      END IF;
      IF jsonb_typeof(choice) IS DISTINCT FROM 'object' OR choice->'schemaVersion' IS DISTINCT FROM '1'::jsonb
        OR choice->>'schemaVersion' IS DISTINCT FROM '1'
        OR choice->>'kind' IS DISTINCT FROM 'fixed_days' OR choice - ARRAY['schemaVersion', 'kind', 'days'] <> '{}'::jsonb
        OR NOT coalesce(jsonb_typeof(choice->'days') = 'number' AND choice->>'days' ~ '^[1-9][0-9]*$'
          AND choice->'days' <= '3660'::jsonb, false) THEN
        RAISE EXCEPTION 'definition_profile_invalid' USING ERRCODE = '22023';
      END IF;
      days := (choice->>'days')::integer;
      IF days <= prior_days THEN RAISE EXCEPTION 'definition_profile_invalid' USING ERRCODE = '22023'; END IF;
      prior_days := days;
    END LOOP;
    IF prior_days = 0 OR profile->>'profileDigest' IS DISTINCT FROM
      encode(sha256(convert_to(public.catalog_publication_canonical(profile - 'profileDigest', 0), 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'definition_profile_invalid' USING ERRCODE = '22023';
    END IF;

    installed := public.catalog_subscription_profile_identity(profile->>'key', (profile->>'version')::integer);
    IF installed IS NOT NULL AND installed->'profileDigest' IS DISTINCT FROM profile->'profileDigest' THEN
      RAISE EXCEPTION 'catalog_profile_install_refuses_redefinition' USING ERRCODE = '23505';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.catalog_subscription_profile_identity(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_definition_install_profile_manifest_matches(text,integer,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_definition_install_profile_immutable() FROM PUBLIC;
CREATE TRIGGER catalog_definition_install_profile_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.catalog_definition_installs
  FOR EACH ROW EXECUTE FUNCTION public.catalog_definition_install_profile_immutable();

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
  IF v_profiles IS NOT NULL THEN
    IF jsonb_typeof(v_profiles) IS DISTINCT FROM 'array'
      OR jsonb_typeof(v_manifest->'subscriptionProfiles') IS DISTINCT FROM 'array'
      OR public.catalog_publication_canonical(v_manifest, 0) IS DISTINCT FROM p_manifest->>'manifest' THEN
      RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_profiles) p
      WHERE NOT (v_manifest->'subscriptionProfiles' @> jsonb_build_array(jsonb_build_object('key', p->'key', 'version', p->'version')))) THEN
      RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE = '22023';
    END IF;
    -- The receipt guard validates the declarations before any type or tax-class writes.
    v_receipt := jsonb_build_object('packId', p_pack_id, 'packVersion', p_pack_version,
      'manifestDigest', v_digest, 'installedAt', clock_timestamp(), 'types', v_manifest->'types',
      'canonicalManifest', p_manifest->>'manifest', 'subscriptionProfileDefinitions', v_profiles);
    INSERT INTO public.catalog_definition_installs(pack_id, pack_version, manifest_digest, receipt)
      VALUES (p_pack_id, p_pack_version, v_digest, v_receipt);
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
  IF (SELECT COALESCE(jsonb_agg(value->>'key' ORDER BY value->>'key'), '[]'::jsonb)
      FROM jsonb_array_elements(p_manifest->'taxClasses')) IS DISTINCT FROM
    (SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb) FROM jsonb_array_elements(v_manifest->'taxClasses')) THEN
    RAISE EXCEPTION 'invalid_catalog_pack' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.catalog_tax_classes(key, label, status)
    SELECT value->>'key', value->>'label', 'active' FROM jsonb_array_elements(p_manifest->'taxClasses')
    ORDER BY value->>'key' ON CONFLICT (key) DO NOTHING;
  IF v_profiles IS NULL THEN
    v_receipt := jsonb_build_object('packId', p_pack_id, 'packVersion', p_pack_version,
      'manifestDigest', v_digest, 'installedAt', clock_timestamp(), 'types', v_manifest->'types');
    INSERT INTO public.catalog_definition_installs(pack_id, pack_version, manifest_digest, receipt)
      VALUES (p_pack_id, p_pack_version, v_digest, v_receipt);
  END IF;
  RETURN v_receipt;
END;
$$;
