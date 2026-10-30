-- M17 retained facts only. This forward creates no qualification, approval,
-- listing, issued exposure or catalog publication command. Installer-owned
-- historical rows retain their original identities; source functions can only
-- consume them. No provider, secret value or lifecycle export/erasure is installed.

ALTER TABLE public.catalog_bundles ADD COLUMN composition_locked_at timestamptz,
  ADD COLUMN composition_digest text,
  ADD CONSTRAINT channel_bundle_retained_lock_shape CHECK(
    (composition_locked_at IS NULL AND composition_digest IS NULL) OR
    (composition_locked_at IS NOT NULL AND composition_digest ~ '^[0-9a-f]{64}$'));
ALTER TABLE public.sales_channel_connections
  ADD COLUMN control_version bigint NOT NULL DEFAULT 0 CHECK(control_version BETWEEN 0 AND 9007199254740991),
  ADD COLUMN application_ref text CHECK(application_ref IS NULL OR btrim(application_ref)<>''),
  ADD COLUMN environment_ref text CHECK(environment_ref IS NULL OR btrim(environment_ref)<>''),
  ADD COLUMN seller_external_ref text CHECK(seller_external_ref IS NULL OR btrim(seller_external_ref)<>'');
ALTER TABLE public.sales_channels ADD COLUMN control_version bigint NOT NULL DEFAULT 0 CHECK(control_version BETWEEN 0 AND 9007199254740991);
ALTER TABLE public.sales_channel_listings ADD COLUMN control_version bigint NOT NULL DEFAULT 0 CHECK(control_version BETWEEN 0 AND 9007199254740991),
  ADD COLUMN current_qualification_id uuid, ADD COLUMN current_approval_id uuid, ADD COLUMN manual_stop boolean NOT NULL DEFAULT false,
  ADD COLUMN exposure_issued_units bigint NOT NULL DEFAULT 0, ADD COLUMN exposure_converted_units bigint NOT NULL DEFAULT 0,
  ADD COLUMN exposure_withdrawn_units bigint NOT NULL DEFAULT 0, ADD COLUMN exposure_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN exposure_issued_basis_ref uuid,
  ADD CONSTRAINT channel_exposure_retained_conservation CHECK(exposure_issued_units BETWEEN 0 AND 9007199254740991
    AND exposure_converted_units BETWEEN 0 AND 9007199254740991 AND exposure_withdrawn_units BETWEEN 0 AND 9007199254740991
    AND exposure_generation BETWEEN 0 AND 9007199254740991 AND exposure_converted_units::numeric+exposure_withdrawn_units<=exposure_issued_units);
CREATE TABLE public.sales_channel_control_operations (
  resource_kind text NOT NULL CHECK(resource_kind IN ('connection','channel','listing')), resource_id uuid NOT NULL,
  operation text NOT NULL CHECK(operation IN ('registry_apply','listing_prepare','listing_record_qualification','listing_approve',
    'listing_manual_stop','exposure_allocate','exposure_convert_sale','exposure_reclaim_unsold')),
  operation_id uuid NOT NULL, actor_id uuid NOT NULL, input_digest text NOT NULL CHECK(input_digest ~ '^[0-9a-f]{64}$'),
  canonical_text text NOT NULL CHECK(octet_length(canonical_text) BETWEEN 2 AND 262144), result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(resource_kind,resource_id,operation,operation_id));
