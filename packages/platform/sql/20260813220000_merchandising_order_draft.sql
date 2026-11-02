-- Public platform merchandising-to-draft rail.
--
-- CHANGE. This forward adds the minimum role-free persistence needed by the
-- mounted catalog/quote -> checkout-resume -> pre-payment order-draft journey:
-- hashed resume state, an idempotent order-draft receipt, one atomic draft
-- writer and bounded resume upsert/read routines.
--
-- WHY. The public manifest already owns catalog products/SKUs, price lists,
-- clients, commerce orders/items and the outbox. What it did not own was the
-- link between a verified quote and a resumable pre-payment order. Without this
-- forward the direct bundle could list merchandise but could not preserve a
-- customer's non-identifying selection or create a replay-safe draft.
--
-- SAFETY. The forward is additive. It writes no existing business row while
-- migrating, takes no table rewrite lock, stores only SHA-256 token/idempotency
-- hashes, validates active catalog pricing inside the draft transaction, and
-- emits exactly one outbox row behind a unique event/idempotency key. All
-- routines are invoker-rights with fixed search paths. No role, RLS policy,
-- provider field, product copy, payment attempt, address or raw token is added.
--
-- ROLLBACK. Disable the node-postgres adopter first. The two tables and three
-- routines are capability-local; removing them leaves the pre-existing catalog,
-- order, settlement and outbox rails intact. Existing draft orders remain valid
-- ordinary pending-payment orders.

CREATE TABLE public.commerce_checkout_resume_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  idempotency_key_hash text,
  last_section_id text NOT NULL,
  draft_state jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_checkout_resume_drafts_token_hash_key UNIQUE (token_hash),
  CONSTRAINT commerce_checkout_resume_drafts_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT commerce_checkout_resume_drafts_idempotency_hash_check
    CHECK (idempotency_key_hash IS NULL OR idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT commerce_checkout_resume_drafts_section_check
    CHECK (last_section_id IN (
      'start', 'pet_profile', 'product_selection', 'cadence', 'account',
      'shipping', 'billing', 'payment', 'review'
    )),
  CONSTRAINT commerce_checkout_resume_drafts_state_object_check
    CHECK (jsonb_typeof(draft_state) = 'object'),
  CONSTRAINT commerce_checkout_resume_drafts_future_expiry_check
    CHECK (expires_at > created_at)
);

-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX commerce_checkout_resume_drafts_active_idempotency_key
  ON public.commerce_checkout_resume_drafts (idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL AND revoked_at IS NULL;

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX commerce_checkout_resume_drafts_active_expiry
  ON public.commerce_checkout_resume_drafts (expires_at)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.commerce_checkout_resume_drafts IS
  'Server-owned resumable selection state. Stores only token/idempotency hashes and the contract-validated redacted checkout state.';
COMMENT ON COLUMN public.commerce_checkout_resume_drafts.token_hash IS
  'SHA-256 hash of the opaque resume token; the raw token never enters PostgreSQL.';

CREATE TABLE public.commerce_order_draft_receipts (
  idempotency_key text PRIMARY KEY,
  request_fingerprint text NOT NULL,
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE RESTRICT,
  response_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_draft_receipts_order_id_key UNIQUE (order_id),
  CONSTRAINT commerce_order_draft_receipts_idempotency_key_check
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 8 AND 120),
  CONSTRAINT commerce_order_draft_receipts_fingerprint_check
    CHECK (request_fingerprint ~ '^[0-9a-f]{32}$'),
  CONSTRAINT commerce_order_draft_receipts_response_object_check
    CHECK (jsonb_typeof(response_payload) = 'object')
);

COMMENT ON TABLE public.commerce_order_draft_receipts IS
  'Content-addressed replay receipt for one atomic pre-payment order draft and its outbox fact.';

