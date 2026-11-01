-- Qualified-admin normal-runtime capabilities. The exact table operations and invoker
-- call graph are the current native platform's authored server paths. No object
-- ownership, private-schema access, DDL, ADMIN, default grant or future object
-- permission is conferred. Final selected-catalog qualification rechecks the
-- role/policy graph after grants.
-- The lock-only privileges below require the declared non-owner/NOBYPASSRLS
-- profile and actual positive/refusal proof before installation qualification.

-- Restricted-admin fresh installation: M is trusted, NOSUPERUSER and database owner.
-- Retained ADMIN-only membership permits M to reacquire owner execution explicitly.
-- Runtime/restore authority is separately bounded; this does not isolate the DBA.
DO $qa_session$
DECLARE
  v_mode text := pg_catalog.current_setting('openlup.qualified.role_mode', true);
  v_runtime text := pg_catalog.current_setting('openlup.qualified.runtime_login', true);
  v_restore text := pg_catalog.current_setting('openlup.qualified.restore_login', true);
  v_operator text := COALESCE(pg_catalog.current_setting('openlup.qualified.operator_login', true), '');
  v_m pg_catalog.pg_roles%ROWTYPE;
  v_role pg_catalog.pg_roles%ROWTYPE;
  v_name text;
BEGIN
  SELECT * INTO v_m FROM pg_catalog.pg_roles WHERE rolname = current_user;
  IF current_user <> session_user OR NOT FOUND OR NOT v_m.rolcanlogin
    OR v_m.rolsuper OR v_m.rolinherit OR v_m.rolcreatedb OR v_m.rolreplication OR v_m.rolbypassrls
    OR v_m.rolconnlimit <> -1 OR v_m.rolvaliduntil IS NOT NULL
    OR v_mode IS NULL OR v_mode NOT IN ('installer-managed', 'operator-provisioned')
    OR v_m.rolcreaterole IS DISTINCT FROM (v_mode = 'installer-managed')
    OR (SELECT datdba FROM pg_catalog.pg_database WHERE datname = current_database()) <> v_m.oid
    OR pg_catalog.current_setting('server_version_num')::integer / 10000 <> 16
    OR pg_catalog.current_setting('session_replication_role') <> 'origin'
    OR pg_catalog.current_schemas(true) IS DISTINCT FROM ARRAY['pg_catalog', 'public']::name[]
    OR pg_catalog.pg_has_role(v_m.oid, 10::oid, 'MEMBER')
  THEN
    RAISE EXCEPTION 'qualified_admin_session_invalid' USING ERRCODE = '42501';
  END IF;
  IF v_runtime IS NULL OR v_restore IS NULL OR v_runtime = v_restore
    OR v_runtime = current_user OR v_restore = current_user
    OR (v_mode = 'installer-managed' AND v_operator <> '')
    OR (v_mode = 'operator-provisioned' AND (v_operator = '' OR v_operator IN (v_runtime, v_restore, current_user)))
  THEN
    RAISE EXCEPTION 'qualified_admin_principal_binding_invalid' USING ERRCODE = '42501';
  END IF;
  FOREACH v_name IN ARRAY ARRAY[v_runtime, v_restore] || CASE WHEN v_operator = '' THEN ARRAY[]::text[] ELSE ARRAY[v_operator] END LOOP
    IF v_name !~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'
      OR v_name IN ('PUBLIC', 'anon', 'authenticated', 'service_role', 'platform_acquisition_owner', 'platform_acquisition_runtime', 'openlup_retained_import_owner')
      OR left(v_name, 3) = 'pg_'
    THEN RAISE EXCEPTION 'qualified_admin_principal_binding_invalid' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_role FROM pg_catalog.pg_roles WHERE rolname = v_name;
    IF NOT FOUND OR NOT v_role.rolcanlogin OR v_role.rolsuper OR v_role.rolinherit
      OR v_role.rolcreatedb OR v_role.rolreplication OR v_role.rolbypassrls
      OR v_role.rolconnlimit <> -1 OR v_role.rolvaliduntil IS NOT NULL
      OR v_role.rolcreaterole IS DISTINCT FROM (v_name = v_operator)
      OR pg_catalog.pg_has_role(v_role.oid, 10::oid, 'MEMBER')
    THEN RAISE EXCEPTION 'qualified_admin_principal_flags_invalid' USING ERRCODE = '42501'; END IF;
  END LOOP;
