-- Public platform bundle write boundary: the routines that are the only way a bundle
-- changes, and the ledger that makes a repeated attempt safe.
--
-- WHAT THIS FORWARD SHIPS. One relation and seven routines. The earlier forward
-- (20260812140000) created three relations and left them inert: a bundle could be
-- described but not written. This one supplies the writer. Every operation an operator
-- can perform on a bundle -- create it, edit it, clone it, replace its bill of materials,
-- price it, remove it from sale, put it back, publish it, unpublish it -- goes through
-- exactly one of these routines and through no other path.
--
-- WHY THE LEDGER EXISTS AND WHAT IT IS NOT. `catalog_bundle_write_events` records what
-- was done, by which principal, and under which idempotency key. It is not an audit
-- system: it makes no claim about authorisation and enforces no retention. It exists
-- because a write that can be retried must be able to recognise its own replay, and
-- because an operator asking "who last repriced this" has no other place to look on a
-- self-hosted node. The unique index is partial, so an unkeyed write is always allowed
-- and a keyed one can happen exactly once.
--
-- WHY REPLAY SHORT-CIRCUITS INSTEAD OF FAILING. A caller that lost its answer to a
-- network fault must be able to ask again and learn the outcome, not be told it broke a
-- rule. Each routine therefore returns the same shape it would have returned, with
-- `idempotent` set, and writes nothing. A conflicting write under a reused key is not a
-- case this rewards: the key names the attempt, not the payload.
--
-- WHY A DRY RUN VALIDATES AND THEN RETURNS. `p_mode = 'dry_run'` runs every precondition
-- and stops before the first statement that changes a row. An operator, or an agent
-- acting for one, can therefore learn whether a composition or a price would be accepted
-- without leaving a trace of having asked. Validation and commitment share one code path,
-- so the answer cannot drift from the act.
--
-- WHY THE PRICE MAY NOT EXCEED THE SUM OF THE PARTS. A bundle sold above its components
-- is a surcharge wearing a discount's name. The comparison is one line here and one line
-- in the pricing engine that allocates the accepted target back onto the components; both
-- refuse the same input for the same reason, and relaxing the rule stays a change in two
-- known places rather than a search.
--
-- WHY COMPOSITION IS REPLACED WHOLE. Every rule the bill of materials must satisfy is a
-- property of the set -- it must not be empty, it must not name a unit twice, and it must
-- contain something that is not an optional extra. An entry-level patch would let the set
-- pass through states no request described, so the routine deletes and re-inserts inside
-- its own transaction and checks the set it was handed, once.
--
-- WHAT THIS CHAIN CANNOT SAY, STATED PLAINLY. The managed deployment distinguishes a
-- human operator from a machine actor through a registry of administrators, and refuses
-- publication to the latter inside the database. This chain has no such registry: it has
-- one authenticated principal shape and no notion of an operator at all. The two
-- publish-state routines therefore take the principal, record it and enforce the state
-- preconditions, but they cannot re-derive what kind of principal it is, so the human-only
-- rule is enforced by the caller alone here. That is a real difference in defence depth
-- and it is named rather than papered over; closing it needs an operator-identity slice,
-- which is a decision about identity and not about bundles.
--
-- NO GRANTS AND NO ROW LEVEL SECURITY, DELIBERATELY. These are operator-owned objects. A
-- routine created here carries EXECUTE for its owner and for PUBLIC by default, so the
-- forward revokes PUBLIC explicitly and grants nothing back: only the owning role, which
-- is the adopter's own server identity, can call them. The actor bootstrap gives `anon`
-- and `authenticated` schema usage and one routine, never these, so both browser
-- principals are already denied without a policy to say so.