CREATE FUNCTION public.commerce_checkout_resume_upsert(
  p_token_hash text,
  p_idempotency_key_hash text,
  p_last_section_id text,
  p_draft_state jsonb,
  p_expires_at timestamptz,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := COALESCE(p_now, now());
  v_row public.commerce_checkout_resume_drafts%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'commerce_checkout_resume_invalid_token_hash' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key_hash IS NOT NULL
     AND p_idempotency_key_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'commerce_checkout_resume_invalid_idempotency_hash' USING ERRCODE = '22023';
  END IF;
  IF p_draft_state IS NULL OR jsonb_typeof(p_draft_state) <> 'object'
     OR p_draft_state->>'version' <> 'commerce.checkout_resume.v1'
     OR p_expires_at <= v_now THEN
    RAISE EXCEPTION 'commerce_checkout_resume_invalid_state' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_token_hash, 0));
  SELECT * INTO v_row
    FROM public.commerce_checkout_resume_drafts
   WHERE token_hash = p_token_hash
   FOR UPDATE;

  IF FOUND AND (v_row.revoked_at IS NOT NULL OR v_row.expires_at <= v_now) THEN
    RAISE EXCEPTION 'commerce_checkout_resume_expired_or_revoked' USING ERRCODE = '22023';
  END IF;

  IF FOUND THEN
    UPDATE public.commerce_checkout_resume_drafts
       SET idempotency_key_hash = p_idempotency_key_hash,
           last_section_id = p_last_section_id,
           draft_state = p_draft_state,
           expires_at = p_expires_at,
           revoked_at = NULL,
           updated_at = v_now
     WHERE id = v_row.id
     RETURNING * INTO v_row;
  ELSE
    INSERT INTO public.commerce_checkout_resume_drafts (
      token_hash, idempotency_key_hash, last_section_id, draft_state,
      expires_at, updated_at
    ) VALUES (
      p_token_hash, p_idempotency_key_hash, p_last_section_id, p_draft_state,
      p_expires_at, v_now
    ) RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'contractVersion', 'commerce.checkout_resume.v1',
    'lastSectionId', v_row.last_section_id,
    'draftState', v_row.draft_state,
    'expiresAt', v_row.expires_at,
    'createdAt', v_row.created_at,
    'updatedAt', v_row.updated_at,
    'replayed', false
  );
END;
$$;

CREATE FUNCTION public.commerce_checkout_resume_read(
  p_token_hash text,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'id', draft.id,
    'contractVersion', 'commerce.checkout_resume.v1',
    'lastSectionId', draft.last_section_id,
    'draftState', draft.draft_state,
    'expiresAt', draft.expires_at,
    'createdAt', draft.created_at,
    'updatedAt', draft.updated_at,
    'replayed', true
  )
    FROM public.commerce_checkout_resume_drafts AS draft
   WHERE draft.token_hash = p_token_hash
     AND draft.revoked_at IS NULL
     AND draft.expires_at > COALESCE(p_now, now());
$$;