END
$qa_session$;

DO $qa_roles$
DECLARE
  v_mode text := pg_catalog.current_setting('openlup.qualified.role_mode');
  v_runtime text := pg_catalog.current_setting('openlup.qualified.runtime_login');
  v_operator text := COALESCE(pg_catalog.current_setting('openlup.qualified.operator_login', true), '');
  v_m oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);
  v_r oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = v_runtime);
  v_o oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = v_operator);
  v_grantor oid;
  v_group text;
  v_oid oid;
  v_runtime_group boolean;
BEGIN
  v_grantor := CASE WHEN v_mode = 'installer-managed' THEN v_m ELSE v_o END;
  FOREACH v_group IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'platform_acquisition_owner', 'platform_acquisition_runtime', 'openlup_retained_import_owner'] LOOP
    v_runtime_group := v_group IN ('anon', 'authenticated', 'service_role', 'platform_acquisition_runtime');
    SELECT oid INTO v_oid FROM pg_catalog.pg_roles WHERE rolname = v_group;
    IF v_oid IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE oid = v_oid AND NOT rolcanlogin AND NOT rolinherit
        AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
        AND NOT rolbypassrls AND rolconnlimit = -1 AND rolvaliduntil IS NULL
    ) OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = v_oid)
      OR (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE roleid = v_oid)
        <> (CASE WHEN v_mode = 'installer-managed' THEN 1 ELSE 2 END) + (CASE WHEN v_runtime_group THEN 1 ELSE 0 END) + (CASE WHEN v_group = 'platform_acquisition_owner' THEN 1 ELSE 0 END)
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members a WHERE a.roleid = v_oid AND NOT (
          (a.member = v_m AND a.grantor = CASE WHEN v_mode = 'installer-managed' THEN 10::oid ELSE v_o END
            AND a.admin_option AND NOT a.inherit_option AND NOT a.set_option)
          OR (v_mode = 'operator-provisioned' AND a.member = v_o AND a.grantor = 10
            AND a.admin_option AND NOT a.inherit_option AND NOT a.set_option)
          OR (v_runtime_group AND a.member = v_r AND a.grantor = v_grantor AND NOT a.admin_option
            AND a.inherit_option = (v_group = 'service_role') AND a.set_option) OR (v_group = 'platform_acquisition_owner' AND a.member = v_m AND a.grantor = v_m AND NOT a.admin_option AND a.inherit_option AND a.set_option)
        )
      )
    THEN RAISE EXCEPTION 'qualified_admin_role_graph_invalid:%', v_group USING ERRCODE = '42501'; END IF;
  END LOOP;
END
$qa_roles$;

-- All shared acquisition ownership forwards have now committed. Remove execution
-- and public CREATE; the explicit trusted-M administrative edge is retained.
REVOKE CREATE ON SCHEMA public FROM platform_acquisition_owner;
DO $qa_owner_seal$
BEGIN
  EXECUTE pg_catalog.format('REVOKE platform_acquisition_owner FROM %I GRANTED BY %I', current_user, current_user);
END
$qa_owner_seal$;

GRANT USAGE ON SCHEMA public TO service_role;

-- Read-only configuration, admission, installation-ledger and projection reads.
-- Their migration seeds do not establish runtime INSERT/UPDATE/DELETE authority.
GRANT SELECT ON TABLE
  public.platform_schema_migrations,
  public.client_absorption_policy,
  public.catalog_products,
  public.catalog_skus,
  public.catalog_product_document_revisions,
  public.catalog_sku_identifiers,
  public.price_lists,
  public.price_entries,
  public.subscription_price_policy_revisions,
  public.commerce_promotion_definitions,
  public.risk_blocklist_entries,
  public.sales_channel_connections,
  public.sales_channels,
  public.sales_channel_listings,
  public.fulfillment_provider_archetypes,
  public.fulfillment_ports,
  public.fulfillment_dispatch_contexts,
  public.subscription_method_states,
  public.outbox_dormant_event_types,
  public.commerce_operators,
  public.platform_control_operators,
  public.platform_communication_operators,
  public.platform_alerts,
  public.subscription_paid_activation_gaps,
  public.subscription_delivery_alignment_cycles,
  public.invoicing_due_sources,
  public.invoicing_cutover