CREATE TABLE public.sales_channel_listing_qualifications (
  id uuid PRIMARY KEY, listing_id uuid NOT NULL REFERENCES public.sales_channel_listings(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL, listing_version bigint NOT NULL CHECK(listing_version BETWEEN 0 AND 9007199254740990),
  body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(id,listing_id), UNIQUE(listing_id,listing_version));
CREATE TABLE public.sales_channel_listing_approvals (
  id uuid PRIMARY KEY, listing_id uuid NOT NULL REFERENCES public.sales_channel_listings(id) ON DELETE RESTRICT,
  qualification_id uuid NOT NULL REFERENCES public.sales_channel_listing_qualifications(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL, listing_version bigint NOT NULL CHECK(listing_version BETWEEN 1 AND 9007199254740991),
  body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(id,listing_id), UNIQUE(listing_id,listing_version));
ALTER TABLE public.sales_channel_listings
  ADD CONSTRAINT channel_retained_qualification_scope FOREIGN KEY(current_qualification_id,id) REFERENCES public.sales_channel_listing_qualifications(id,listing_id) ON DELETE RESTRICT,
  ADD CONSTRAINT channel_retained_approval_scope FOREIGN KEY(current_approval_id,id) REFERENCES public.sales_channel_listing_approvals(id,listing_id) ON DELETE RESTRICT,
  ADD CONSTRAINT channel_retained_exposure_basis_scope FOREIGN KEY(exposure_issued_basis_ref,id) REFERENCES public.sales_channel_listing_approvals(id,listing_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX channel_retained_exposure_sale ON public.sales_channel_control_operations(resource_id,
  (canonical_text::jsonb#>>'{payload,ingestId}'),(canonical_text::jsonb#>>'{payload,externalLineRef}')) WHERE operation='exposure_convert_sale';
CREATE UNIQUE INDEX channel_retained_exposure_generation ON public.sales_channel_control_operations(resource_id,((result->>'appliedGeneration')::bigint))
  WHERE operation IN ('exposure_allocate','exposure_convert_sale','exposure_reclaim_unsold');

CREATE FUNCTION public.channel_control_keys(p_value jsonb,p_keys jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(p_value)='object' AND
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_value) k)=(SELECT array_agg(k ORDER BY k) FROM jsonb_array_elements_text(p_keys) k),false)
$$;
CREATE FUNCTION public.channel_control_ref(p_value text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(p_value=btrim(p_value) AND char_length(p_value) BETWEEN 1 AND 128,false)
$$;
CREATE FUNCTION public.catalog_bundle_composition_digest(p_bundle_id uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array('bundle-physical.v1',b.id::text,b.code,b.fulfillment_mode,b.composition_constraint::text,
    coalesce((SELECT jsonb_agg(jsonb_build_array(c.catalog_sku_id::text,c.quantity,c.is_addon) ORDER BY c.catalog_sku_id)
      FROM public.catalog_bundle_components c WHERE c.bundle_id=b.id),'[]'::jsonb))::text,'UTF8')),'hex')
  FROM public.catalog_bundles b WHERE b.id=p_bundle_id
$$;
CREATE FUNCTION public.channel_control_actor(p_actor_id uuid,p_human boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.admin_users%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL OR auth.role() IS NULL OR auth.role() NOT IN ('authenticated','service_role')
    OR (auth.role()='authenticated' AND auth.uid() IS DISTINCT FROM p_actor_id)
    OR (p_human AND (auth.role()<>'authenticated' OR auth.uid() IS DISTINCT FROM p_actor_id)) THEN
    RAISE EXCEPTION 'channel_control_actor_required' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM public.admin_users WHERE id=p_actor_id AND membership_state='active' AND role='admin' FOR SHARE;
  IF NOT FOUND OR (p_human AND coalesce(a.is_machine_actor,true)) THEN RAISE EXCEPTION 'channel_control_human_required' USING ERRCODE='42501'; END IF;
  RETURN CASE WHEN a.is_machine_actor=false THEN 'human' ELSE 'machine' END;
END $$;
CREATE FUNCTION public.channel_control_scope(p_listing_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object('connectionId',c.id,'channelId',s.id,'connectorKind',c.connector_provider_kind,'sellerRef',c.seller_external_ref,
    'environmentRef',c.environment_ref,'connectionVersion',c.control_version,'registryVersion',s.control_version,'currency',s.currency,'regionCode',s.region_code)
  FROM public.sales_channel_listings l JOIN public.sales_channels s ON s.id=l.channel_id JOIN public.sales_channel_connections c ON c.id=s.connection_id WHERE l.id=p_listing_id
$$;
CREATE FUNCTION public.channel_listing_read(p_listing_id uuid,p_actor_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE l public.sales_channel_listings%ROWTYPE; a jsonb; q jsonb; f jsonb; fq jsonb;
BEGIN
  PERFORM public.channel_control_actor(p_actor_id,false);
  SELECT * INTO l FROM public.sales_channel_listings WHERE id=p_listing_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT body INTO a FROM public.sales_channel_listing_approvals WHERE id=l.current_approval_id;
  SELECT body INTO q FROM public.sales_channel_listing_qualifications WHERE id=l.current_qualification_id;
  SELECT body INTO f FROM public.sales_channel_listing_approvals WHERE id=(a->>'firstBasisApprovalId')::uuid;
  SELECT body INTO fq FROM public.sales_channel_listing_qualifications WHERE id=(f->>'qualificationId')::uuid;
  RETURN jsonb_build_object('listing',jsonb_build_object('id',l.id,'version',l.control_version,'scope',public.channel_control_scope(l.id),
    'bundleId',l.sellable_bundle_id,'externalOfferRef',l.external_offer_ref,'state',CASE WHEN l.current_approval_id IS NOT NULL THEN 'approved'
      WHEN q->>'disposition'='qualified' THEN 'qualified' ELSE 'draft' END,'manualStop',l.manual_stop,'approvalId',l.current_approval_id),
    'qualification',q,'currentApproval',a,'firstApproval',f,'firstQualification',fq);
END $$;
-- Retained physical facts cannot be rewritten or erased after the first seal.
-- No fresh seal authoring entrypoint is selected by this slice.
CREATE FUNCTION public.channel_retained_bundle_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE locked boolean;
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'bundle_structure_truncate_forbidden' USING ERRCODE='P0001'; END IF;
  IF TG_TABLE_NAME='catalog_bundles' THEN
    IF TG_OP='INSERT' AND (NEW.composition_locked_at IS NOT NULL OR NEW.composition_digest IS NOT NULL) THEN
      RAISE EXCEPTION 'bundle_composition_lock_requires_function' USING ERRCODE='42501'; END IF;
    IF TG_OP='UPDATE' AND OLD.composition_locked_at IS NULL AND (NEW.composition_locked_at IS NOT NULL OR NEW.composition_digest IS NOT NULL) THEN
      RAISE EXCEPTION 'bundle_composition_lock_requires_function' USING ERRCODE='42501'; END IF;
    IF TG_OP='DELETE' THEN locked:=OLD.composition_locked_at IS NOT NULL;
    ELSIF TG_OP='UPDATE' THEN locked:=OLD.composition_locked_at IS NOT NULL AND
      ROW(NEW.id,NEW.code,NEW.fulfillment_mode,NEW.composition_constraint::text,NEW.composition_locked_at,NEW.composition_digest)
      IS DISTINCT FROM ROW(OLD.id,OLD.code,OLD.fulfillment_mode,OLD.composition_constraint::text,OLD.composition_locked_at,OLD.composition_digest); END IF;
  ELSE
    IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.bundle_id,NEW.catalog_sku_id,NEW.quantity,NEW.is_addon)
      IS NOT DISTINCT FROM ROW(OLD.id,OLD.bundle_id,OLD.catalog_sku_id,OLD.quantity,OLD.is_addon) THEN RETURN NEW; END IF;
    IF TG_OP<>'INSERT' THEN PERFORM id FROM public.catalog_bundles WHERE id=OLD.bundle_id ORDER BY id FOR UPDATE; END IF;
    IF TG_OP<>'DELETE' THEN PERFORM id FROM public.catalog_bundles WHERE id=NEW.bundle_id ORDER BY id FOR UPDATE; END IF;
    SELECT EXISTS(SELECT 1 FROM public.catalog_bundles WHERE composition_locked_at IS NOT NULL AND
      (id=CASE WHEN TG_OP<>'INSERT' THEN OLD.bundle_id END OR id=CASE WHEN TG_OP<>'DELETE' THEN NEW.bundle_id END)) INTO locked;
  END IF;
  IF locked THEN RAISE EXCEPTION 'bundle_composition_locked' USING ERRCODE='P0001'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER channel_retained_bundle_guard BEFORE INSERT OR UPDATE OR DELETE ON public.catalog_bundles FOR EACH ROW EXECUTE FUNCTION public.channel_retained_bundle_guard();
CREATE TRIGGER channel_retained_component_guard BEFORE INSERT OR UPDATE OR DELETE ON public.catalog_bundle_components FOR EACH ROW EXECUTE FUNCTION public.channel_retained_bundle_guard();
CREATE TRIGGER channel_retained_bundle_truncate BEFORE TRUNCATE ON public.catalog_bundles FOR EACH STATEMENT EXECUTE FUNCTION public.channel_retained_bundle_guard();
CREATE TRIGGER channel_retained_component_truncate BEFORE TRUNCATE ON public.catalog_bundle_components FOR EACH STATEMENT EXECUTE FUNCTION public.channel_retained_bundle_guard();
REVOKE ALL ON FUNCTION public.channel_control_keys(jsonb,jsonb),public.channel_control_ref(text),public.channel_control_actor(uuid,boolean),
  public.channel_control_scope(uuid),public.catalog_bundle_composition_digest(uuid),public.channel_retained_bundle_guard(),public.channel_listing_read(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,openlup_mcp_reader;
REVOKE ALL ON public.sales_channel_control_operations,public.sales_channel_listing_qualifications,public.sales_channel_listing_approvals FROM PUBLIC,anon,authenticated;
ALTER TABLE public.sales_channel_control_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_channel_listing_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_channel_listing_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_channel_control_operations,public.sales_channel_listing_qualifications,public.sales_channel_listing_approvals FROM service_role,openlup_mcp_reader;
REVOKE ALL ON FUNCTION public.channel_listing_read(uuid,uuid) FROM service_role,openlup_mcp_reader;
GRANT EXECUTE ON FUNCTION public.channel_listing_read(uuid,uuid) TO service_role;

-- Historical facts have no runtime authoring endpoint in this import.
CREATE FUNCTION public.channel_retained_fact_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='TRUNCATE' OR TG_OP IN('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'channel_retained_fact_immutable' USING ERRCODE='P0001'; END IF;
  IF current_user IN('anon','authenticated','service_role','openlup_mcp_reader','platform_runtime') THEN
    RAISE EXCEPTION 'channel_retained_fact_installer_required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_retained_qualification_guard BEFORE INSERT OR UPDATE OR DELETE ON public.sales_channel_listing_qualifications
 FOR EACH ROW EXECUTE FUNCTION public.channel_retained_fact_guard();
CREATE TRIGGER channel_retained_approval_guard BEFORE INSERT OR UPDATE OR DELETE ON public.sales_channel_listing_approvals
 FOR EACH ROW EXECUTE FUNCTION public.channel_retained_fact_guard();
CREATE TRIGGER channel_retained_qualification_truncate BEFORE TRUNCATE ON public.sales_channel_listing_qualifications
 FOR EACH STATEMENT EXECUTE FUNCTION public.channel_retained_fact_guard();
CREATE TRIGGER channel_retained_approval_truncate BEFORE TRUNCATE ON public.sales_channel_listing_approvals
 FOR EACH STATEMENT EXECUTE FUNCTION public.channel_retained_fact_guard();
REVOKE ALL ON FUNCTION public.channel_retained_fact_guard() FROM PUBLIC,anon,authenticated,service_role,openlup_mcp_reader;

CREATE FUNCTION public.channel_retained_listing_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'channel_retained_listing_truncate_forbidden' USING ERRCODE='P0001'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.current_approval_id IS NOT NULL OR NEW.current_qualification_id IS NOT NULL OR NEW.exposure_issued_basis_ref IS NOT NULL
      OR ROW(NEW.exposure_issued_units,NEW.exposure_converted_units,NEW.exposure_withdrawn_units,NEW.exposure_generation) IS DISTINCT FROM ROW(0::bigint,0::bigint,0::bigint,0::bigint) THEN
      RAISE EXCEPTION 'channel_retained_listing_installer_required' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.current_approval_id IS NOT NULL OR OLD.exposure_issued_basis_ref IS NOT NULL THEN
      RAISE EXCEPTION 'channel_retained_listing_retained' USING ERRCODE='P0001'; END IF;
    RETURN OLD;
  END IF;
  IF (OLD.current_approval_id IS NOT NULL OR OLD.exposure_issued_basis_ref IS NOT NULL) AND
    ROW(NEW.id,NEW.channel_id,NEW.sellable_bundle_id,NEW.external_offer_ref) IS DISTINCT FROM
    ROW(OLD.id,OLD.channel_id,OLD.sellable_bundle_id,OLD.external_offer_ref) THEN
    RAISE EXCEPTION 'channel_retained_listing_binding_immutable' USING ERRCODE='P0001'; END IF;
  IF ROW(NEW.current_approval_id,NEW.current_qualification_id,NEW.exposure_issued_basis_ref,NEW.exposure_issued_units,NEW.exposure_converted_units,NEW.exposure_withdrawn_units,NEW.exposure_generation)
    IS NOT DISTINCT FROM ROW(OLD.current_approval_id,OLD.current_qualification_id,OLD.exposure_issued_basis_ref,OLD.exposure_issued_units,OLD.exposure_converted_units,OLD.exposure_withdrawn_units,OLD.exposure_generation) THEN RETURN NEW; END IF;
  -- Only the managed closed conversion owner can advance a consumed obligation.
  IF current_user<>'openlup_channel_purchase_writer' OR NEW.exposure_converted_units<=OLD.exposure_converted_units
    OR NEW.exposure_generation<>OLD.exposure_generation+1 OR
    (to_jsonb(NEW)-ARRAY['exposure_converted_units','exposure_generation','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['exposure_converted_units','exposure_generation','updated_at']) THEN
    RAISE EXCEPTION 'channel_retained_listing_installer_required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_retained_listing_guard BEFORE INSERT OR UPDATE OR DELETE ON public.sales_channel_listings
 FOR EACH ROW EXECUTE FUNCTION public.channel_retained_listing_guard();
CREATE TRIGGER channel_retained_listing_truncate BEFORE TRUNCATE ON public.sales_channel_listings
 FOR EACH STATEMENT EXECUTE FUNCTION public.channel_retained_listing_guard();
REVOKE ALL ON FUNCTION public.channel_retained_listing_guard() FROM PUBLIC,anon,authenticated,service_role,openlup_mcp_reader;