CREATE FUNCTION public.commerce_create_order_draft_with_outbox(
  p_idempotency_key text,
  p_quote_snapshot jsonb,
  p_order_draft_snapshot jsonb,
  p_client_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_existing public.commerce_order_draft_receipts%ROWTYPE;
  v_fingerprint text;
  v_order_id uuid;
  v_response jsonb;
  v_line jsonb;
  v_line_ordinal integer := 0;
  v_sku_id uuid;
  v_expected_price integer;
  v_quantity integer;
  v_unit_price integer;
  v_line_amount integer;
  v_mode text;
  v_currency text;
  v_total bigint;
BEGIN
  IF p_idempotency_key IS NULL
     OR char_length(btrim(p_idempotency_key)) NOT BETWEEN 8 AND 120 THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_quote_snapshot IS NULL OR jsonb_typeof(p_quote_snapshot) <> 'object'
     OR p_order_draft_snapshot IS NULL OR jsonb_typeof(p_order_draft_snapshot) <> 'object'
     OR p_order_draft_snapshot->>'contractVersion' <> 'commerce.v0'
     OR p_order_draft_snapshot->>'source' <> 'commerce.order_draft.bff.v0'
     OR p_order_draft_snapshot->>'status' <> 'draft'
     OR p_order_draft_snapshot->>'paymentStatus' <> 'not_started'
     OR jsonb_typeof(p_order_draft_snapshot->'lines') <> 'array'
     OR jsonb_array_length(p_order_draft_snapshot->'lines') = 0 THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_snapshot' USING ERRCODE = '22023';
  END IF;
  IF p_client_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.clients WHERE id = p_client_id) THEN
    RAISE EXCEPTION 'commerce_order_draft_unknown_client' USING ERRCODE = '22023';
  END IF;

  v_mode := COALESCE(p_order_draft_snapshot#>>'{context,mode}', 'one_time');
  IF v_mode NOT IN ('one_time', 'subscription') THEN
    RAISE EXCEPTION 'commerce_order_draft_invalid_mode' USING ERRCODE = '22023';
  END IF;
  v_currency := p_order_draft_snapshot->>'currency';
  v_total := (p_order_draft_snapshot#>>'{totals,totalGross,amountMinor}')::bigint;
  v_fingerprint := md5(
    p_quote_snapshot::text || '|' || p_order_draft_snapshot::text || '|'
    || COALESCE(p_client_id::text, '')
  );

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
  SELECT * INTO v_existing
    FROM public.commerce_order_draft_receipts
   WHERE idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_fingerprint = v_fingerprint THEN
      RETURN jsonb_set(v_existing.response_payload, '{orderDraft,replayed}', 'true'::jsonb, false);
    END IF;
    RAISE EXCEPTION 'commerce_order_draft_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  FOR v_line IN
    SELECT value FROM jsonb_array_elements(p_order_draft_snapshot->'lines')
  LOOP
    v_line_ordinal := v_line_ordinal + 1;
    v_quantity := (v_line->>'quantity')::integer;
    v_unit_price := (v_line#>>'{unitPriceGross,amountMinor}')::integer;
    v_line_amount := (v_line#>>'{lineSubtotalGross,amountMinor}')::integer;
    IF v_quantity <= 0 OR v_unit_price < 0 OR v_line_amount <> v_quantity * v_unit_price THEN
      RAISE EXCEPTION 'commerce_order_draft_invalid_line' USING ERRCODE = '22023';
    END IF;

    SELECT sku.id, price.unit_price_minor
      INTO v_sku_id, v_expected_price
      FROM public.catalog_skus AS sku
      JOIN public.catalog_products AS product
        ON product.id = sku.product_id AND product.status = 'active'
      JOIN public.price_entries AS price
        ON price.variant_id = sku.id
       AND price.active
       AND price.amount_kind = 'gross'
       AND price.mode IN (v_mode, 'any')
       AND price.min_qty <= v_quantity
       AND price.valid_from <= now()
       AND (price.valid_to IS NULL OR price.valid_to > now())
      JOIN public.price_lists AS price_list
        ON price_list.id = price.price_list_id
       AND price_list.status = 'active'
       AND price_list.currency = v_currency
       AND price_list.valid_from <= now()
       AND (price_list.valid_to IS NULL OR price_list.valid_to > now())
     WHERE sku.sku = v_line->>'sku'
       AND sku.status = 'active'
       AND v_quantity >= sku.min_order_qty
       AND (v_mode <> 'subscription' OR sku.sellable_in_subscription)
       AND (v_mode <> 'one_time' OR sku.sellable_standalone)
     ORDER BY (price.mode = v_mode) DESC, price.min_qty DESC, price.id
     LIMIT 1;
    IF NOT FOUND OR v_expected_price <> v_unit_price THEN
      RAISE EXCEPTION 'commerce_order_draft_catalog_price_changed' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  INSERT INTO public.commerce_orders (
    client_id, status, currency_code, total_amount_minor, metadata
  ) VALUES (
    p_client_id, 'pending_payment', v_currency, v_total,
    jsonb_build_object(
      'paymentStatus', 'not_started',
      'quoteSnapshot', p_quote_snapshot,
      'orderDraftSnapshot', p_order_draft_snapshot
    )
  ) RETURNING id INTO v_order_id;

  v_line_ordinal := 0;
  FOR v_line IN
    SELECT value FROM jsonb_array_elements(p_order_draft_snapshot->'lines')
  LOOP
    v_line_ordinal := v_line_ordinal + 1;
    SELECT id INTO v_sku_id FROM public.catalog_skus WHERE sku = v_line->>'sku';
    v_quantity := (v_line->>'quantity')::integer;
    v_unit_price := (v_line#>>'{unitPriceGross,amountMinor}')::integer;
    v_line_amount := (v_line#>>'{lineSubtotalGross,amountMinor}')::integer;
    INSERT INTO public.commerce_order_items (
      order_id, sku_id, line_ordinal, quantity, unit_amount_minor, line_amount_minor
    ) VALUES (
      v_order_id, v_sku_id, v_line_ordinal, v_quantity, v_unit_price, v_line_amount
    );
  END LOOP;

  v_response := jsonb_build_object(
    'contractVersion', 'commerce.v0',
    'orderDraft', jsonb_build_object(
      'orderId', 'order_' || v_order_id::text,
      'status', 'draft',
      'paymentStatus', 'not_started',
      'idempotencyKey', p_idempotency_key,
      'quoteSnapshot', p_quote_snapshot,
      'replayed', false
    )
  );

  INSERT INTO public.outbox_events (
    aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata
  ) VALUES (
    'commerce_order', v_order_id, 'commerce.order_draft.created', p_idempotency_key,
    jsonb_build_object(
      'orderId', 'order_' || v_order_id::text,
      'orderUuid', v_order_id,
      'quoteSnapshot', p_quote_snapshot,
      'orderDraftSnapshot', p_order_draft_snapshot
    ),
    jsonb_build_object('boundary', 'commerce_create_order_draft_with_outbox')
  );

  INSERT INTO public.commerce_order_draft_receipts (
    idempotency_key, request_fingerprint, order_id, response_payload
  ) VALUES (
    p_idempotency_key, v_fingerprint, v_order_id, v_response
  );
  RETURN v_response;
END;
$$;

REVOKE ALL ON TABLE public.commerce_checkout_resume_drafts FROM PUBLIC;
REVOKE ALL ON TABLE public.commerce_order_draft_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_checkout_resume_upsert(text, text, text, jsonb, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_checkout_resume_read(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_create_order_draft_with_outbox(text, jsonb, jsonb, uuid) FROM PUBLIC;