TO service_role;

-- Existing notification admission locks the operator row FOR SHARE. Only the
-- timestamp column is writable; authority columns retain their read boundary.
GRANT UPDATE (updated_at) ON TABLE public.platform_communication_operators
  TO service_role;

-- Existing diagnostic replay locks the event FOR UPDATE. The matching policy
-- below permits row visibility for locking while rejecting every actual update.
GRANT UPDATE (id) ON TABLE public.customer_diagnostic_events TO service_role;

-- Authored direct identity writes: account creation/linking, challenge redemption,
-- identity erasure, and native support absorption. Privacy reads clients.*.
GRANT SELECT ON TABLE public.clients TO service_role;
GRANT INSERT (email, principal_id, acquisition_source, lifecycle_stage)
  ON TABLE public.clients TO service_role;
GRANT UPDATE
  (principal_id, updated_at, email, first_name, last_name, phone, country, metadata)
  ON TABLE public.clients TO service_role;

-- Runtime state machines with authored SELECT/INSERT/UPDATE operations.
-- Sources: native accounting/document/payout rails and later invoicing forwards;
-- native bundle-write/draft, commerce/order, communications, fulfillment,
-- identity, job/control, subscription, payment-truth and risk owners.
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.accounting_documents,
  public.accounting_document_requests,
  public.accounting_document_deliveries,
  public.accounting_payout_batches,
  public.catalog_bundles,
  public.catalog_bundle_prices,
  public.catalog_draft_heads,
  public.catalog_draft_sku_reservations,
  public.commerce_orders,
  public.commerce_order_holds,
  public.commerce_order_draft_receipts,
  public.commerce_checkout_resume_drafts,
  public.commerce_checkout_recovery_tokens,
  public.commerce_settlement_intents,
  public.commerce_order_reviews,
  public.commerce_order_review_media,
  public.commerce_promotion_claims,
  public.commerce_return_requests,
  public.channel_order_ingests,
  public.sales_channel_quarantine,
  public.outbox_events,
  public.transactional_delivery_receipts,
  public.communication_delivery_controls,
  public.communication_delivery_templates,
  public.communication_delivery_commands,
  public.communication_recipient_consents,
  public.communication_native_sends,
  public.communication_native_sync_state,
  public.fulfillment_shipments,
  public.commerce_fulfillment_provider_commands,
  public.fulfillment_dispatch_refs,
  public.fulfillment_paid_handoffs,
  public.fulfillment_observations,
  public.fulfillment_stock_current,
  public.fulfillment_stock_evidence,
  public.fulfillment_stock_sync_cursors,
  public.fulfillment_inventory_reservations,
  public.platform_human_principals,
  public.platform_human_memberships,
  public.platform_human_membership_audit_events,
  public.identity_operator_invitation_events,
  public.platform_job_controls,
  public.platform_job_runs,
  public.platform_operational_controls,
  public.subscriptions,
  public.subscription_pause_windows,
  public.subscription_cycles,
  public.subscription_activations,
  public.subscription_edit_quotes,
  public.subscription_command_receipts,
  public.subscription_renewal_operations,
  public.subscription_dunning_cases,
  public.subscription_dunning_notifications,
  public.subscription_retry_obligations,
  public.subscription_retry_recovery_authorizations,
  public.subscription_stock_wait_cases,
  public.subscription_delivery_alignment_cases,
  public.subscriber_profiles,
  public.subscriber_retention_intents,
  public.subscriber_review_access_grants,
  public.invoicing_duties,
  public.invoicing_delivery_receipts,
  public.invoicing_seller_revisions,
  public.payment_truth_events,
  public.payment_truth_reconciliation_evidence,
  public.risk_manual_review_cases
TO service_role;

-- Existing settings/renewal/mode operations update installed records; installation
-- seeds are not runtime inserts.
GRANT SELECT, UPDATE ON TABLE
  public.commerce_settings,
  public.subscription_renewal_terms,
  public.subscription_delivery_alignment_control