CREATE TABLE public.catalog_bundle_write_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_code text NOT NULL,
  action text NOT NULL,
  principal_id uuid,
  idempotency_key text,
  before_state jsonb,
  after_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_bundle_write_events_action_check CHECK (action IN (
    'bundle_draft_upsert', 'bundle_composition_set', 'bundle_target_price_set',
    'bundle_archive', 'bundle_restore', 'bundle_activate', 'bundle_deactivate'
  )),
  CONSTRAINT catalog_bundle_write_events_key_check
    CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> '')
);

-- Partial and unique: an unkeyed write is always allowed, a keyed one lands once.
CREATE UNIQUE INDEX uq_catalog_bundle_write_events_key
  ON public.catalog_bundle_write_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_catalog_bundle_write_events_bundle_code
  ON public.catalog_bundle_write_events (bundle_code, created_at DESC);

CREATE FUNCTION public.admin_upsert_bundle_draft(
  p_actor_id               uuid,
  p_code                   text,
  p_title                  text DEFAULT NULL,
  p_fulfillment_mode       text DEFAULT NULL,
  p_composition_constraint jsonb DEFAULT NULL,
  p_metadata               jsonb DEFAULT NULL,
  p_clone_from_code        text DEFAULT NULL,
  p_mode                   text DEFAULT 'commit',
  p_idempotency_key        text DEFAULT NULL,
  p_request_id             text DEFAULT NULL,
  p_source                 text DEFAULT 'operator'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_bundle_id uuid;
  v_source public.catalog_bundles%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'actor_required' USING ERRCODE = '42501'; END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.catalog_bundle_write_events WHERE idempotency_key = p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', true, 'dryRun', false);
  END IF;

  SELECT id INTO v_bundle_id FROM public.catalog_bundles WHERE code = p_code;

  IF p_clone_from_code IS NOT NULL THEN
    IF v_bundle_id IS NOT NULL THEN RAISE EXCEPTION 'code_taken' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO v_source FROM public.catalog_bundles WHERE code = p_clone_from_code;
    IF NOT FOUND THEN RAISE EXCEPTION 'clone_source_not_found' USING ERRCODE = 'P0002'; END IF;
  ELSIF v_bundle_id IS NULL AND (p_title IS NULL OR btrim(p_title) = '') THEN
    RAISE EXCEPTION 'bundle_title_required' USING ERRCODE = 'P0001';
  END IF;

  IF p_mode = 'dry_run' THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', false, 'dryRun', true);
  END IF;

  IF p_clone_from_code IS NOT NULL THEN
    INSERT INTO public.catalog_bundles
      (code, title, status, fulfillment_mode, composition_constraint, metadata)
    VALUES (p_code, COALESCE(p_title, v_source.title), 'draft', v_source.fulfillment_mode,
            v_source.composition_constraint, v_source.metadata)
    RETURNING id INTO v_bundle_id;

    INSERT INTO public.catalog_bundle_components
      (bundle_id, catalog_sku_id, quantity, is_addon, sort_order)
    SELECT v_bundle_id, component.catalog_sku_id, component.quantity,
           component.is_addon, component.sort_order
      FROM public.catalog_bundle_components AS component
     WHERE component.bundle_id = v_source.id;
  ELSE
    INSERT INTO public.catalog_bundles
      (code, title, status, fulfillment_mode, composition_constraint, metadata)
    VALUES (p_code, COALESCE(p_title, p_code), 'draft', COALESCE(p_fulfillment_mode, 'virtual'),
            COALESCE(p_composition_constraint, '{}'::jsonb), COALESCE(p_metadata, '{}'::jsonb))
    ON CONFLICT (code) DO UPDATE
      SET title = COALESCE(p_title, public.catalog_bundles.title),
          fulfillment_mode = COALESCE(p_fulfillment_mode, public.catalog_bundles.fulfillment_mode),
          composition_constraint =
            COALESCE(p_composition_constraint, public.catalog_bundles.composition_constraint),
          metadata = COALESCE(p_metadata, public.catalog_bundles.metadata),
          updated_at = now()
    RETURNING id INTO v_bundle_id;
  END IF;

  INSERT INTO public.catalog_bundle_write_events
    (bundle_code, action, principal_id, idempotency_key, after_state)
  VALUES (p_code, 'bundle_draft_upsert', p_actor_id, p_idempotency_key,
          jsonb_build_object('title', p_title, 'clonedFrom', p_clone_from_code,
                             'requestId', p_request_id, 'source', p_source));

  RETURN jsonb_build_object('code', p_code, 'bundleId', v_bundle_id::text,
                            'idempotent', false, 'dryRun', false);
END;
$$;

CREATE FUNCTION public.admin_set_bundle_composition(
  p_actor_id        uuid,
  p_code            text,
  p_components      jsonb,
  p_mode            text DEFAULT 'commit',
  p_idempotency_key text DEFAULT NULL,
  p_request_id      text DEFAULT NULL,
  p_source          text DEFAULT 'operator'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_bundle_id uuid;
  v_count integer;
  v_distinct integer;
  v_core integer;
  v_resolved integer;
  v_unsellable integer;
  v_currency text;
  v_mismatched integer;
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'actor_required' USING ERRCODE = '42501'; END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.catalog_bundle_write_events WHERE idempotency_key = p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', true, 'dryRun', false);
  END IF;

  SELECT id INTO v_bundle_id FROM public.catalog_bundles WHERE code = p_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'bundle_not_found' USING ERRCODE = 'P0002'; END IF;

  -- The supplied set is read out of the argument each time it is needed. A temp
  -- table is the obvious shortcut and the wrong one: ON COMMIT DROP lives until the
  -- transaction ends, so a second composition write in the same transaction, or a
  -- retry after a caught exception, collides with what the first call left behind.
  SELECT count(*),
         count(DISTINCT entry.sku),
         count(*) FILTER (WHERE NOT COALESCE(entry.is_addon, false)),
         count(unit.id),
         count(*) FILTER (
           WHERE unit.id IS NOT NULL
             AND (unit.status <> 'active' OR unit.sellable_standalone IS NOT TRUE))
    INTO v_count, v_distinct, v_core, v_resolved, v_unsellable
    FROM jsonb_to_recordset(COALESCE(p_components, '[]'::jsonb))
         AS entry(sku text, quantity integer, is_addon boolean, sort_order integer)
    LEFT JOIN public.catalog_skus AS unit ON unit.sku = entry.sku;

  IF v_count = 0 THEN RAISE EXCEPTION 'min_components' USING ERRCODE = 'P0001'; END IF;
  IF v_distinct <> v_count THEN RAISE EXCEPTION 'duplicate_component' USING ERRCODE = 'P0001'; END IF;
  IF v_core = 0 THEN RAISE EXCEPTION 'addon_only_composition' USING ERRCODE = 'P0001'; END IF;
  IF v_resolved <> v_count THEN RAISE EXCEPTION 'component_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_unsellable > 0 THEN RAISE EXCEPTION 'component_not_sellable' USING ERRCODE = 'P0001'; END IF;

  SELECT list.currency INTO v_currency
    FROM public.catalog_bundle_prices AS price
    JOIN public.price_lists AS list ON list.id = price.price_list_id
   WHERE price.bundle_id = v_bundle_id AND price.active
   ORDER BY price.valid_from DESC
   LIMIT 1;

  IF v_currency IS NOT NULL THEN
    SELECT count(*) INTO v_mismatched
      FROM jsonb_to_recordset(COALESCE(p_components, '[]'::jsonb))
           AS entry(sku text, quantity integer, is_addon boolean, sort_order integer)
      JOIN public.catalog_skus AS unit ON unit.sku = entry.sku
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.price_entries AS unit_price
         JOIN public.price_lists AS unit_list ON unit_list.id = unit_price.price_list_id
        WHERE unit_price.variant_id = unit.id
          AND unit_price.active
          AND unit_list.currency = v_currency);
    IF v_mismatched > 0 THEN
      RAISE EXCEPTION 'component_currency_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_mode = 'dry_run' THEN
    RETURN jsonb_build_object('code', p_code, 'componentCount', v_count,
                              'idempotent', false, 'dryRun', true);
  END IF;

  DELETE FROM public.catalog_bundle_components WHERE bundle_id = v_bundle_id;
  INSERT INTO public.catalog_bundle_components
    (bundle_id, catalog_sku_id, quantity, is_addon, sort_order)
  SELECT v_bundle_id, unit.id, entry.quantity,
         COALESCE(entry.is_addon, false), COALESCE(entry.sort_order, 0)
    FROM jsonb_to_recordset(COALESCE(p_components, '[]'::jsonb))
         AS entry(sku text, quantity integer, is_addon boolean, sort_order integer)
    JOIN public.catalog_skus AS unit ON unit.sku = entry.sku;

  UPDATE public.catalog_bundles SET updated_at = now() WHERE id = v_bundle_id;

  INSERT INTO public.catalog_bundle_write_events
    (bundle_code, action, principal_id, idempotency_key, after_state)
  VALUES (p_code, 'bundle_composition_set', p_actor_id, p_idempotency_key,
          jsonb_build_object('componentCount', v_count, 'requestId', p_request_id,
                             'source', p_source));

  RETURN jsonb_build_object('code', p_code, 'componentCount', v_count,
                            'idempotent', false, 'dryRun', false);
END;
$$;

CREATE FUNCTION public.admin_set_bundle_target_price(
  p_actor_id           uuid,
  p_code               text,
  p_price_mode         text,
  p_target_price_minor integer,
  p_currency           text,
  p_amount_kind        text DEFAULT 'gross',
  p_mode               text DEFAULT 'commit',
  p_idempotency_key    text DEFAULT NULL,
  p_request_id         text DEFAULT NULL,
  p_source             text DEFAULT 'operator'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_bundle_id uuid;
  v_list_id uuid;
  v_reference_total bigint;
  v_unit_total bigint;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'actor_required' USING ERRCODE = '42501'; END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.catalog_bundle_write_events WHERE idempotency_key = p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', true, 'dryRun', false);
  END IF;

  SELECT id INTO v_bundle_id FROM public.catalog_bundles WHERE code = p_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'bundle_not_found' USING ERRCODE = 'P0002'; END IF;

  SELECT id INTO v_list_id
    FROM public.price_lists
   WHERE currency = p_currency AND status = 'active'
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_list_id IS NULL THEN RAISE EXCEPTION 'no_active_price_list' USING ERRCODE = 'P0002'; END IF;

  SELECT COALESCE(sum(component.quantity::bigint * unit_price.unit_price_minor), 0),
         COALESCE(sum(component.quantity::bigint), 0)
    INTO v_reference_total, v_unit_total
    FROM public.catalog_bundle_components AS component
    JOIN public.price_entries AS unit_price
      ON unit_price.variant_id = component.catalog_sku_id
     AND unit_price.price_list_id = v_list_id
     AND unit_price.active
   WHERE component.bundle_id = v_bundle_id;

  IF v_reference_total = 0 THEN RAISE EXCEPTION 'min_components' USING ERRCODE = 'P0001'; END IF;
  IF p_target_price_minor > v_reference_total THEN
    RAISE EXCEPTION 'target_above_component_sum' USING ERRCODE = 'P0001';
  END IF;
  IF p_target_price_minor < v_unit_total THEN
    RAISE EXCEPTION 'target_below_floor' USING ERRCODE = 'P0001';
  END IF;

  IF p_mode = 'dry_run' THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', false, 'dryRun', true);
  END IF;

  UPDATE public.catalog_bundle_prices
     SET active = false, valid_to = v_now
   WHERE bundle_id = v_bundle_id AND price_list_id = v_list_id AND mode = p_price_mode
     AND active AND valid_from < v_now;

  INSERT INTO public.catalog_bundle_prices
    (bundle_id, price_list_id, mode, target_price_minor, amount_kind, active, valid_from)
  VALUES (v_bundle_id, v_list_id, p_price_mode, p_target_price_minor,
          COALESCE(p_amount_kind, 'gross'), true, v_now);

  INSERT INTO public.catalog_bundle_write_events
    (bundle_code, action, principal_id, idempotency_key, after_state)
  VALUES (p_code, 'bundle_target_price_set', p_actor_id, p_idempotency_key,
          jsonb_build_object('mode', p_price_mode, 'targetPriceMinor', p_target_price_minor,
                             'currency', p_currency, 'referenceTotalMinor', v_reference_total,
                             'requestId', p_request_id, 'source', p_source));

  RETURN jsonb_build_object('code', p_code, 'idempotent', false, 'dryRun', false);
END;
$$;

CREATE FUNCTION public.admin_archive_bundle(
  p_actor_id        uuid,
  p_code            text,
  p_mode            text DEFAULT 'commit',
  p_idempotency_key text DEFAULT NULL,
  p_request_id      text DEFAULT NULL,
  p_source          text DEFAULT 'operator'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'actor_required' USING ERRCODE = '42501'; END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.catalog_bundle_write_events WHERE idempotency_key = p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', true, 'dryRun', false);
  END IF;

  SELECT status INTO v_status FROM public.catalog_bundles WHERE code = p_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'bundle_not_found' USING ERRCODE = 'P0002'; END IF;

  IF p_mode = 'dry_run' THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', false, 'dryRun', true);
  END IF;

  UPDATE public.catalog_bundles SET status = 'archived', updated_at = now() WHERE code = p_code;

  INSERT INTO public.catalog_bundle_write_events
    (bundle_code, action, principal_id, idempotency_key, before_state, after_state)
  VALUES (p_code, 'bundle_archive', p_actor_id, p_idempotency_key,
          jsonb_build_object('status', v_status),
          jsonb_build_object('status', 'archived', 'requestId', p_request_id, 'source', p_source));

  RETURN jsonb_build_object('code', p_code, 'idempotent', false, 'dryRun', false);
END;
$$;

CREATE FUNCTION public.admin_restore_bundle(
  p_actor_id        uuid,
  p_code            text,
  p_mode            text DEFAULT 'commit',
  p_idempotency_key text DEFAULT NULL,
  p_request_id      text DEFAULT NULL,
  p_source          text DEFAULT 'operator'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'actor_required' USING ERRCODE = '42501'; END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.catalog_bundle_write_events WHERE idempotency_key = p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', true, 'dryRun', false);
  END IF;

  SELECT status INTO v_status FROM public.catalog_bundles WHERE code = p_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'bundle_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_status <> 'archived' THEN
    RAISE EXCEPTION 'restore_requires_archived' USING ERRCODE = 'P0001';
  END IF;

  IF p_mode = 'dry_run' THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', false, 'dryRun', true);
  END IF;

  UPDATE public.catalog_bundles SET status = 'draft', updated_at = now() WHERE code = p_code;

  INSERT INTO public.catalog_bundle_write_events
    (bundle_code, action, principal_id, idempotency_key, before_state, after_state)
  VALUES (p_code, 'bundle_restore', p_actor_id, p_idempotency_key,
          jsonb_build_object('status', v_status),
          jsonb_build_object('status', 'draft', 'requestId', p_request_id, 'source', p_source));

  RETURN jsonb_build_object('code', p_code, 'idempotent', false, 'dryRun', false);
END;
$$;

CREATE FUNCTION public.admin_activate_bundle(
  p_actor_id        uuid,
  p_code            text,
  p_mode            text DEFAULT 'commit',
  p_idempotency_key text DEFAULT NULL,
  p_request_id      text DEFAULT NULL,
  p_source          text DEFAULT 'operator'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_bundle public.catalog_bundles%ROWTYPE;
  v_components integer;
  v_prices integer;
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'actor_required' USING ERRCODE = '42501'; END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.catalog_bundle_write_events WHERE idempotency_key = p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', true, 'dryRun', false);
  END IF;

  SELECT * INTO v_bundle FROM public.catalog_bundles WHERE code = p_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'bundle_not_found' USING ERRCODE = 'P0002'; END IF;

  IF v_bundle.fulfillment_mode <> 'virtual' THEN
    RAISE EXCEPTION 'fulfillment_mode_unsupported' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_components
    FROM public.catalog_bundle_components WHERE bundle_id = v_bundle.id;
  IF v_components = 0 THEN
    RAISE EXCEPTION 'composition_required_to_sell' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_prices
    FROM public.catalog_bundle_prices WHERE bundle_id = v_bundle.id AND active;
  IF v_prices = 0 THEN
    RAISE EXCEPTION 'price_required_to_sell' USING ERRCODE = 'P0001';
  END IF;

  IF p_mode = 'dry_run' THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', false, 'dryRun', true);
  END IF;

  UPDATE public.catalog_bundles SET status = 'active', updated_at = now() WHERE id = v_bundle.id;

  INSERT INTO public.catalog_bundle_write_events
    (bundle_code, action, principal_id, idempotency_key, before_state, after_state)
  VALUES (p_code, 'bundle_activate', p_actor_id, p_idempotency_key,
          jsonb_build_object('status', v_bundle.status),
          jsonb_build_object('status', 'active', 'requestId', p_request_id, 'source', p_source));

  RETURN jsonb_build_object('code', p_code, 'idempotent', false, 'dryRun', false);
END;
$$;

CREATE FUNCTION public.admin_deactivate_bundle(
  p_actor_id        uuid,
  p_code            text,
  p_mode            text DEFAULT 'commit',
  p_idempotency_key text DEFAULT NULL,
  p_request_id      text DEFAULT NULL,
  p_source          text DEFAULT 'operator'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_actor_id IS NULL THEN RAISE EXCEPTION 'actor_required' USING ERRCODE = '42501'; END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.catalog_bundle_write_events WHERE idempotency_key = p_idempotency_key
  ) THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', true, 'dryRun', false);
  END IF;

  SELECT status INTO v_status FROM public.catalog_bundles WHERE code = p_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'bundle_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'deactivate_requires_active' USING ERRCODE = 'P0001';
  END IF;

  IF p_mode = 'dry_run' THEN
    RETURN jsonb_build_object('code', p_code, 'idempotent', false, 'dryRun', true);
  END IF;

  UPDATE public.catalog_bundles SET status = 'draft', updated_at = now() WHERE code = p_code;

  INSERT INTO public.catalog_bundle_write_events
    (bundle_code, action, principal_id, idempotency_key, before_state, after_state)
  VALUES (p_code, 'bundle_deactivate', p_actor_id, p_idempotency_key,
          jsonb_build_object('status', v_status),
          jsonb_build_object('status', 'draft', 'requestId', p_request_id, 'source', p_source));

  RETURN jsonb_build_object('code', p_code, 'idempotent', false, 'dryRun', false);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_upsert_bundle_draft(
  uuid, text, text, text, jsonb, jsonb, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_bundle_composition(
  uuid, text, jsonb, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_bundle_target_price(
  uuid, text, text, integer, text, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_archive_bundle(uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_restore_bundle(uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_activate_bundle(uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_deactivate_bundle(uuid, text, text, text, text, text) FROM PUBLIC;

COMMENT ON TABLE public.catalog_bundle_write_events IS
  'Append-only record of every accepted bundle write: what changed, which principal asked, and under which idempotency key. Replay recognition, not an authorisation record.';
COMMENT ON COLUMN public.catalog_bundle_write_events.idempotency_key IS
  'Names one attempt, not one payload. Unique when present, so a retried call returns the original outcome instead of writing twice.';
