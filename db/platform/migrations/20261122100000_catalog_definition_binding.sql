-- Native-only catalogue definitions and nullable live type references.
-- Owner-only installation; no publication, data backfill or runtime activation.
CREATE TABLE public.catalog_type_versions (
  type_key text NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  definition_digest text NOT NULL,
  validator_ref text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (type_key, version)
);
CREATE TABLE public.catalog_definition_installs (
  pack_id text NOT NULL,
  pack_version integer NOT NULL CHECK (pack_version BETWEEN 1 AND 2147483647),
  manifest_digest text NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  installed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_id, pack_version)
);
CREATE TABLE public.catalog_tax_classes (
  key text PRIMARY KEY,
  label text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired'))
);
ALTER TABLE public.catalog_type_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_definition_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_tax_classes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.catalog_type_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.catalog_definition_installs FROM PUBLIC;
REVOKE ALL ON TABLE public.catalog_tax_classes FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_type_versions, public.catalog_definition_installs, public.catalog_tax_classes FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_type_versions, public.catalog_definition_installs, public.catalog_tax_classes FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON TABLE public.catalog_type_versions, public.catalog_definition_installs, public.catalog_tax_classes FROM service_role;'; END IF; END; $$;

CREATE FUNCTION public.catalog_type_version_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'catalog_type_version_immutable' USING ERRCODE = '55000';
END;
$$;
CREATE FUNCTION public.catalog_definition_install(p_pack_id text, p_pack_version integer, p_manifest jsonb)
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
  INSERT INTO public.catalog_definition_installs(pack_id, pack_version, manifest_digest, receipt)
    VALUES (p_pack_id, p_pack_version, v_digest, v_receipt);
  RETURN v_receipt;
END;
$$;
REVOKE ALL ON FUNCTION public.catalog_type_version_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.catalog_definition_install(text,integer,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_type_version_immutable(), public.catalog_definition_install(text,integer,jsonb) FROM anon;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_type_version_immutable(), public.catalog_definition_install(text,integer,jsonb) FROM authenticated;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'REVOKE ALL ON FUNCTION public.catalog_type_version_immutable(), public.catalog_definition_install(text,integer,jsonb) FROM service_role;'; END IF; END; $$;
CREATE TRIGGER catalog_type_version_immutable
BEFORE UPDATE OR DELETE ON public.catalog_type_versions
FOR EACH ROW EXECUTE FUNCTION public.catalog_type_version_immutable();

ALTER TABLE public.catalog_products ADD COLUMN type_key text, ADD COLUMN type_version integer;
ALTER TABLE public.catalog_products ADD CONSTRAINT catalog_products_type_binding_check CHECK ((type_key IS NULL AND type_version IS NULL) OR (type_key IS NOT NULL AND type_version IS NOT NULL)) NOT VALID;
ALTER TABLE public.catalog_products VALIDATE CONSTRAINT catalog_products_type_binding_check;
ALTER TABLE public.catalog_products ADD CONSTRAINT catalog_products_type_version_fk FOREIGN KEY (type_key, type_version) REFERENCES public.catalog_type_versions(type_key, version) NOT VALID;
ALTER TABLE public.catalog_products VALIDATE CONSTRAINT catalog_products_type_version_fk;
CREATE INDEX catalog_products_type_status_idx ON public.catalog_products(type_key, type_version, status, id);