TO service_role;

-- Authored deletion paths: challenge pruning/erasure, invitation privacy erasure,
-- notification-recipient deletion, delivery preparation settlement, diagnostic
-- retention, and alignment admission-receipt pruning/consumption.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.customer_identity_challenges,
  public.operator_identity_challenges,
  public.identity_operator_invitations,
  public.notification_recipients,
  public.communication_delivery_preparations,
  public.customer_diagnostic_segments,
  public.subscription_delivery_alignment_admission_receipts
TO service_role;

-- Replace-in-transaction collections, stock-wait outcome reopening and diagnostic
-- pruning. Diagnostic event replay row locking is the unresolved gap above.
GRANT SELECT, INSERT, DELETE ON TABLE
  public.catalog_bundle_components,
  public.commerce_order_items,
  public.subscription_lines,
  public.subscription_renewal_term_lines,
  public.subscription_renewal_outcomes,
  public.customer_diagnostic_events,
  public.customer_diagnostic_ingress_attempts,
  public.customer_diagnostic_access_events
TO service_role;

-- Retained records read or replayed by the current native routines/adapters.
GRANT SELECT, INSERT ON TABLE
  public.accounting_document_positions,
  public.accounting_document_operations,
  public.accounting_payout_items,
  public.catalog_bundle_write_events,
  public.catalog_draft_revisions,
  public.catalog_draft_command_receipts,
  public.commerce_offer_continuations,
  public.commerce_checkout_compensations,
  public.commerce_order_operations,
  public.commerce_order_adjustments,
  public.commerce_settlement_transitions,
  public.commerce_return_operations,
  public.communication_delivery_events,
  public.communication_native_observations,
  public.fulfillment_shipment_operations,
  public.shipment_external_refs,
  public.fulfillment_provider_attempts,
  public.commerce_fulfillment_provider_command_transitions,
  public.fulfillment_stock_operations,
  public.fulfillment_stock_snapshots,
  public.fulfillment_stock_movements,
  public.fulfillment_inventory_reservation_lines,
  public.customer_subject_lifecycle_events,
  public.customer_recovery_commands,
  public.customer_support_audit_events,
  public.customer_support_subscription_commands,
  public.subscription_events,
  public.subscription_reminder_ledger,
  public.subscription_retry_receipts,
  public.subscription_delivery_alignment_arrivals,
  public.subscriber_retention_activation_watermarks,
  public.platform_control_operations,
  public.invoicing_capture_faults,
  public.invoicing_document_observations,
  public.invoicing_effect_receipts,
  public.invoicing_fact_revisions,
  public.risk_assessments,
  public.risk_case_events
TO service_role;

-- Append-only runtime writes with no authored runtime update/delete path.
GRANT INSERT ON TABLE
  public.accounting_document_delivery_attempts,
  public.commerce_return_lines,
  public.commerce_order_review_audit,
  public.commerce_promotion_claim_events,
  public.customer_support_subscription_audit_events,
  public.customer_support_read_audit_events,
  public.communication_native_policy_decisions
TO service_role;
GRANT SELECT (id) ON TABLE public.communication_native_policy_decisions
  TO service_role;

-- Existing privacy paths take SHARE / SHARE ROW EXCLUSIVE table locks. Those
-- require a table privilege; column UPDATE is insufficient on PostgreSQL 16.
-- RLS preserves receipt reads/inserts and refuses every actual update. Runtime
-- ownership and BYPASSRLS are forbidden by qualified session admission.
GRANT SELECT, INSERT ON TABLE public.identity_privacy_erasures TO service_role;
ALTER TABLE public.identity_privacy_erasures ENABLE ROW LEVEL SECURITY;
CREATE POLICY m14_rt_privacy_erasures_select
  ON public.identity_privacy_erasures
  FOR SELECT TO service_role USING (true);
CREATE POLICY m14_rt_privacy_erasures_insert
  ON public.identity_privacy_erasures
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY m14_rt_privacy_erasures_update_lock_only
  ON public.identity_privacy_erasures
  FOR UPDATE TO service_role USING (true) WITH CHECK (false);
