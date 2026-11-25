CREATE FUNCTION public.subscriptions__read_renewal_occurrence(p_client uuid,p_subscription uuid,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE occurrence public.subscription_cycle_occurrences; deadline timestamp;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.subscriptions WHERE id=p_subscription AND client_id=p_client) THEN
    RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023', DETAIL='/subscriptionId';
  END IF;
  SELECT * INTO occurrence FROM public.subscription_cycle_occurrences
   WHERE subscription_id=p_subscription AND client_id=p_client AND cycle_key=p_key;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('kind','unavailable','code','renewal_cycle_unavailable','field','/cycleKey');
  END IF;
  IF occurrence.operation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.subscription_renewal_operations op
    WHERE op.id=occurrence.operation_id AND op.subscription_id=p_subscription
  ) THEN
    RETURN jsonb_build_object('kind','unavailable','code','renewal_cycle_unavailable','field','/cycleKey');
  END IF;
  IF occurrence.deadline_rule_ref IS NOT NULL AND occurrence.cadence_seconds % 86400=0
     AND occurrence.cadence_seconds / 86400<=2147483647 THEN
    BEGIN
      deadline:=(occurrence.effective_due_at AT TIME ZONE 'UTC')
        - make_interval(days=>(occurrence.lead_seconds/86400)::integer,secs=>occurrence.lead_seconds%86400);
    EXCEPTION WHEN datetime_field_overflow THEN
      deadline:=NULL;
    END;
  END IF;
  IF deadline IS NULL OR extract(year FROM deadline) NOT BETWEEN 1 AND 9999
     OR extract(year FROM occurrence.original_anchor_at AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999
     OR extract(year FROM occurrence.effective_due_at AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999
     OR (occurrence.cancellation_effective_at IS NOT NULL AND
         extract(year FROM occurrence.cancellation_effective_at AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999) THEN
    RETURN jsonb_build_object('kind','unavailable','code','renewal_deadline_rule_unsupported','field','/deadlineRuleRef');
  END IF;
  RETURN jsonb_build_object(
    'clientId',p_client,'subscriptionId',p_subscription,'cycleKey',p_key,
    'originalAnchorAt',to_char(occurrence.original_anchor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'effectiveDueAt',to_char(occurrence.effective_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'cancellationDeadlineAt',to_char(deadline,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'deadlineRuleRef',occurrence.deadline_rule_ref,'deadlineRuleRevision',occurrence.deadline_rule_revision,
    'cadenceSeconds',occurrence.cadence_seconds,'rail',occurrence.rail,'lifecycle',occurrence.lifecycle,
    'cancellationEffectiveAt',to_char(occurrence.cancellation_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'operationId',occurrence.operation_id,'commercialGenerationId',occurrence.commercial_generation_id);
END;
$$;

CREATE FUNCTION public.subscriptions__lock_renewal_occurrence(p_client uuid,p_subscription uuid,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE occurrence_view jsonb; cycle_lifecycle text;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE='22023', DETAIL='/cycleKey';
  END IF;
  PERFORM 1 FROM public.subscriptions WHERE id=p_subscription AND client_id=p_client FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_command_forbidden' USING ERRCODE='22023', DETAIL='/subscriptionId';
  END IF;
  SELECT lifecycle INTO cycle_lifecycle FROM public.subscription_cycle_occurrences
   WHERE subscription_id=p_subscription AND client_id=p_client AND cycle_key=p_key AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE='22023', DETAIL='/cycleKey';
  END IF;
  occurrence_view:=public.subscriptions__read_renewal_occurrence(p_client,p_subscription,p_key);
  IF occurrence_view->>'kind'='unavailable' THEN
    RAISE EXCEPTION USING MESSAGE=occurrence_view->>'code', ERRCODE='22023', DETAIL=occurrence_view->>'field';
  END IF;
  IF cycle_lifecycle<>'active' THEN
    RAISE EXCEPTION 'renewal_cycle_blocked' USING ERRCODE='22023', DETAIL='/cycleKey';
  END IF;
  RETURN occurrence_view;
END;
$$;

CREATE FUNCTION public.subscriptions__assert_legacy_renewal_rail(p_subscription uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'renewal_write_scope_unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.subscriptions WHERE id=p_subscription FOR UPDATE NOWAIT;
  IF FOUND AND EXISTS (SELECT 1 FROM public.subscription_cycle_occurrences
       WHERE subscription_id=p_subscription AND rail='v3') THEN
    RAISE EXCEPTION 'renewal_v3_unavailable' USING ERRCODE='22023', DETAIL='/rail';
  END IF;
END;
$$;

CREATE FUNCTION public.subscriptions__lock_renewal_writer_scope(p_subscription uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE writer name:=coalesce(nullif(current_setting('role'),'none'),session_user::text)::name;
BEGIN
  IF NOT has_column_privilege(writer,'public.subscriptions','id','SELECT')
     OR NOT has_column_privilege(writer,'public.subscription_renewal_operations','subscription_id','SELECT')
     OR NOT has_column_privilege(writer,'public.subscription_renewal_operations','claimed_by','UPDATE') THEN
    RAISE EXCEPTION 'renewal_write_scope_unavailable' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.rolname=writer
       WHERE c.oid IN ('public.subscriptions'::regclass,'public.subscription_renewal_operations'::regclass)
         AND c.relrowsecurity AND NOT (r.rolsuper OR r.rolbypassrls
           OR (NOT c.relforcerowsecurity AND pg_has_role(writer,c.relowner,'USAGE')))) THEN
    RAISE EXCEPTION 'renewal_write_scope_unavailable' USING ERRCODE='42501';
  END IF;
  IF NOT has_table_privilege(writer,'public.subscription_renewal_operations','INSERT')
     AND NOT EXISTS (SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=p_subscription) THEN
    RAISE EXCEPTION 'renewal_write_scope_unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.subscriptions WHERE id=p_subscription FOR UPDATE NOWAIT;
END;
$$;

-- A permitted incumbent write already exposes rail or absence. UUIDs outside
-- the writer's scope receive the same result as a nonexistent UUID.
CREATE FUNCTION public.subscriptions__check_legacy_renewal_write(p_subscription uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM public.subscriptions__lock_renewal_writer_scope(p_subscription);
  PERFORM public.subscriptions__assert_legacy_renewal_rail(p_subscription);
END;
$$;

CREATE FUNCTION public.subscriptions__guard_renewal_write()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  row_data jsonb; before_row jsonb; after_row jsonb;
  owner_id uuid; order_id uuid; cycle_id uuid; operation_id uuid;
  owners uuid[]; prior_owners uuid[]; row_owners uuid[]; cleanup boolean:=false;
  linked_operation uuid; linked_cycle uuid;
  migration_owner boolean:=pg_has_role(current_user,
    (SELECT relowner FROM pg_class WHERE oid='public.subscription_cycle_occurrences'::regclass),'USAGE');
BEGIN
  IF TG_OP<>'INSERT' THEN before_row:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN after_row:=to_jsonb(NEW); END IF;
  -- This closed import principal can insert booked history only through its retained-row routine.
  IF TG_OP='INSERT' AND TG_TABLE_NAME='subscription_cycles' AND current_user='openlup_retained_import_owner' THEN
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE' THEN
    CASE TG_TABLE_NAME
      WHEN 'subscription_renewal_operations' THEN
        cleanup:=(
          before_row-ARRAY['state','terminal_outcome','terminal_reason','terminal_at','updated_at']
            =after_row-ARRAY['state','terminal_outcome','terminal_reason','terminal_at','updated_at']
          AND (NEW.state='refused' AND OLD.state IN ('claimed','reserved')
            OR OLD.state='attempt_prepared' AND EXISTS (
              SELECT 1 FROM public.commerce_settlement_intents i
              WHERE i.renewal_operation_id=OLD.id AND i.renewal_operation_fingerprint=OLD.operation_fingerprint
                AND ((i.status='settled' AND NEW.state='succeeded') OR (i.status='failed' AND NEW.state='refused'))
            )))
          OR (OLD.state='attempt_prepared' AND OLD.external_attempt_ref IS NULL
            AND NEW.external_attempt_ref IS NOT NULL AND NEW.external_attempt_acknowledged_at IS NOT NULL
            AND before_row-ARRAY['external_attempt_ref','external_attempt_acknowledged_at','updated_at']
              =after_row-ARRAY['external_attempt_ref','external_attempt_acknowledged_at','updated_at']
            AND EXISTS (SELECT 1 FROM public.commerce_settlement_intents i
              WHERE i.renewal_operation_id=OLD.id AND i.renewal_operation_fingerprint=OLD.operation_fingerprint));
      WHEN 'fulfillment_inventory_reservations' THEN
        cleanup:=(OLD.status='held' AND NEW.status IN ('released','expired')
          OR OLD.status='committed' AND EXISTS (
            SELECT 1 FROM public.commerce_settlement_intents i
             WHERE i.renewal_operation_id=OLD.renewal_operation_id AND i.renewal_operation_fingerprint=OLD.operation_fingerprint
               AND ((i.status='settled' AND NEW.status='consumed') OR (i.status='failed' AND NEW.status='released'))
          ))
          AND before_row-ARRAY['status','expires_at','terminal_reason','updated_at']
            =after_row-ARRAY['status','expires_at','terminal_reason','updated_at'];
      WHEN 'subscription_stock_wait_cases' THEN
        cleanup:=before_row-'notice_messages'=after_row-'notice_messages'
          OR (OLD.state='stock_secured' AND NEW.state='resumed'
            AND before_row-ARRAY['state','resumed_at','cycle_id','order_id','fulfillment_id']
              =after_row-ARRAY['state','resumed_at','cycle_id','order_id','fulfillment_id']
            AND EXISTS (SELECT 1 FROM public.commerce_orders o
              JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id AND c.status='paid'
              JOIN public.fulfillment_inventory_reservations r ON r.renewal_operation_id=c.renewal_operation_id AND r.status='consumed'
              JOIN public.commerce_settlement_intents i ON i.order_id=o.id AND i.status='settled'
              JOIN public.fulfillment_shipments sh ON sh.id=NEW.fulfillment_id AND sh.order_id=o.id
              WHERE o.id=NEW.order_id AND c.id=NEW.cycle_id AND o.renewal_operation_id=NEW.renewal_operation_id
                AND sh.replaces_shipment_id IS NULL AND sh.status NOT IN ('cancelled','exception')
                AND o.status IN ('paid','fulfillment_pending','fulfilled')
                AND NOT EXISTS (SELECT 1 FROM public.commerce_order_holds h WHERE h.order_id=o.id AND h.status='active')));
      ELSE NULL;
    END CASE;
  END IF;

  -- Discover coordinates, lock the parents without waiting behind a child lock,
  -- then verify that any indirect link still resolves to the same scope.
  FOR pass IN 1..2 LOOP
    owners:='{}';
    FOREACH row_data IN ARRAY ARRAY[before_row,after_row] LOOP
      IF row_data IS NULL THEN CONTINUE; END IF;
      owner_id:=(row_data->>'subscription_id')::uuid;
      operation_id:=(row_data->>'renewal_operation_id')::uuid;
      cycle_id:=coalesce(row_data->>'subscription_cycle_id',row_data->>'cycle_id')::uuid;
      order_id:=coalesce(row_data->>'purchase_order_id',row_data->>'order_id')::uuid;
      IF TG_TABLE_NAME='fulfillment_inventory_reservation_lines' THEN
        SELECT r.renewal_operation_id,r.purchase_order_id INTO operation_id,order_id
          FROM public.fulfillment_inventory_reservations r WHERE r.id=(row_data->>'reservation_id')::uuid;
      END IF;
      SELECT o.renewal_operation_id,o.subscription_cycle_id INTO linked_operation,linked_cycle
        FROM public.commerce_orders o WHERE o.id=order_id;
      row_owners:=ARRAY(SELECT DISTINCT id FROM (
        SELECT owner_id AS id
        UNION ALL SELECT op.subscription_id FROM public.subscription_renewal_operations op WHERE op.id IN (operation_id,linked_operation)
        UNION ALL SELECT c.subscription_id FROM public.subscription_cycles c WHERE c.id IN (cycle_id,linked_cycle)
      ) AS links WHERE id IS NOT NULL ORDER BY id);
      IF cardinality(row_owners)>1 THEN
        RAISE EXCEPTION 'renewal_cycle_unavailable' USING ERRCODE='22023', DETAIL='/cycleKey';
      END IF;
      owners:=owners||row_owners;
    END LOOP;
    IF pass=1 THEN
      prior_owners:=owners;
      FOR owner_id IN SELECT DISTINCT id FROM unnest(owners) id ORDER BY id LOOP
        IF cleanup AND migration_owner THEN
          PERFORM 1 FROM public.subscriptions WHERE id=owner_id FOR UPDATE NOWAIT;
        ELSIF cleanup THEN
          PERFORM public.subscriptions__lock_renewal_writer_scope(owner_id);
        ELSIF migration_owner THEN
          PERFORM public.subscriptions__assert_legacy_renewal_rail(owner_id);
        ELSE
          PERFORM public.subscriptions__check_legacy_renewal_write(owner_id);
        END IF;
      END LOOP;
    ELSIF owners IS DISTINCT FROM prior_owners THEN
      RAISE EXCEPTION 'renewal_write_scope_changed' USING ERRCODE='55P03';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


CREATE FUNCTION public.subscriptions__eligible_legacy_renewal_write(p_subscription uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM public.subscriptions__check_legacy_renewal_write(p_subscription);
  RETURN true;
EXCEPTION WHEN invalid_parameter_value THEN
  IF SQLERRM<>'renewal_v3_unavailable' THEN RAISE; END IF;
  RETURN false;
WHEN lock_not_available THEN
  RETURN false;
END;
$$;

CREATE FUNCTION public.subscriptions__export_renewal_occurrences(p_client uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE caller name:=coalesce(nullif(current_setting('role'),'none'),session_user::text)::name;
BEGIN
 IF NOT has_table_privilege(caller,'public.subscriptions','SELECT')
   OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.rolname=caller
     WHERE c.oid='public.subscriptions'::regclass AND c.relrowsecurity
       AND NOT (r.rolsuper OR r.rolbypassrls OR (NOT c.relforcerowsecurity AND pg_has_role(caller,c.relowner,'USAGE'))))
 THEN RETURN '[]'::jsonb; END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
  'cycleKey',c.cycle_key,'subscriptionId',c.subscription_id,'rail',c.rail,'lifecycle',c.lifecycle,
  'originalAnchorAt',to_char(c.original_anchor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'effectiveDueAt',to_char(c.effective_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'cancellationEffectiveAt',to_char(c.cancellation_effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  ORDER BY c.cycle_key),'[]'::jsonb)
 FROM public.subscription_cycle_occurrences c
 JOIN public.subscriptions s ON s.id=c.subscription_id AND s.client_id=c.client_id
 WHERE c.client_id=p_client);
END;
$$;

REVOKE ALL ON FUNCTION public.subscriptions__eligible_legacy_renewal_write(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscriptions__export_renewal_occurrences(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscriptions__check_legacy_renewal_write(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscriptions__lock_renewal_writer_scope(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscriptions__assert_legacy_renewal_rail(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscriptions__guard_renewal_write() FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__check_legacy_renewal_write(uuid), public.subscriptions__lock_renewal_writer_scope(uuid), public.subscriptions__assert_legacy_renewal_rail(uuid), public.subscriptions__guard_renewal_write(), public.subscriptions__eligible_legacy_renewal_write(uuid), public.subscriptions__export_renewal_occurrences(uuid) FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__check_legacy_renewal_write(uuid), public.subscriptions__lock_renewal_writer_scope(uuid), public.subscriptions__assert_legacy_renewal_rail(uuid), public.subscriptions__guard_renewal_write(), public.subscriptions__eligible_legacy_renewal_write(uuid), public.subscriptions__export_renewal_occurrences(uuid) FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON FUNCTION public.subscriptions__read_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__lock_renewal_occurrence(uuid,uuid,uuid), public.subscriptions__assert_legacy_renewal_rail(uuid), public.subscriptions__guard_renewal_write() FROM service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.subscriptions__check_legacy_renewal_write(uuid), public.subscriptions__lock_renewal_writer_scope(uuid), public.subscriptions__eligible_legacy_renewal_write(uuid), public.subscriptions__export_renewal_occurrences(uuid) TO service_role;';
END IF; END; $$;

CREATE TRIGGER subscriptions_guard_renewal_operations BEFORE INSERT OR UPDATE OR DELETE ON public.subscription_renewal_operations FOR EACH ROW EXECUTE FUNCTION public.subscriptions__guard_renewal_write();
CREATE TRIGGER subscriptions_guard_renewal_cycles BEFORE INSERT OR UPDATE OF subscription_id, id, scheduled_at, renewal_operation_id, renewal_operation_fingerprint ON public.subscription_cycles FOR EACH ROW EXECUTE FUNCTION public.subscriptions__guard_renewal_write();
CREATE TRIGGER subscriptions_guard_renewal_orders BEFORE INSERT OR UPDATE OF client_id, id, subscription_cycle_id, renewal_operation_id, renewal_operation_fingerprint ON public.commerce_orders FOR EACH ROW EXECUTE FUNCTION public.subscriptions__guard_renewal_write();
CREATE TRIGGER subscriptions_guard_renewal_stock_wait BEFORE INSERT OR UPDATE OR DELETE ON public.subscription_stock_wait_cases FOR EACH ROW EXECUTE FUNCTION public.subscriptions__guard_renewal_write();
CREATE TRIGGER subscriptions_guard_renewal_reservations BEFORE INSERT OR UPDATE OR DELETE ON public.fulfillment_inventory_reservations FOR EACH ROW EXECUTE FUNCTION public.subscriptions__guard_renewal_write();
CREATE TRIGGER subscriptions_guard_renewal_reservation_lines BEFORE INSERT OR UPDATE OR DELETE ON public.fulfillment_inventory_reservation_lines FOR EACH ROW EXECUTE FUNCTION public.subscriptions__guard_renewal_write();
CREATE OR REPLACE FUNCTION public.fulfillment_reserve_subscription_renewal(
  p_operation_id uuid,
  p_claim_token uuid,
  p_hold_seconds integer DEFAULT 900,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_operation public.subscription_renewal_operations%ROWTYPE;
  v_parent uuid;
  v_reservation public.fulfillment_inventory_reservations%ROWTYPE;
  v_line jsonb;
  v_source text;
  v_sku text;
  v_quantity integer;
  v_available integer;
BEGIN
  IF p_operation_id IS NULL OR p_claim_token IS NULL
    OR p_hold_seconds IS NULL OR p_hold_seconds NOT BETWEEN 60 AND 86400
  THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_input' USING ERRCODE = '22023';
  END IF;

DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END;
  SELECT subscription_id INTO v_parent FROM public.subscription_renewal_operations WHERE id=p_operation_id;
  IF FOUND THEN PERFORM public.subscriptions__lock_renewal_writer_scope(v_parent); END IF;
  SELECT * INTO v_operation FROM public.subscription_renewal_operations
   WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_operation_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_operation.subscription_id IS DISTINCT FROM v_parent THEN
    RAISE EXCEPTION 'renewal_write_scope_changed' USING ERRCODE='55P03';
  END IF;
  IF v_operation.claim_token <> p_claim_token
    OR v_operation.lease_expires_at <= COALESCE(p_now, now())
  THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_stale_claim' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_reservation FROM public.fulfillment_inventory_reservations
   WHERE renewal_operation_id = p_operation_id FOR UPDATE;
  IF FOUND THEN
    IF v_reservation.operation_fingerprint <> v_operation.operation_fingerprint THEN
      RAISE EXCEPTION 'fulfillment_renewal_reservation_fingerprint_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_reservation.status = 'held'
      AND v_reservation.expires_at <= COALESCE(p_now, now())
      AND v_operation.state = 'reserved'
    THEN
      PERFORM public.subscriptions__check_legacy_renewal_write(v_operation.subscription_id);
      UPDATE public.fulfillment_inventory_reservations
         SET status = 'expired', expires_at = NULL,
             terminal_reason = 'reservation_expired', updated_at = COALESCE(p_now, now())
       WHERE id = v_reservation.id
       RETURNING * INTO v_reservation;
      UPDATE public.subscription_renewal_operations
         SET state = 'refused', terminal_outcome = 'refused',
             terminal_reason = 'reservation_expired', terminal_at = COALESCE(p_now, now()),
             updated_at = COALESCE(p_now, now())
       WHERE id = p_operation_id RETURNING * INTO v_operation;
      INSERT INTO public.subscription_renewal_outcomes (
        renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
      ) VALUES (
        p_operation_id, v_operation.operation_fingerprint,
        v_operation.identity_key || ':reservation-expired', 'refused',
        'reservation_expired', COALESCE(p_now, now()));
      RETURN jsonb_build_object(
        'reserved', false, 'replayed', true, 'reservationId', v_reservation.id,
        'status', 'expired', 'reason', 'reservation_expired');
    END IF;
    RETURN jsonb_build_object(
      'reserved', v_reservation.status IN ('held', 'committed', 'consumed'),
      'replayed', true, 'reservationId', v_reservation.id,
      'status', v_reservation.status, 'reason', v_reservation.terminal_reason);
  END IF;

  PERFORM public.subscriptions__check_legacy_renewal_write(v_operation.subscription_id);
  IF v_operation.state <> 'claimed' THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_state' USING ERRCODE = '22023';
  END IF;
  v_source := v_operation.cycle_snapshot->>'stockSourceKey';
  IF v_source IS NULL OR v_source !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' THEN
    RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_snapshot' USING ERRCODE = '22023';
  END IF;

  -- Lock all stock rows in a deterministic order before computing ATP, so two different
  -- operations containing the same SKUs cannot both spend the same observed availability.
  PERFORM stock.sku
    FROM public.fulfillment_stock_current stock
    JOIN jsonb_array_elements(v_operation.cycle_snapshot->'lines') line
      ON stock.source_key = v_source AND stock.sku = line->>'sku'
   ORDER BY stock.sku
   FOR UPDATE OF stock;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    v_sku := v_line->>'sku';
    BEGIN v_quantity := (v_line->>'quantity')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_snapshot' USING ERRCODE = '22023';
    END;
    IF btrim(COALESCE(v_sku, '')) = '' OR v_quantity < 1 THEN
      RAISE EXCEPTION 'fulfillment_renewal_reservation_invalid_snapshot' USING ERRCODE = '22023';
    END IF;

    SELECT (public.inventory_available_to_promise(v_source,v_sku,COALESCE(p_now,now()),true)
      ->>'available_quantity')::integer INTO v_available;
    IF v_available < v_quantity THEN
      UPDATE public.subscription_renewal_operations
         SET state = 'refused', terminal_outcome = 'refused',
             terminal_reason = 'inventory_unavailable', terminal_at = COALESCE(p_now, now()),
             updated_at = COALESCE(p_now, now())
       WHERE id = p_operation_id RETURNING * INTO v_operation;
      INSERT INTO public.subscription_renewal_outcomes (
        renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
      ) VALUES (
        p_operation_id, v_operation.operation_fingerprint,
        v_operation.identity_key || ':inventory', 'refused', 'inventory_unavailable',
        COALESCE(p_now, now()));
      RETURN jsonb_build_object(
        'reserved', false, 'replayed', false, 'reservationId', NULL,
        'status', 'refused', 'reason', 'inventory_unavailable');
    END IF;
  END LOOP;

  INSERT INTO public.fulfillment_inventory_reservations (
    renewal_operation_id, operation_fingerprint, source_key, expires_at, created_at, updated_at
  ) VALUES (
    p_operation_id, v_operation.operation_fingerprint, v_source,
    COALESCE(p_now, now()) + make_interval(secs => p_hold_seconds),
    COALESCE(p_now, now()), COALESCE(p_now, now())
  ) RETURNING * INTO v_reservation;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_operation.cycle_snapshot->'lines')
  LOOP
    INSERT INTO public.fulfillment_inventory_reservation_lines (
      reservation_id, operation_fingerprint, sku, quantity
    ) VALUES (
      v_reservation.id, v_operation.operation_fingerprint,
      v_line->>'sku', (v_line->>'quantity')::integer);
  END LOOP;

  UPDATE public.subscription_renewal_operations
     SET state = 'reserved', updated_at = COALESCE(p_now, now())
   WHERE id = p_operation_id;
  RETURN jsonb_build_object(
    'reserved', true, 'replayed', false, 'reservationId', v_reservation.id,
    'status', 'held', 'reason', NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_stock_wait_admit(p_input jsonb,p_due jsonb,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE frozen jsonb; op public.subscription_renewal_operations; result jsonb; c public.subscription_stock_wait_cases; parent uuid;
BEGIN
DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END;
 SELECT id INTO parent FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations
   WHERE id=(p_input->>'operationId')::uuid) FOR UPDATE;
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=(p_input->>'operationId')::uuid;
 IF op.subscription_id IS DISTINCT FROM parent THEN
  RAISE EXCEPTION 'renewal_write_scope_changed' USING ERRCODE='55P03'; END IF;
 frozen:=public.subscription_stock_wait_frozen(op.subscription_id,op.scheduled_at);
 IF frozen IS NULL AND op.id IS NOT NULL
   AND op.cycle_snapshot IS NOT DISTINCT FROM p_input->'snapshot'
   AND op.operation_fingerprint IS NOT DISTINCT FROM p_input->>'operationFingerprint'
   AND op.identity_key IS NOT DISTINCT FROM p_input->>'identityKey' AND NOT (p_due ? 'stockWaitRecovery')
 THEN PERFORM public.subscriptions__check_legacy_renewal_write(parent); END IF;
 IF frozen IS NULL OR frozen->'snapshot' IS DISTINCT FROM p_input->'snapshot' OR
  frozen->>'operationFingerprint' IS DISTINCT FROM p_input->>'operationFingerprint' OR
  frozen->>'identityKey' IS DISTINCT FROM p_input->>'identityKey' OR
  (p_due ? 'stockWaitRecovery' AND frozen->'binding' IS DISTINCT FROM p_due->'stockWaitRecovery') THEN
  RAISE EXCEPTION 'stock_wait_frozen_binding_changed' USING ERRCODE='23505'; END IF;
 IF op.state='refused' OR (op.state='reserved' AND op.lease_expires_at<=p_now) THEN
  RETURN public.subscription_stock_wait_recover_refusal(op.id,op.operation_fingerprint,p_input->>'worker',p_now);
 END IF;
 IF op.state='reserved' THEN RETURN public.subscription_renewal_operation_response(op,false,true,'stock_secured'); END IF;
 PERFORM public.subscriptions__check_legacy_renewal_write(op.subscription_id);
 result:=public.fulfillment_reserve_subscription_renewal(op.id,(p_input->>'claimToken')::uuid,900,p_now);
 IF (result->>'reserved')::boolean THEN RETURN result||jsonb_build_object('waiting',false); END IF;
 -- Record the wait immediately; lease expiry is still required before reset.
 INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits,opened_at,last_checked_at)
 SELECT op.subscription_id,s.client_id,op.id,op.scheduled_at,op.cycle_number,'waiting',p_due,op.cycle_snapshot,
  op.operation_fingerprint,op.identity_key,public.subscription_stock_wait_deficits(op.cycle_snapshot,op.id,p_now),p_now,p_now
 FROM public.subscriptions s WHERE s.id=op.subscription_id
 ON CONFLICT(subscription_id,scheduled_at) DO UPDATE SET last_checked_at=p_now RETURNING * INTO c;
 PERFORM public.subscription_stock_wait_enqueue(c,'started');
 RETURN result||jsonb_build_object('waiting',true,'caseId',c.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_stock_wait_recover_refusal(p_operation_id uuid,p_fingerprint text,p_worker text,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE s public.subscriptions; op public.subscription_renewal_operations; c public.subscription_stock_wait_cases;
 r public.fulfillment_inventory_reservations; deficits jsonb; token uuid:=gen_random_uuid();
BEGIN
DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END;
 SELECT * INTO s FROM public.subscriptions WHERE id=(SELECT subscription_id FROM public.subscription_renewal_operations WHERE id=p_operation_id) FOR UPDATE;
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=p_operation_id FOR UPDATE;
 SELECT * INTO c FROM public.subscription_stock_wait_cases WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 SELECT * INTO r FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=p_operation_id FOR UPDATE;
 IF op.id IS NOT NULL AND op.subscription_id IS DISTINCT FROM s.id THEN
  RAISE EXCEPTION 'renewal_write_scope_changed' USING ERRCODE='55P03'; END IF;
 IF op.id IS NULL OR op.operation_fingerprint IS DISTINCT FROM p_fingerprint OR btrim(COALESCE(p_worker,''))='' OR
  (c.id IS NOT NULL AND (c.fingerprint<>op.operation_fingerprint OR c.cycle_snapshot<>op.cycle_snapshot OR c.identity_key<>op.identity_key OR c.state='closed')) THEN
  RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
 IF s.status='active' AND s.next_cycle_at=op.scheduled_at
  AND c.state='stock_secured' AND op.state='reserved' AND r.status='held' AND r.expires_at>p_now AND op.lease_expires_at>p_now THEN
  RETURN public.subscription_renewal_operation_response(op,false,true,'stock_secured'); END IF;
 PERFORM public.subscriptions__check_legacy_renewal_write(op.subscription_id);
 IF s.status<>'active' OR s.next_cycle_at IS DISTINCT FROM op.scheduled_at THEN
  RAISE EXCEPTION 'stock_wait_binding_changed' USING ERRCODE='22023'; END IF;
 IF NOT COALESCE(((op.state='refused' AND op.terminal_reason IN ('inventory_unavailable','reservation_expired')) OR
  (op.state='reserved' AND c.state='stock_secured' AND r.status='held')),false) OR op.lease_expires_at>p_now OR
  op.attempt_prepared_at IS NOT NULL OR op.external_attempt_ref IS NOT NULL OR op.external_attempt_acknowledged_at IS NOT NULL OR
  EXISTS(SELECT 1 FROM public.subscription_cycles WHERE renewal_operation_id=op.id) OR
  EXISTS(SELECT 1 FROM public.commerce_orders WHERE renewal_operation_id=op.id) OR
  EXISTS(SELECT 1 FROM public.commerce_settlement_intents WHERE renewal_operation_id=op.id) OR
  EXISTS(SELECT 1 FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=op.id AND
   (outcome<>'refused' OR reason IS NULL OR reason NOT IN ('inventory_unavailable','reservation_expired') OR external_ref IS NOT NULL
    OR operation_fingerprint<>op.operation_fingerprint OR event_key NOT IN (op.identity_key||':inventory',op.identity_key||':reservation-expired'))) OR
  (r.id IS NOT NULL AND (r.operation_fingerprint<>p_fingerprint OR r.source_key IS DISTINCT FROM op.cycle_snapshot->>'stockSourceKey' OR (r.status NOT IN ('expired','released') AND NOT (r.status='held' AND c.state='stock_secured')))) THEN
  RAISE EXCEPTION 'stock_wait_recovery_provider_owned_or_not_eligible' USING ERRCODE='22023'; END IF;
 deficits:=public.subscription_stock_wait_deficits(op.cycle_snapshot,op.id,p_now);
 INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits,opened_at,last_checked_at)
 VALUES(s.id,s.client_id,op.id,op.scheduled_at,op.cycle_number,'waiting',to_jsonb(op),op.cycle_snapshot,op.operation_fingerprint,op.identity_key,deficits,p_now,p_now)
 ON CONFLICT(subscription_id,scheduled_at) DO UPDATE SET deficits=EXCLUDED.deficits,last_checked_at=p_now RETURNING * INTO c;
 IF jsonb_array_length(deficits)>0 THEN
  UPDATE public.subscription_stock_wait_cases SET state='waiting',block_reason='inventory_unavailable' WHERE id=c.id RETURNING * INTO c;
  PERFORM public.subscription_stock_wait_enqueue(c,'started');
  RETURN jsonb_build_object('waiting',true,'caseId',c.id,'deficits',deficits);
 END IF;
 -- All effects inside this block roll back on a stock shortage. The wait row
 -- remains outside it; prior commitments are never released to try another SKU.
 BEGIN
  -- The base stock rail uses one local refusal key per schedule/reason. Archive
  -- those exact non-payment receipts before clearing them for this bounded
  -- reset, so a later expiry can reuse the original key without a unique-key
  -- failure. Provider/money outcomes are rejected above and never removed.
  UPDATE public.subscription_stock_wait_cases SET refusal_observations=refusal_observations||
   COALESCE((SELECT jsonb_agg(to_jsonb(observation) ORDER BY occurred_at,id) FROM public.subscription_renewal_outcomes observation WHERE renewal_operation_id=op.id),'[]'::jsonb)
   WHERE id=c.id;
  DELETE FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=op.id;
  UPDATE public.subscription_renewal_operations SET state='claimed',terminal_outcome=NULL,terminal_reason=NULL,terminal_at=NULL,
   claim_token=token,claim_generation=claim_generation+1,claimed_by=p_worker,claimed_at=p_now,lease_expires_at=p_now+interval '5 minutes',updated_at=p_now WHERE id=op.id;
  IF r.id IS NULL THEN
   IF NOT (public.fulfillment_reserve_subscription_renewal(op.id,token,900,p_now)->>'reserved')::boolean THEN
    RAISE EXCEPTION 'stock_wait_atomic_shortage' USING ERRCODE='23514'; END IF;
  ELSE
   -- Restore exactly the expired reservation's original frozen lines.
   IF (SELECT jsonb_agg(jsonb_build_object('sku',sku,'quantity',quantity) ORDER BY sku) FROM public.fulfillment_inventory_reservation_lines WHERE reservation_id=r.id)
    IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('sku',l->>'sku','quantity',(l->>'quantity')::integer) ORDER BY l->>'sku') FROM jsonb_array_elements(op.cycle_snapshot->'lines') l) THEN
    RAISE EXCEPTION 'stock_wait_reservation_snapshot_mismatch'; END IF;
   UPDATE public.fulfillment_inventory_reservations SET status='held',expires_at=p_now+interval '15 minutes',terminal_reason=NULL,updated_at=p_now WHERE id=r.id;
   UPDATE public.subscription_renewal_operations SET state='reserved' WHERE id=op.id;
  END IF;
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM<>'stock_wait_atomic_shortage' THEN RAISE; END IF;
  UPDATE public.subscription_stock_wait_cases SET block_reason='inventory_unavailable',state='waiting' WHERE id=c.id;
  RETURN jsonb_build_object('waiting',true,'caseId',c.id);
 END;
 UPDATE public.subscription_stock_wait_cases SET state='stock_secured',deficits='[]',block_reason=NULL,
  stock_secured_at=COALESCE(stock_secured_at,p_now),last_checked_at=p_now WHERE id=c.id;
 SELECT * INTO op FROM public.subscription_renewal_operations WHERE id=op.id;
 RETURN public.subscription_renewal_operation_response(op,true,false,'stock_secured')||jsonb_build_object('waiting',false,'caseId',c.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.fulfillment_expire_subscription_renewals(
  p_now timestamptz DEFAULT now(),
  p_limit integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_row record; v_count integer := 0;
BEGIN
DECLARE prior_ms integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'inventory_admission_isolation_unsupported' USING ERRCODE='22023';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(846832106,1) THEN
    RAISE EXCEPTION 'inventory_admission_busy' USING ERRCODE='55P03';
  END IF;
  SELECT setting::integer INTO prior_ms FROM pg_catalog.pg_settings WHERE name='lock_timeout';
  PERFORM pg_catalog.set_config('lock_timeout',CASE WHEN prior_ms=0 THEN '50' ELSE least(prior_ms,50)::text END,true);
END;
  FOR v_row IN
    SELECT reservation.id, reservation.renewal_operation_id
      FROM public.fulfillment_inventory_reservations reservation
      JOIN public.subscription_renewal_operations operation
        ON operation.id = reservation.renewal_operation_id
     WHERE reservation.status = 'held'
       AND reservation.expires_at <= COALESCE(p_now, now())
       AND operation.state = 'reserved'
       AND public.subscriptions__eligible_legacy_renewal_write(operation.subscription_id)
     ORDER BY reservation.expires_at, reservation.id
     FOR UPDATE OF reservation, operation SKIP LOCKED
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000)
  LOOP
    UPDATE public.fulfillment_inventory_reservations
       SET status = 'expired', expires_at = NULL, terminal_reason = 'reservation_expired',
           updated_at = COALESCE(p_now, now())
     WHERE id = v_row.id;
    UPDATE public.subscription_renewal_operations
       SET state = 'refused', terminal_outcome = 'refused',
           terminal_reason = 'reservation_expired', terminal_at = COALESCE(p_now, now()),
           updated_at = COALESCE(p_now, now())
     WHERE id = v_row.renewal_operation_id;
    INSERT INTO public.subscription_renewal_outcomes (
      renewal_operation_id, operation_fingerprint, event_key, outcome, reason, occurred_at
    ) SELECT operation.id, operation.operation_fingerprint,
             operation.identity_key || ':reservation-expired', 'refused',
             'reservation_expired', COALESCE(p_now, now())
        FROM public.subscription_renewal_operations operation
       WHERE operation.id = v_row.renewal_operation_id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_stock_wait_candidates(p_limit integer DEFAULT 50,p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE result jsonb; row record;
BEGIN
 result:='[]';
 FOR row IN SELECT op.id,op.subscription_id,op.scheduled_at,c.id case_id FROM public.subscription_renewal_operations op
  JOIN public.subscriptions s ON s.id=op.subscription_id LEFT JOIN public.subscription_stock_wait_cases c ON c.renewal_operation_id=op.id
  WHERE s.status='active' AND s.next_cycle_at=op.scheduled_at AND op.lease_expires_at<=p_now
   AND ((op.state='refused' AND op.terminal_reason IN ('inventory_unavailable','reservation_expired')) OR (op.state='reserved' AND c.state='stock_secured'))
   AND (c.id IS NULL OR c.state IN ('waiting','stock_secured'))
   AND public.subscriptions__eligible_legacy_renewal_write(op.subscription_id)
   AND public.subscription_stock_wait_frozen(op.subscription_id,op.scheduled_at) IS NOT NULL
  ORDER BY CASE WHEN c.id IS NULL THEN op.updated_at ELSE c.last_selected_at END NULLS FIRST,op.scheduled_at,op.id LIMIT LEAST(GREATEST(p_limit,1),500)
 LOOP
  IF public.subscription_stock_wait_frozen(row.subscription_id,row.scheduled_at) IS NOT NULL THEN
   IF row.case_id IS NOT NULL THEN
    UPDATE public.subscription_stock_wait_cases SET last_selected_at=p_now WHERE id=row.case_id;
   ELSE
    PERFORM 1 FROM public.subscription_renewal_operations WHERE id=row.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    UPDATE public.subscription_renewal_operations SET updated_at=p_now WHERE id=row.id;
   END IF;
   result:=result||jsonb_build_array(public.subscription_stock_wait_frozen(row.subscription_id,row.scheduled_at));
  END IF;
 END LOOP;
 -- Superseded/cancelled unpaid waits close; provider-owned/paid cases never do.
 UPDATE public.subscription_stock_wait_cases c SET state='closed',closed_at=p_now,block_reason='schedule_superseded'
 FROM public.subscriptions s,public.subscription_renewal_operations op WHERE s.id=c.subscription_id AND op.id=c.renewal_operation_id
  AND c.state IN ('waiting','stock_secured') AND (s.status='cancelled' OR s.next_cycle_at IS DISTINCT FROM c.scheduled_at)
  AND public.subscriptions__eligible_legacy_renewal_write(op.subscription_id)
  AND op.attempt_prepared_at IS NULL AND op.external_attempt_ref IS NULL
  AND NOT EXISTS(SELECT 1 FROM public.subscription_cycles WHERE renewal_operation_id=op.id);
 RETURN result;
END;
$$;
