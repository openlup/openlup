-- Native profile declarations belong to one immutable, versioned receipt.
CREATE TABLE public.catalog_subscription_profile_receipts (
  profile_key text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version BETWEEN 1 AND 2147483647),
  profile_digest text NOT NULL,
  declaration_bytes text NOT NULL,
  pack_id text NOT NULL,
  pack_version integer NOT NULL,
  declaration_position integer NOT NULL,
  PRIMARY KEY (pack_id, pack_version, declaration_position),
  FOREIGN KEY (pack_id, pack_version) REFERENCES public.catalog_definition_installs(pack_id, pack_version)
);
CREATE UNIQUE INDEX catalog_subscription_profile_receipts_identity
  ON public.catalog_subscription_profile_receipts(profile_key, profile_version);

ALTER TABLE public.catalog_subscription_profile_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.catalog_subscription_profile_receipts FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_subscription_profile_receipts FROM anon'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_subscription_profile_receipts FROM authenticated'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_subscription_profile_receipts FROM service_role'; END IF; END; $$;

-- The shared pack record retains the manifest and replay identity. Only the
-- profile receipt table carries individual installed declarations.
ALTER TABLE public.catalog_definition_installs
  ADD CONSTRAINT catalog_definition_install_profile_storage
  CHECK (receipt - 'subscriptionProfileDefinitions' = receipt);

CREATE FUNCTION public.catalog_subscription_profile_identity(p_key text, p_version integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('profileKey', r.profile_key, 'profileVersion', r.profile_version,
    'profileDigest', r.profile_digest, 'policyRef', r.declaration_bytes::jsonb->'policyRef',
    'policyDigest', r.declaration_bytes::jsonb->'policyDigest')
  FROM public.catalog_subscription_profile_receipts r
  WHERE r.profile_key = p_key AND r.profile_version = p_version
$$;

CREATE FUNCTION public.catalog_subscription_profile_receipt_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  declaration jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'catalog_definition_install_profile_immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.profile_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.declaration_bytes, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'catalog_profile_receipt_digest_mismatch' USING ERRCODE = '23514';
  END IF;
  declaration := NEW.declaration_bytes::jsonb;
  IF declaration->'key' IS DISTINCT FROM to_jsonb(NEW.profile_key)
    OR declaration->'version' IS DISTINCT FROM to_jsonb(NEW.profile_version) THEN
    RAISE EXCEPTION 'catalog_profile_receipt_identity_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.catalog_definition_install_profile_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.manifest_digest LIKE 'profiles-v1:%' OR NEW.manifest_digest LIKE 'profiles-v1:%'
    OR OLD.receipt ?| ARRAY['subscriptionProfileDefinitions', 'canonicalManifest']
    OR NEW.receipt ?| ARRAY['subscriptionProfileDefinitions', 'canonicalManifest'] THEN
    RAISE EXCEPTION 'catalog_definition_install_profile_immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.catalog_subscription_profile_identity(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_subscription_profile_receipt_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_definition_install_profile_immutable() FROM PUBLIC;
CREATE TRIGGER catalog_subscription_profile_receipt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.catalog_subscription_profile_receipts
  FOR EACH ROW EXECUTE FUNCTION public.catalog_subscription_profile_receipt_guard();
CREATE TRIGGER catalog_definition_install_profile_immutable
  BEFORE UPDATE OR DELETE ON public.catalog_definition_installs
  FOR EACH ROW EXECUTE FUNCTION public.catalog_definition_install_profile_immutable();

CREATE OR REPLACE FUNCTION public.catalog_definition_install(p_pack_id text, p_pack_version integer, p_manifest jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_manifest jsonb := (p_manifest->>'manifest')::jsonb;
  v_digest text := (CASE WHEN v_manifest ? 'subscriptionProfileDefinitions' THEN 'profiles-v1:' ELSE '' END)
    || encode(sha256(convert_to(p_manifest->>'manifest', 'UTF8')), 'hex');
  v_install public.catalog_definition_installs%ROWTYPE;
  v_type jsonb;
  v_definition jsonb;
  v_definition_digest text;
  v_existing public.catalog_type_versions%ROWTYPE;
  v_receipt jsonb;
  v_profiles jsonb := v_manifest->'subscriptionProfileDefinitions';
  v_profile jsonb;
  v_declaration_bytes text;
  v_position integer;
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
    IF v_profiles IS NOT NULL THEN
      RETURN v_install.receipt || jsonb_build_object('subscriptionProfileDefinitions', (
        SELECT jsonb_agg(r.declaration_bytes::jsonb || jsonb_build_object('profileDigest', r.profile_digest)
          ORDER BY r.declaration_position)
        FROM public.catalog_subscription_profile_receipts r
        WHERE r.pack_id = p_pack_id AND r.pack_version = p_pack_version
      ));
    END IF;
    RETURN v_install.receipt;
  END IF;
  IF v_profiles IS NOT NULL THEN
    v_receipt := jsonb_build_object('packId', p_pack_id, 'packVersion', p_pack_version,
      'manifestDigest', v_digest, 'installedAt', clock_timestamp(), 'types', v_manifest->'types',
      'canonicalManifest', p_manifest->>'manifest', 'subscriptionProfileDefinitions', v_profiles);
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'catalog_profile_install_requires_read_committed' USING ERRCODE = '25000';
    END IF;
    IF jsonb_typeof(p_manifest->'profileDeclarationBytes') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_manifest->'profileDeclarationBytes') IS DISTINCT FROM jsonb_array_length(v_profiles) THEN
      RAISE EXCEPTION 'catalog_profile_install_manifest_mismatch' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.catalog_definition_installs(pack_id, pack_version, manifest_digest, receipt)
      VALUES (p_pack_id, p_pack_version, v_digest, v_receipt - 'subscriptionProfileDefinitions');
    FOR v_profile, v_position IN
      SELECT value, ordinality::integer - 1 FROM jsonb_array_elements(v_profiles) WITH ORDINALITY
    LOOP
      v_declaration_bytes := p_manifest->'profileDeclarationBytes'->>v_position;
      IF v_declaration_bytes::jsonb IS DISTINCT FROM v_profile - 'profileDigest' THEN
        RAISE EXCEPTION 'catalog_profile_install_manifest_mismatch' USING ERRCODE = '22023';
      END IF;
      BEGIN
        INSERT INTO public.catalog_subscription_profile_receipts(
          profile_key, profile_version, profile_digest, declaration_bytes, pack_id, pack_version, declaration_position
        ) VALUES (
          v_profile->>'key', (v_profile->>'version')::integer, v_profile->>'profileDigest',
          v_declaration_bytes, p_pack_id, p_pack_version, v_position
        );
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'catalog_profile_install_refuses_redefinition' USING ERRCODE = '23505';
      END;
    END LOOP;
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