GRANT UPDATE ON TABLE public.identity_privacy_erasures TO service_role;

-- Exactly 13 of the current 15 RLS-enabled tables need normal-runtime policies.
-- customer_communication_preferences and customer_communication_preference_events
-- remain ungranted and receive no normal-runtime policy: existing actor-facing
-- SECURITY DEFINER routines remain their access boundary.

CREATE POLICY m14_rt_clients_select ON public.clients
  FOR SELECT TO service_role USING (true);
CREATE POLICY m14_rt_clients_insert ON public.clients
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY m14_rt_clients_update ON public.clients
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);

CREATE POLICY m14_rt_absorption_policy_select ON public.client_absorption_policy
  FOR SELECT TO service_role USING (true);

CREATE POLICY m14_rt_support_commands_select
  ON public.customer_support_subscription_commands
  FOR SELECT TO service_role USING (true);
CREATE POLICY m14_rt_support_commands_insert
  ON public.customer_support_subscription_commands
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY m14_rt_support_audit_insert
  ON public.customer_support_subscription_audit_events
  FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY m14_rt_draft_heads_select ON public.catalog_draft_heads
  FOR SELECT TO service_role USING (true);
CREATE POLICY m14_rt_draft_heads_insert ON public.catalog_draft_heads
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY m14_rt_draft_heads_update ON public.catalog_draft_heads
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);

CREATE POLICY m14_rt_draft_skus_select ON public.catalog_draft_sku_reservations
  FOR SELECT TO service_role USING (true);
CREATE POLICY m14_rt_draft_skus_insert ON public.catalog_draft_sku_reservations
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY m14_rt_draft_skus_update ON public.catalog_draft_sku_reservations
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);

CREATE POLICY m14_rt_draft_revisions_select ON public.catalog_draft_revisions
  FOR SELECT TO service_role USING (true);
CREATE POLICY m14_rt_draft_revisions_insert ON public.catalog_draft_revisions
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY m14_rt_draft_receipts_select ON public.catalog_draft_command_receipts
  FOR SELECT TO service_role USING (true);
CREATE POLICY m14_rt_draft_receipts_insert ON public.catalog_draft_command_receipts
  FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY m14_rt_diagnostic_segments_select ON public.customer_diagnostic_segments
  FOR SELECT TO service_role USING (true);
CREATE POLICY m14_rt_diagnostic_segments_insert ON public.customer_diagnostic_segments
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY m14_rt_diagnostic_segments_update ON public.customer_diagnostic_segments
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY m14_rt_diagnostic_segments_delete ON public.customer_diagnostic_segments
  FOR DELETE TO service_role USING (true);

CREATE POLICY m14_rt_diagnostic_events_select ON public.customer_diagnostic_events
  FOR SELECT TO service_role USING (true);
CREATE POLICY m14_rt_diagnostic_events_insert ON public.customer_diagnostic_events
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY m14_rt_diagnostic_events_update_lock_only
  ON public.customer_diagnostic_events
  FOR UPDATE TO service_role USING (true) WITH CHECK (false);
CREATE POLICY m14_rt_diagnostic_events_delete ON public.customer_diagnostic_events
  FOR DELETE TO service_role USING (true);

CREATE POLICY m14_rt_diagnostic_ingress_select
  ON public.customer_diagnostic_ingress_attempts
  FOR SELECT TO service_role USING (true);
CREATE POLICY m14_rt_diagnostic_ingress_insert
  ON public.customer_diagnostic_ingress_attempts
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY m14_rt_diagnostic_ingress_delete
  ON public.customer_diagnostic_ingress_attempts
  FOR DELETE TO service_role USING (true);

CREATE POLICY m14_rt_diagnostic_access_select ON public.customer_diagnostic_access_events
  FOR SELECT TO service_role USING (true);
CREATE POLICY m14_rt_diagnostic_access_insert ON public.customer_diagnostic_access_events
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY m14_rt_diagnostic_access_delete ON public.customer_diagnostic_access_events
  FOR DELETE TO service_role USING (true);

