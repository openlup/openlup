-- CTL-M11 reviewed fixture: record operator attribution before recovery-token
-- revocation/minting and append a bounded audit outcome. Require prior admission
-- for a completed attempt; delegate actor validation and replay to the audit
-- primitive. This is checkout authority, not payment truth or invoice issuance.
-- The CHECK replacement binds its preimage, retains every preimage action and
-- adds only checkout_payment_link_mint. NOT VALID avoids scanning history while
-- enforcing the superset on future writes. Preserve SECURITY DEFINER,
-- pg_catalog/public path and service-only execution.
-- Pinned by managedCommerceForwards in config/reviewed-platform-forwards.json.
-- The registry and real migration rails are authoritative.
-- M11 versions follow every earlier same-rail pin; each pin requires all earlier
-- same-rail pins present with exact bytes.
-- Fixture checks do not establish installation or handler behavior.

SET LOCAL lock_timeout = '2s';

ALTER TABLE public.admin_audit_events
  DROP CONSTRAINT admin_audit_events_action_check;
ALTER TABLE public.admin_audit_events
  ADD CONSTRAINT admin_audit_events_action_check CHECK (action IN (
    'role_change', 'invite', 'remove',
    'promo_update', 'promo_status_change', 'subscription_band_update',
    'catalog_draft_upsert', 'catalog_price_set', 'catalog_sku_archive', 'catalog_activate',
    'catalog_product_archive', 'catalog_product_restore', 'catalog_deactivate',
    'customer_read', 'promotion_code_create', 'promotion_code_update',
    'promotion_code_status_change',
    'bundle_draft_upsert', 'bundle_composition_set', 'bundle_target_price_set',
    'bundle_archive', 'bundle_restore', 'bundle_activate', 'bundle_deactivate',
    'revoke', 'checkout_payment_link_mint'
  )) NOT VALID;

CREATE FUNCTION public.admin_checkout_payment_link_record_receipt(
  p_actor_id uuid,
  p_request_id uuid,
  p_order_id uuid,
  p_outcome text,
  p_completed_stage text,
  p_email_requested boolean,
  p_token_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_request_id IS NULL OR p_order_id IS NULL OR p_email_requested IS NULL
    OR p_outcome IS NULL OR p_outcome NOT IN ('admitted', 'succeeded', 'failed')
    OR p_completed_stage IS NULL OR p_completed_stage NOT IN ('none', 'revoked', 'minted', 'email_queued')
  THEN
    RAISE EXCEPTION 'checkout_payment_link_receipt_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_outcome <> 'admitted' AND NOT EXISTS (
    SELECT 1 FROM public.admin_audit_events
    WHERE entity_type = 'checkout_payment_link'
      AND idempotency_key = p_request_id::text || ':admitted'
      AND actor_admin_id = p_actor_id AND entity_id = p_order_id::text
  ) THEN
    RAISE EXCEPTION 'checkout_payment_link_admission_required' USING ERRCODE = '42501';
  END IF;

  RETURN public.record_admin_audit_event(
    p_actor_id, 'checkout_payment_link_mint', 'admin_ui',
    'checkout_payment_link', p_order_id::text, NULL,
    jsonb_build_object(
      'outcome', p_outcome, 'completedStage', p_completed_stage,
      'emailRequested', p_email_requested, 'tokenId', p_token_id,
      'emailIdempotencyKey', CASE WHEN p_email_requested AND p_token_id IS NOT NULL
        THEN 'checkout_recovery:operator:' || p_token_id::text ELSE NULL END
    ), p_request_id::text || ':' || p_outcome, p_request_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_checkout_payment_link_record_receipt(uuid,uuid,uuid,text,text,boolean,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_checkout_payment_link_record_receipt(uuid,uuid,uuid,text,text,boolean,uuid)
  TO service_role;
