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

GRANT SELECT ON public.catalog_products, public.catalog_skus, public.catalog_sku_identifiers,
  public.catalog_product_document_revisions, public.catalog_draft_heads, public.catalog_draft_revisions,
  public.catalog_draft_command_receipts, public.catalog_publications, public.catalog_publication_heads,
  public.catalog_sku_revisions, public.catalog_operator_receipts, public.catalog_publication_decisions,
  public.catalog_publication_pointer_capabilities, public.price_lists, public.price_entries,
  public.subscription_price_policy_revisions, public.catalog_price_setup_receipts
  TO openlup_catalog_publication;
GRANT SELECT (type_key, version, definition_digest) ON public.catalog_type_versions TO openlup_catalog_publication;
GRANT SELECT (key, status), UPDATE (status) ON public.catalog_tax_classes TO openlup_catalog_publication;
GRANT SELECT (key, value_text) ON public.commerce_settings TO openlup_catalog_publication;
GRANT SELECT (principal_id, membership_state, role) ON public.platform_human_memberships TO openlup_catalog_publication;

GRANT INSERT ON public.catalog_publications, public.catalog_sku_revisions, public.catalog_operator_receipts,
  public.catalog_publication_decisions, public.catalog_publication_heads, public.catalog_publication_pointer_capabilities,
  public.catalog_attribute_projection, public.catalog_price_setup_receipts TO openlup_catalog_publication;
GRANT INSERT (id, slug, name, status) ON public.catalog_products TO openlup_catalog_publication;
GRANT INSERT (id, product_id, sku, title, status, min_order_qty, is_addon, sellable_standalone, sellable_in_subscription,
  attribute_values, option_values, canonical_option_bytes, combination_digest, net_weight_g, net_content_dimension,
  net_content_unit, net_content_scale, net_content_unscaled, gross_mass_dimension, gross_mass_unit, gross_mass_scale,
  gross_mass_unscaled, asset_ref, publication_facts) ON public.catalog_skus TO openlup_catalog_publication;
GRANT INSERT (catalog_sku_id, issuer, identifier_kind, normalized_value, pack_kind, quantity, is_primary, scheme)
  ON public.catalog_sku_identifiers TO openlup_catalog_publication;
GRANT INSERT (id, product_id, revision_no, schema_id, document_ref, source_ref, document_payload, digest, provenance)
  ON public.catalog_product_document_revisions TO openlup_catalog_publication;
GRANT INSERT (price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, active, valid_from)
  ON public.price_entries TO openlup_catalog_publication;
GRANT INSERT (aggregate_type, aggregate_id, event_type, idempotency_key, payload)
  ON public.outbox_events TO openlup_catalog_publication;

GRANT UPDATE (current_document_revision_id, slug, name, status, type_key, type_version, variant_axes, attribute_values,
  primary_sku_id, publication_facts, updated_at) ON public.catalog_products TO openlup_catalog_publication;
GRANT UPDATE (title, status, min_order_qty, is_addon, sellable_standalone, sellable_in_subscription, attribute_values,
  option_values, canonical_option_bytes, combination_digest, net_weight_g, net_content_dimension, net_content_unit,
  net_content_scale, net_content_unscaled, gross_mass_dimension, gross_mass_unit, gross_mass_scale, gross_mass_unscaled,
  asset_ref, publication_facts, updated_at) ON public.catalog_skus TO openlup_catalog_publication;
GRANT UPDATE (identifier_kind, pack_kind, quantity, is_primary, scheme)
  ON public.catalog_sku_identifiers TO openlup_catalog_publication;
GRANT UPDATE (publication_id, revision) ON public.catalog_publication_heads TO openlup_catalog_publication;
GRANT UPDATE (revision) ON public.catalog_draft_heads TO openlup_catalog_publication;
GRANT UPDATE (active, valid_to, updated_at) ON public.price_entries TO openlup_catalog_publication;
GRANT UPDATE (status, response_payload) ON public.catalog_price_setup_receipts TO openlup_catalog_publication;
GRANT DELETE ON public.catalog_sku_identifiers, public.catalog_publication_pointer_capabilities,
  public.catalog_price_setup_receipts TO openlup_catalog_publication;