-- No sequence privileges: the current native catalog has one generated identity
-- sequence, communication_delivery_events_event_id_seq, and no explicit runtime
-- nextval/currval/setval call. Prove event INSERT with these grants before adding
-- any exact sequence privilege the selected PostgreSQL path demonstrates it needs.
GRANT EXECUTE ON FUNCTION public.admin_activate_bundle(uuid,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_archive_bundle(uuid,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_deactivate_bundle(uuid,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_restore_bundle(uuid,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_bundle_composition(uuid,text,jsonb,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_bundle_target_price(uuid,text,text,integer,text,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_upsert_bundle_draft(uuid,text,text,text,jsonb,jsonb,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.catalog_draft_apply(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.catalog_draft_get(uuid,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.catalog_draft_list(uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.catalog_draft_record(uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_checkout_resume_read(text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_checkout_resume_upsert(text,text,text,jsonb,timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_create_order_draft_with_outbox(text,jsonb,jsonb,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_create_promoted_order_draft_with_outbox(text,jsonb,jsonb,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_fulfillment_apply_command_write_outcome(uuid,uuid,bigint,bigint,text,text,text,timestamptz,text,uuid,text,text,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_fulfillment_claim_provider_commands(text,text,integer,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_fulfillment_confirm_provider_command(uuid,uuid,bigint,bigint,text,uuid,text,text,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_fulfillment_enqueue_provider_command(uuid,text,text,text,text,text,text,text,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_fulfillment_mark_command_submitting(uuid,uuid,bigint,bigint,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_fulfillment_provider_command_fence(uuid,uuid,bigint,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_fulfillment_provider_command_result(public.commerce_fulfillment_provider_commands) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_fulfillment_provider_command_transition_allowed(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_fulfillment_reconcile_provider_command(uuid,bigint,text,text,text,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_fulfillment_recover_expired_provider_commands(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_fulfillment_release_or_cancel_command(uuid,uuid,bigint,bigint,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_fulfillment_resolve_uncertain_command(uuid,bigint,text,text,text,text,text,timestamptz,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_promotion_active_definitions() TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_promotion_device_first_order_redeemed(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_promotion_paid_order_counts(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_promotion_redemption_counts(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.commerce_sweep_stale_promotion_claims(timestamptz,integer,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_delivery_health(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_delivery_readiness(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_list_delivery_controls(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_list_delivery_events(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_list_delivery_operations(uuid,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_list_delivery_templates(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_operator_is_active(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_prepare_delivery_command(uuid,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_record_delivery_accepted(uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_record_delivery_failed(uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_require_active_operator(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_set_delivery_control(uuid,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.communications_set_delivery_template(uuid,text,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_checkout_recovery_order(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_checkout_recovery_settle(text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_checkout_recovery_token_inspect(text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_diagnostic_ingest_v1(text,text,uuid,uuid,uuid,uuid,text,text,text,integer,text,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_diagnostic_ingest_v2(text,text,uuid,uuid,uuid,uuid,text,text,text,integer,text,text,text,text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_diagnostic_overview_v2(uuid,timestamptz,timestamptz,integer,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_diagnostic_prune_v1(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_diagnostic_search_v1(uuid,timestamptz,timestamptz,uuid,text,text,text,integer,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_diagnostic_search_v2(uuid,timestamptz,timestamptz,uuid,text,text,text,integer,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_diagnostic_segment_v1(uuid,uuid,integer,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_diagnostic_segment_v2(uuid,uuid,integer,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_identity_challenge_issue(text,text,timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_identity_challenge_redeem(text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_support_absorb_lead_v1(uuid,uuid,uuid,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_support_apply_subscription_action_v1(uuid,uuid,text,jsonb,integer,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_support_detail(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_support_issue_recovery(uuid,uuid,uuid,text,text,text,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_support_journey(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_support_search(uuid,text,integer,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_support_summary(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dunning_lifecycle_handle_failure(uuid,timestamptz,text,text,integer,timestamptz,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.dunning_lifecycle_issue_recovery_token(uuid,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.dunning_lifecycle_open_case(text,uuid,uuid,uuid,integer,timestamptz,text,text,timestamptz,bigint,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.dunning_lifecycle_queue_notice(uuid,text,text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.dunning_lifecycle_record_recovery(uuid,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_ack_paid_handoff(text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_dispatch_begin(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_dispatch_claim(text,uuid,uuid,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_dispatch_finish(uuid,jsonb,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_dispatch_read(public.fulfillment_dispatch_refs,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_ensure_paid_handoff(text,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_mark_observation_processed(text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_record_alignment_arrival(text,uuid,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_record_observation(text,uuid,jsonb,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_record_provider_attempt(text,uuid,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_record_status_evidence(text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_record_stock_movement(text,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fulfillment_supersede_no_effect_commands(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.inventory_available_to_promise(text,text,timestamptz,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.inventory_channel_exposure_quantity(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.inventory_new_purchase_stock_read(text,jsonb,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_capture_duty(text,text,uuid,uuid,jsonb,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_claim_deliveries(integer,integer,boolean,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_claim_duties(integer,integer,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_claim_with_seller(integer,integer,text,jsonb,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_duty_readback(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_fail_duty(uuid,uuid,integer,text,jsonb,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_finish_correction(uuid,uuid,integer,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_finish_facts(uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_finish_issue(uuid,uuid,integer,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_install_facts(uuid,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_preflight_duty(uuid,uuid,integer,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_prepare_facts(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_request_reversal(text,uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_request_with_seller_policy(text,text,uuid,uuid,jsonb,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_settle_delivery(uuid,uuid,integer,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoicing_sweep_duties(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.oms_control_resolve_operator(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_abort_media_upload(text,text,bigint,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_admin_complete_media_delete(text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_admin_list(text,text,integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_admin_prepare_media_delete(text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_admin_read_media(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_admin_read(text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_admit_media_upload(text,text,integer,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_claim_media_reconcile(integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_complete_media_reconcile(text,text,text,integer,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_confirm_media(text,text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_create_media_intent(text,text,integer,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_json(public.commerce_order_reviews,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_lock_media_finalize(text,text,bigint,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_media_json(public.commerce_order_review_media) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_moderate(text,text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_read_media(text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_read(text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_record_media_stored(text,text,bigint,text,integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_resolve_order(text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_revoke_access(text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_review_submit(text,integer,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.platform_control_list_alerts(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.platform_control_list_controls(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.platform_control_list_jobs(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.platform_control_operator_is_active(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.platform_control_record_heartbeat(uuid,text,text,text,integer,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.platform_control_require_operator(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.platform_control_set_control(uuid,text,text,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.platform_human_membership_is_administrator(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.platform_revoke_human_membership(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_profile_read(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_profile_upsert(text,text,text,integer,jsonb,text[],text) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_retention_claim_intent(text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_retention_contract_refusal(text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_retention_create_intent(text,text,uuid,text,text,text,text,integer,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_retention_eligibility_refusal(text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_retention_idempotency_refusal(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_retention_intent_result(uuid,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_retention_list_pending(text,integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_retention_plan_due(text,integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_retention_read_intent(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_retention_record_delivery(text,text,text,text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscriber_retention_source_refusal(text,text,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_apply_lifecycle_action(uuid,text,uuid,text,jsonb,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_auto_resume_due(integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_command_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_command_preview(uuid,uuid,text,uuid,text,jsonb,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_delivery_alignment_admit_renewal(uuid,timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_delivery_alignment_get_mode() TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_delivery_alignment_record_allowed_receipt(uuid,timestamptz,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_delivery_alignment_upsert_case(uuid,uuid,uuid,uuid,integer,text,text,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_lifecycle_assert_unlocked_cycle(uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_retry_apply_failure(uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_retry_authorize_recovery(uuid,uuid,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_retry_candidates(integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_retry_note_row_outcome(uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_retry_open_case(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_retry_prepare(uuid,text,jsonb,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_retry_read(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_retry_record_recovery(uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_retry_schedule_recovery(uuid,text,uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_admit(jsonb,jsonb,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_candidates(integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_deficits(jsonb,uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_enqueue(public.subscription_stock_wait_cases,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_frozen(uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_mark_resumed(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_normal_due(integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_projection(public.subscription_stock_wait_cases) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_read(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.subscription_stock_wait_recover_refusal(uuid,text,text,timestamptz) TO service_role;
