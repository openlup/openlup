-- Qualified-v2 catalogue publication authority. Connection secrets are host-owned.
DO $publication_role$
BEGIN
  IF current_setting('openlup.qualified.role_mode', true) = 'installer-managed' THEN
    CREATE ROLE openlup_catalog_publication LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'openlup_catalog_publication') THEN
    RAISE EXCEPTION 'catalog_publication_login_missing. Provision openlup_catalog_publication as a restricted LOGIN with no memberships before applying in operator-provisioned mode.';
  END IF;
END
$publication_role$;

-- SHARE ROW EXCLUSIVE needs a table-level UPDATE, DELETE or TRUNCATE grant.
-- Delegate just the fixed lock operation, preserving the original order and NOWAIT.
CREATE FUNCTION public.catalog_publication_lock_projection() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $lock$
BEGIN
  PERFORM public.catalog_price_setup_require_human_admin();
  LOCK TABLE public.catalog_products, public.catalog_skus, public.catalog_sku_identifiers,
    public.catalog_product_document_revisions, public.catalog_attribute_projection IN SHARE ROW EXCLUSIVE MODE NOWAIT;
END
$lock$;
REVOKE ALL ON FUNCTION public.catalog_publication_lock_projection() FROM PUBLIC;

-- The recorder derives the actor, receipt and event. Its deferred checks bind the issue to the approved state.
ALTER FUNCTION public.catalog_publication_record_command(jsonb) SECURITY DEFINER;
-- The deferred trigger performs only the existing draft fence no-op update.
ALTER FUNCTION public.catalog_publication_admit() SECURITY DEFINER;

-- Only the recorder can insert an issue for this login. Its trigger records the
-- product in a private temporary table whose evidence is cleared at COMMIT.
CREATE FUNCTION public.catalog_publication_bind_live_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $bind$
DECLARE product uuid;
BEGIN
  IF TG_ARGV[0] = 'open_draft' THEN
    PERFORM 1 FROM public.catalog_draft_heads
      WHERE draft_id=NEW.draft_id AND product_id=NEW.product_id AND revision=NEW.draft_revision AND status='open'
      FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'catalog_publication_draft_advanced' USING ERRCODE='23514', CONSTRAINT='catalog_publication_draft_advanced';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'catalog_publications' AND to_regclass('pg_temp.catalog_publication_issued_products') IS NULL THEN
    CREATE TEMP TABLE catalog_publication_issued_products (product_id uuid PRIMARY KEY) USING heap ON COMMIT DELETE ROWS;
  END IF;
  -- A caller-owned temporary object with the reserved name is never evidence.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('pg_temp.catalog_publication_issued_products')
    AND relowner=current_user::regrole AND relkind='r' AND relpersistence='t') THEN
    RAISE EXCEPTION 'catalog_publication_write_binding_required' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME = 'catalog_publications' THEN
    INSERT INTO pg_temp.catalog_publication_issued_products VALUES (NEW.product_id) ON CONFLICT DO NOTHING;
  ELSE
    CASE TG_TABLE_NAME
      WHEN 'catalog_products' THEN product := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
      WHEN 'catalog_sku_identifiers' THEN SELECT product_id INTO product FROM public.catalog_skus
        WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.catalog_sku_id ELSE NEW.catalog_sku_id END;
      WHEN 'catalog_attribute_projection' THEN SELECT product_id INTO product FROM public.catalog_skus
        WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.sku_id ELSE NEW.sku_id END;
      WHEN 'price_entries' THEN SELECT product_id INTO product FROM public.catalog_skus
        WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.variant_id ELSE NEW.variant_id END;
      WHEN 'catalog_price_setup_receipts' THEN SELECT product_id INTO product FROM public.catalog_skus
        WHERE id=(NEW.metadata->>'variantId')::uuid;
      ELSE product := CASE WHEN TG_OP='DELETE' THEN OLD.product_id ELSE NEW.product_id END;
    END CASE;
    IF NOT EXISTS (SELECT 1 FROM pg_temp.catalog_publication_issued_products WHERE product_id=product) THEN
      RAISE EXCEPTION 'catalog_publication_write_binding_required' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NULL;
END
$bind$;
REVOKE ALL ON FUNCTION public.catalog_publication_bind_live_write() FROM PUBLIC;
CREATE TRIGGER catalog_publication_record_write_binding AFTER INSERT ON public.catalog_publications FOR EACH ROW
  WHEN (session_user='openlup_catalog_publication') EXECUTE FUNCTION public.catalog_publication_bind_live_write();
CREATE CONSTRAINT TRIGGER catalog_publications_open_draft AFTER INSERT ON public.catalog_publications
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (session_user='openlup_catalog_publication')
  EXECUTE FUNCTION public.catalog_publication_bind_live_write('open_draft');