-- Permit the tax class row lock while rejecting any resulting update.
CREATE POLICY publication_select ON public.catalog_tax_classes FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_lock ON public.catalog_tax_classes FOR UPDATE TO openlup_catalog_publication USING (true) WITH CHECK (false);
CREATE POLICY publication_select ON public.catalog_type_versions FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_select ON public.catalog_draft_revisions FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_select ON public.catalog_draft_command_receipts FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_select ON public.catalog_draft_heads FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_update ON public.catalog_draft_heads FOR UPDATE TO openlup_catalog_publication USING (true);
CREATE POLICY publication_select ON public.catalog_publications FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_insert ON public.catalog_publications FOR INSERT TO openlup_catalog_publication WITH CHECK (true);
CREATE POLICY publication_select ON public.catalog_sku_revisions FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_insert ON public.catalog_sku_revisions FOR INSERT TO openlup_catalog_publication WITH CHECK (true);
CREATE POLICY publication_select ON public.catalog_operator_receipts FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_insert ON public.catalog_operator_receipts FOR INSERT TO openlup_catalog_publication WITH CHECK (true);
CREATE POLICY publication_select ON public.catalog_publication_decisions FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_insert ON public.catalog_publication_decisions FOR INSERT TO openlup_catalog_publication WITH CHECK (true);
CREATE POLICY publication_select ON public.catalog_publication_heads FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_insert ON public.catalog_publication_heads FOR INSERT TO openlup_catalog_publication WITH CHECK (true);
CREATE POLICY publication_update ON public.catalog_publication_heads FOR UPDATE TO openlup_catalog_publication USING (true);
CREATE POLICY publication_insert ON public.catalog_attribute_projection FOR INSERT TO openlup_catalog_publication WITH CHECK (true);
CREATE POLICY publication_select ON public.catalog_publication_pointer_capabilities FOR SELECT TO openlup_catalog_publication
  USING (transaction_id = pg_current_xact_id());
CREATE POLICY publication_insert ON public.catalog_publication_pointer_capabilities FOR INSERT TO openlup_catalog_publication
  WITH CHECK (transaction_id = pg_current_xact_id());
CREATE POLICY publication_delete ON public.catalog_publication_pointer_capabilities FOR DELETE TO openlup_catalog_publication
  USING (transaction_id = pg_current_xact_id());
CREATE POLICY publication_select ON public.catalog_price_setup_receipts FOR SELECT TO openlup_catalog_publication USING (true);
CREATE POLICY publication_insert ON public.catalog_price_setup_receipts FOR INSERT TO openlup_catalog_publication WITH CHECK (true);
CREATE POLICY publication_update ON public.catalog_price_setup_receipts FOR UPDATE TO openlup_catalog_publication USING (true);
CREATE POLICY publication_delete ON public.catalog_price_setup_receipts FOR DELETE TO openlup_catalog_publication USING (status = 'in_progress');

GRANT USAGE ON SCHEMA auth TO openlup_catalog_publication;
GRANT EXECUTE ON FUNCTION auth.uid(), public.platform_human_membership_is_administrator(uuid),
  public.catalog_draft_record(uuid,integer), public.catalog_draft_get(uuid,integer,text),
  public.catalog_price_setup_require_human_admin(), public.catalog_price_setup_claim(text,text),
  public.catalog_price_setup_lock_context(uuid,uuid), public.catalog_price_setup_apply_claimed(jsonb,timestamptz),
  public.catalog_price_setup_region_code(), public.catalog_price_setup_settlement_currency(),
  public.catalog_price_setup_policy_digest(uuid,integer,uuid,text,text,text,timestamptz,timestamptz,integer,integer,text),
  public.commerce_offer_policy_v2_readiness(), public.catalog_publication_lock_projection(),
  public.catalog_publication_record_command(jsonb), public.catalog_publication_canonical(jsonb,integer),
  public.catalog_publication_max_depth(), public.catalog_publication_head_ref(uuid,uuid),
  public.catalog_publication_candidate_source(uuid,text,text), public.catalog_publication_assert_head(uuid,boolean),
  public.catalog_publication_assert_receipt(uuid,text), public.catalog_publication_receipt_input(text),
  public.catalog_publication_assert_candidate(public.catalog_publication_decisions,public.catalog_publications,jsonb),
  public.catalog_publication_assert_issued(uuid,uuid), public.catalog_publication_manifest_text(uuid,text,text,boolean),
  public.catalog_publication_sku_projection(uuid,uuid,text,jsonb,boolean),
  public.catalog_publication_sku_facts(public.catalog_sku_revisions),
  public.catalog_publication_product_facts(uuid,jsonb,boolean), public.catalog_publication_live_matches(uuid,jsonb,jsonb),
  public.catalog_publication_quantity_valid(jsonb), public.catalog_publication_text_valid(jsonb,integer,boolean),
  public.catalog_publication_attributes_valid(jsonb), public.catalog_publication_presentation_valid(jsonb),
  public.catalog_publication_carriers_valid(jsonb,uuid), public.catalog_publication_content_problem(jsonb),
  public.catalog_publication_claim_valid(jsonb) TO openlup_catalog_publication;