DO $triggers$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['catalog_products','catalog_skus','catalog_sku_identifiers','catalog_product_document_revisions','catalog_attribute_projection','price_entries'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER catalog_publication_live_write AFTER INSERT OR UPDATE OR DELETE ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (session_user=''openlup_catalog_publication'') EXECUTE FUNCTION public.catalog_publication_bind_live_write()', target);
  END LOOP;
END $triggers$;
-- The writer removes its provisional receipt on refusal. Only completion persists a receipt.
CREATE CONSTRAINT TRIGGER catalog_publication_live_write AFTER INSERT OR UPDATE ON public.catalog_price_setup_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (session_user='openlup_catalog_publication' AND NEW.status='completed')
  EXECUTE FUNCTION public.catalog_publication_bind_live_write();

-- Check the effect (including replay) under the same row fence as the native writer.
CREATE FUNCTION public.catalog_publication_lock_effective_base_price(p_sku uuid, p_list uuid)
RETURNS TABLE(id uuid, unit_price_minor integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $lock$
BEGIN
  PERFORM public.catalog_price_setup_require_human_admin();
  RETURN QUERY SELECT e.id,e.unit_price_minor FROM public.price_entries e
  JOIN public.price_lists l ON l.id=e.price_list_id
  WHERE (e.variant_id,e.price_list_id)=(p_sku,p_list) AND e.mode='one_time' AND e.min_qty=1 AND e.active
    AND e.amount_kind='gross' AND e.valid_from<=statement_timestamp()
    AND (e.valid_to IS NULL OR e.valid_to>statement_timestamp())
    AND l.status='active' AND l.region_code=public.catalog_price_setup_region_code()
    AND l.currency=public.catalog_price_setup_settlement_currency() AND l.valid_from<=statement_timestamp()
    AND (l.valid_to IS NULL OR l.valid_to>statement_timestamp())
  ORDER BY e.id LIMIT 2 FOR NO KEY UPDATE OF e;
END
$lock$;
REVOKE ALL ON FUNCTION public.catalog_publication_lock_effective_base_price(uuid,uuid) FROM PUBLIC;

ALTER FUNCTION public.catalog_price_setup_region_code() SECURITY DEFINER;
ALTER FUNCTION public.catalog_price_setup_settlement_currency() SECURITY DEFINER;
ALTER FUNCTION public.platform_human_membership_is_administrator(uuid) SECURITY DEFINER;
ALTER FUNCTION public.catalog_publication_assert_receipt(uuid,text) SECURITY DEFINER;

-- Invoker helpers set their own path even when a definer calls them.
DO $publication_search_paths$
DECLARE signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'auth.uid()',
    'public.catalog_publication_record_command(jsonb)',
    'public.channel_purchase_guard()', -- The recorder's outbox INSERT runs this trigger.
    'public.catalog_publication_admit()',
    'public.catalog_publication_sku_admit()',
    'public.platform_human_membership_is_administrator(uuid)',
    'public.catalog_draft_get(uuid,integer,text)',
    'public.catalog_draft_record(uuid,integer)',
    'public.catalog_publication_assert_candidate(public.catalog_publication_decisions,public.catalog_publications,jsonb)',
    'public.catalog_publication_assert_head(uuid,boolean)',
    'public.catalog_publication_assert_issued(uuid,uuid)',
    'public.catalog_publication_assert_receipt(uuid,text)',
    'public.catalog_publication_candidate_source(uuid,text,text)',
    'public.catalog_publication_receipt_input(text)',
    'public.catalog_publication_canonical(jsonb,integer)',
    'public.catalog_publication_max_depth()',
    'public.catalog_publication_head_ref(uuid,uuid)',
    'public.catalog_publication_manifest_text(uuid,text,text,boolean)',
    'public.catalog_publication_product_facts(uuid,jsonb,boolean)',
    'public.catalog_publication_sku_facts(public.catalog_sku_revisions)',
    'public.catalog_publication_sku_projection(uuid,uuid,text,jsonb,boolean)',
    'public.catalog_publication_live_matches(uuid,jsonb,jsonb)',
    'public.catalog_publication_attributes_valid(jsonb)',
    'public.catalog_publication_carriers_valid(jsonb,uuid)',
    'public.catalog_publication_claim_valid(jsonb)',
    'public.catalog_publication_content_problem(jsonb)',
    'public.catalog_publication_presentation_valid(jsonb)',
    'public.catalog_publication_quantity_valid(jsonb)',
    'public.catalog_publication_text_valid(jsonb,integer,boolean)'
  ] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', signature);
  END LOOP;
END
$publication_search_paths$;

GRANT SELECT (id, slug, name, status, primary_sku_id, current_document_revision_id, type_key, type_version, variant_axes,
  attribute_values, publication_facts) ON public.catalog_products TO openlup_catalog_publication;
GRANT SELECT (id, product_id, sku, title, status, min_order_qty, is_addon, sellable_standalone, sellable_in_subscription,
  attribute_values, option_values, net_weight_g, net_content_dimension, net_content_unit, net_content_scale, net_content_unscaled,
  gross_mass_dimension, gross_mass_unit, gross_mass_scale, gross_mass_unscaled, asset_ref, publication_facts)
  ON public.catalog_skus TO openlup_catalog_publication;
GRANT SELECT (id, catalog_sku_id, issuer, identifier_kind, normalized_value, pack_kind, quantity, is_primary, scheme)
  ON public.catalog_sku_identifiers TO openlup_catalog_publication;
GRANT SELECT (id, product_id, revision_no, schema_id, document_ref, source_ref, document_payload, digest, provenance)
  ON public.catalog_product_document_revisions TO openlup_catalog_publication;
GRANT SELECT (draft_id, product_id, revision, status) ON public.catalog_draft_heads TO openlup_catalog_publication;
GRANT SELECT (draft_id, product_id, revision, status, payload, command_key, fingerprint, actor_id, created_at)
  ON public.catalog_draft_revisions TO openlup_catalog_publication;
GRANT SELECT (draft_id, command_key, revision, fingerprint) ON public.catalog_draft_command_receipts TO openlup_catalog_publication;
GRANT SELECT (id, product_id, revision, issued_count, command_fingerprint, previous_id, draft_id, draft_revision, command_key,
  candidate_ref, candidate_digest, document_revision_id, canonical_state, digest, actor_id, committed_at)
  ON public.catalog_publications TO openlup_catalog_publication;
GRANT SELECT (product_id, publication_id) ON public.catalog_publication_heads TO openlup_catalog_publication;
GRANT SELECT (id, sku_id, sku_code, product_id, revision, publication_id, full_facts, digest)
  ON public.catalog_sku_revisions TO openlup_catalog_publication;
GRANT SELECT (id, product_id, candidate_ref, candidate_digest, candidate_reference_digest, action, post_state_canonical_text,
  post_state_digest, decided_at) ON public.catalog_publication_decisions TO openlup_catalog_publication;
GRANT SELECT ON public.catalog_operator_receipts, public.catalog_publication_pointer_capabilities TO openlup_catalog_publication;
GRANT SELECT (id, region_code, currency, status, valid_from, valid_to, created_at) ON public.price_lists TO openlup_catalog_publication;
GRANT SELECT (price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, valid_from, valid_to, active)
  ON public.price_entries TO openlup_catalog_publication;
GRANT SELECT (id, revision_no, price_list_id, region_code, currency, channel, effective_from, effective_to, closed_from_open,
  discount_bps, rounding_quantum_minor, rounding_rule, digest) ON public.subscription_price_policy_revisions TO openlup_catalog_publication;
GRANT SELECT (type_key, version, definition_digest) ON public.catalog_type_versions TO openlup_catalog_publication;
GRANT SELECT (key, status), UPDATE (status) ON public.catalog_tax_classes TO openlup_catalog_publication;

GRANT INSERT ON public.catalog_publication_pointer_capabilities,
  public.catalog_attribute_projection TO openlup_catalog_publication;
GRANT INSERT (id, slug, name, status) ON public.catalog_products TO openlup_catalog_publication;
GRANT INSERT (id, product_id, sku, title, status, min_order_qty, is_addon, sellable_standalone, sellable_in_subscription,
  attribute_values, option_values, canonical_option_bytes, combination_digest, net_weight_g, net_content_dimension,
  net_content_unit, net_content_scale, net_content_unscaled, gross_mass_dimension, gross_mass_unit, gross_mass_scale,
  gross_mass_unscaled, asset_ref, publication_facts) ON public.catalog_skus TO openlup_catalog_publication;
GRANT INSERT (catalog_sku_id, issuer, identifier_kind, normalized_value, pack_kind, quantity, is_primary, scheme)
  ON public.catalog_sku_identifiers TO openlup_catalog_publication;
GRANT INSERT (id, product_id, revision_no, schema_id, document_ref, source_ref, document_payload, digest, provenance)
  ON public.catalog_product_document_revisions TO openlup_catalog_publication;

GRANT UPDATE (current_document_revision_id, slug, name, status, type_key, type_version, variant_axes, attribute_values,
  primary_sku_id, publication_facts, updated_at) ON public.catalog_products TO openlup_catalog_publication;
GRANT UPDATE (title, status, min_order_qty, is_addon, sellable_standalone, sellable_in_subscription, attribute_values,
  option_values, canonical_option_bytes, combination_digest, net_weight_g, net_content_dimension, net_content_unit,
  net_content_scale, net_content_unscaled, gross_mass_dimension, gross_mass_unit, gross_mass_scale, gross_mass_unscaled,
  asset_ref, publication_facts, updated_at) ON public.catalog_skus TO openlup_catalog_publication;
GRANT UPDATE (identifier_kind, pack_kind, quantity, is_primary, scheme)
  ON public.catalog_sku_identifiers TO openlup_catalog_publication;
GRANT UPDATE (revision) ON public.catalog_publication_heads TO openlup_catalog_publication;
GRANT UPDATE (revision) ON public.catalog_draft_heads TO openlup_catalog_publication;
GRANT DELETE ON public.catalog_sku_identifiers, public.catalog_publication_pointer_capabilities TO openlup_catalog_publication;

-- Permit the tax class row lock while rejecting any resulting update.
CREATE POLICY publication_select ON public.catalog_tax_classes FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_lock ON public.catalog_tax_classes FOR UPDATE TO openlup_catalog_publication USING (true) WITH CHECK (false);
CREATE POLICY publication_select ON public.catalog_type_versions FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_select ON public.catalog_draft_revisions FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_select ON public.catalog_draft_command_receipts FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_select ON public.catalog_draft_heads FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_lock ON public.catalog_draft_heads FOR UPDATE TO openlup_catalog_publication USING (true) WITH CHECK (false);
CREATE POLICY publication_select ON public.catalog_publications FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_select ON public.catalog_sku_revisions FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_select ON public.catalog_operator_receipts FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_select ON public.catalog_publication_decisions FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_select ON public.catalog_publication_heads FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_lock ON public.catalog_publication_heads FOR UPDATE TO openlup_catalog_publication USING (true) WITH CHECK (false);
CREATE POLICY publication_insert ON public.catalog_attribute_projection FOR INSERT TO openlup_catalog_publication WITH CHECK (true);
CREATE POLICY publication_select ON public.catalog_publication_pointer_capabilities FOR SELECT TO openlup_catalog_publication
  USING (transaction_id = pg_current_xact_id());
CREATE POLICY publication_insert ON public.catalog_publication_pointer_capabilities FOR INSERT TO openlup_catalog_publication
  WITH CHECK (transaction_id = pg_current_xact_id());
CREATE POLICY publication_delete ON public.catalog_publication_pointer_capabilities FOR DELETE TO openlup_catalog_publication
  USING (transaction_id = pg_current_xact_id());

GRANT EXECUTE ON FUNCTION public.platform_human_membership_is_administrator(uuid),
  public.catalog_draft_record(uuid,integer), public.catalog_draft_get(uuid,integer,text),
  public.catalog_price_setup_require_human_admin(), public.catalog_price_setup_apply(text,text),
  public.catalog_price_setup_lock_context(uuid,uuid), public.catalog_publication_lock_effective_base_price(uuid,uuid),
  public.catalog_price_setup_region_code(), public.catalog_price_setup_settlement_currency(),
  public.catalog_price_setup_policy_digest(uuid,integer,uuid,text,text,text,timestamptz,timestamptz,integer,integer,text),
  public.commerce_offer_policy_v2_readiness(), public.catalog_publication_lock_projection(),
  public.catalog_publication_record_command(jsonb), public.catalog_publication_canonical(jsonb,integer),
  public.catalog_publication_max_depth(), public.catalog_publication_head_ref(uuid,uuid),
  public.catalog_publication_candidate_source(uuid,text,text), public.catalog_publication_assert_head(uuid,boolean),
  public.catalog_publication_assert_receipt(uuid,text),
  public.catalog_publication_manifest_text(uuid,text,text,boolean),
  public.catalog_publication_sku_projection(uuid,uuid,text,jsonb,boolean),
  public.catalog_publication_sku_facts(public.catalog_sku_revisions),
  public.catalog_publication_product_facts(uuid,jsonb,boolean), public.catalog_publication_live_matches(uuid,jsonb,jsonb),
  public.catalog_publication_quantity_valid(jsonb), public.catalog_publication_text_valid(jsonb,integer,boolean),
  public.catalog_publication_attributes_valid(jsonb), public.catalog_publication_presentation_valid(jsonb),
  public.catalog_publication_carriers_valid(jsonb,uuid), public.catalog_publication_content_problem(jsonb),
  public.catalog_publication_claim_valid(jsonb) TO openlup_catalog_publication;
