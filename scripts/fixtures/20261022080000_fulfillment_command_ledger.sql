-- Native command ledger: contributed provider-command fences and proofs.
-- Invoker execution by the deployment owner; no new principal, provider client,
-- payload backfill or browser permission. G14 attempts persist sanitized evidence.
CREATE TABLE public.fulfillment_provider_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_key text NOT NULL UNIQUE CHECK (btrim(attempt_key) <> ''),
  shipment_id uuid NOT NULL REFERENCES public.fulfillment_shipments(id),
  provider_kind text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('shadow','stage','live')),
  evidence jsonb NOT NULL,
  status text NOT NULL CHECK (status = 'recorded'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.commerce_fulfillment_provider_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES public.fulfillment_shipments(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id) ON DELETE CASCADE,
  provider_kind text NOT NULL
    CHECK (provider_kind ~ '^[a-z][a-z0-9_-]{0,63}$'),
  command_kind text NOT NULL CHECK (command_kind = 'dispatch_create'),
  contract_version text NOT NULL CHECK (contract_version = '1'),
  idempotency_key_fingerprint text NOT NULL CHECK (idempotency_key_fingerprint ~ '^[a-f0-9]{64}$'),
  command_key_fingerprint text NOT NULL CHECK (command_key_fingerprint ~ '^[a-f0-9]{64}$'),
  command_payload_fingerprint text NOT NULL CHECK (command_payload_fingerprint ~ '^[a-f0-9]{64}$'),
  provider_idempotency_key_fingerprint text CHECK (provider_idempotency_key_fingerprint ~ '^[a-f0-9]{64}$'),
  routing_fingerprint text NOT NULL CHECK (routing_fingerprint ~ '^[a-f0-9]{64}$'),
  config_fingerprint text NOT NULL CHECK (config_fingerprint ~ '^[a-f0-9]{64}$'),
  correlation_fingerprint text NOT NULL CHECK (correlation_fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'claimed', 'submitting', 'accepted', 'confirmed', 'retry_wait',
    'uncertain', 'manual_review', 'terminal_rejected', 'cancelled'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_budget integer NOT NULL DEFAULT 0 CHECK (retry_budget BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claim_owner_fingerprint text CHECK (claim_owner_fingerprint ~ '^[a-f0-9]{64}$'),
  claim_expires_at timestamptz,
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  last_provider_attempt_id uuid REFERENCES public.fulfillment_provider_attempts(id) ON DELETE SET NULL,
  provider_reference_fingerprint text CHECK (provider_reference_fingerprint ~ '^[a-f0-9]{64}$'),
  last_reason_code text NOT NULL DEFAULT 'command_enqueued' CHECK (last_reason_code IN (
    'command_enqueued', 'claimed', 'submission_started', 'provider_accepted',
    'safe_rejection', 'terminal_rejection', 'write_uncertain', 'lease_expired',
    'provider_effect_present', 'authoritative_absence', 'effect_unknown',
    'identity_mismatch', 'invalid_contract', 'unsafe_retry', 'operator_cancelled', 'superseded_by_direct_dispatch'
  )),
  accepted_at timestamptz,
  confirmed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key_fingerprint),
  UNIQUE (shipment_id, provider_kind, command_kind),
  UNIQUE (provider_kind, command_kind, command_key_fingerprint)
);

CREATE INDEX idx_fulfillment_provider_commands_claim
  ON public.commerce_fulfillment_provider_commands (provider_kind, command_kind, available_at, created_at)
  WHERE status IN ('queued', 'retry_wait');
CREATE INDEX idx_fulfillment_provider_commands_expiry
  ON public.commerce_fulfillment_provider_commands (claim_expires_at)
  WHERE status IN ('claimed', 'submitting');

CREATE TABLE public.commerce_fulfillment_provider_command_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id uuid NOT NULL REFERENCES public.commerce_fulfillment_provider_commands(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL CHECK (to_status IN (
    'queued', 'claimed', 'submitting', 'accepted', 'confirmed', 'retry_wait',
    'uncertain', 'manual_review', 'terminal_rejected', 'cancelled'
  )),
  reason_code text NOT NULL CHECK (reason_code IN (
    'command_enqueued', 'claimed', 'submission_started', 'provider_accepted',
    'safe_rejection', 'terminal_rejection', 'write_uncertain', 'lease_expired',
    'provider_effect_present', 'authoritative_absence', 'effect_unknown',
    'identity_mismatch', 'invalid_contract', 'unsafe_retry', 'operator_cancelled', 'superseded_by_direct_dispatch'
  )),
  command_version bigint NOT NULL CHECK (command_version > 0),
  attempt_count integer NOT NULL CHECK (attempt_count >= 0),
  claim_token uuid,
  claim_generation bigint,
  provider_attempt_id uuid REFERENCES public.fulfillment_provider_attempts(id) ON DELETE SET NULL,
  proof_kind text CHECK (proof_kind IN ('provider_reference', 'correlation_key', 'provider_idempotency_key', 'authoritative_absence', 'definitive_provider_rejection')),
  proof_fingerprint text CHECK (proof_fingerprint ~ '^[a-f0-9]{64}$'),
  proof_observed_at timestamptz,
  proof_source text CHECK (proof_source IN ('provider_lookup', 'provider_webhook', 'operator_verified', 'provider_response', 'legacy_backfill')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((proof_kind IS NULL AND proof_fingerprint IS NULL AND proof_observed_at IS NULL AND proof_source IS NULL)
    OR (proof_kind IS NOT NULL AND proof_fingerprint IS NOT NULL AND proof_observed_at IS NOT NULL AND proof_source IS NOT NULL)),
  UNIQUE (command_id, command_version)
);
CREATE INDEX idx_fulfillment_provider_command_transitions_command
  ON public.commerce_fulfillment_provider_command_transitions (command_id, command_version DESC);

REVOKE ALL ON TABLE public.commerce_fulfillment_provider_commands FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.commerce_fulfillment_provider_command_transitions FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.commerce_fulfillment_provider_command_transition_allowed(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT (p_from = 'queued' AND p_to IN ('claimed', 'cancelled'))
      OR (p_from = 'claimed' AND p_to IN ('queued', 'retry_wait', 'cancelled', 'submitting'))
      OR (p_from = 'submitting' AND p_to IN ('accepted', 'retry_wait', 'uncertain', 'manual_review', 'terminal_rejected'))
      OR (p_from = 'accepted' AND p_to IN ('confirmed', 'uncertain'))
      OR (p_from = 'retry_wait' AND p_to IN ('claimed', 'cancelled'))
      OR (p_from = 'uncertain' AND p_to IN ('accepted', 'confirmed', 'retry_wait', 'manual_review'))
      OR (p_from = 'manual_review' AND p_to IN ('confirmed', 'retry_wait', 'terminal_rejected', 'cancelled'));
$$;

CREATE FUNCTION public.commerce_fulfillment_provider_command_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.shipment_id IS DISTINCT FROM OLD.shipment_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.provider_kind IS DISTINCT FROM OLD.provider_kind
    OR NEW.command_kind IS DISTINCT FROM OLD.command_kind
    OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
    OR NEW.idempotency_key_fingerprint IS DISTINCT FROM OLD.idempotency_key_fingerprint
    OR NEW.command_key_fingerprint IS DISTINCT FROM OLD.command_key_fingerprint
    OR NEW.command_payload_fingerprint IS DISTINCT FROM OLD.command_payload_fingerprint
    OR NEW.provider_idempotency_key_fingerprint IS DISTINCT FROM OLD.provider_idempotency_key_fingerprint
    OR NEW.routing_fingerprint IS DISTINCT FROM OLD.routing_fingerprint
    OR NEW.config_fingerprint IS DISTINCT FROM OLD.config_fingerprint
    OR NEW.correlation_fingerprint IS DISTINCT FROM OLD.correlation_fingerprint
    OR NEW.retry_budget IS DISTINCT FROM OLD.retry_budget
  THEN RAISE EXCEPTION 'fulfillment_provider_command_identity_immutable' USING ERRCODE = '22023'; END IF;
  IF NEW.attempt_count < OLD.attempt_count OR NEW.claim_generation < OLD.claim_generation THEN
    RAISE EXCEPTION 'fulfillment_provider_command_counter_not_monotonic' USING ERRCODE = '22023';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'fulfillment_provider_command_version_invalid' USING ERRCODE = '22023'; END IF;
  IF NEW.status = OLD.status THEN RAISE EXCEPTION 'fulfillment_provider_command_transition_required' USING ERRCODE = '22023'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT public.commerce_fulfillment_provider_command_transition_allowed(OLD.status, NEW.status)
  THEN RAISE EXCEPTION 'fulfillment_provider_command_transition_invalid' USING ERRCODE = '22023'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER commerce_fulfillment_provider_command_guard
  BEFORE UPDATE ON public.commerce_fulfillment_provider_commands
  FOR EACH ROW EXECUTE FUNCTION public.commerce_fulfillment_provider_command_guard();

CREATE FUNCTION public.commerce_fulfillment_provider_command_result(p_command public.commerce_fulfillment_provider_commands)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
 SELECT jsonb_build_object('commandId', p_command.id, 'status', p_command.status, 'version', p_command.version, 'applied', true);
$$;

CREATE FUNCTION public.commerce_fulfillment_enqueue_provider_command(
  p_shipment_id uuid, p_provider_kind text, p_command_kind text,
  p_contract_version text, p_idempotency_key text,
  p_command_key_fingerprint text, p_command_payload_fingerprint text,
  p_provider_idempotency_key_fingerprint text, p_routing_fingerprint text,
  p_config_fingerprint text, p_correlation_fingerprint text, p_retry_budget integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE; v_order_id uuid; v_idempotency_key_fingerprint text;
BEGIN
  IF p_shipment_id IS NULL OR p_provider_kind !~ '^[a-z][a-z0-9_-]{0,63}$'
    OR p_command_kind <> 'dispatch_create' OR p_contract_version <> '1'
    OR p_idempotency_key !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    OR p_command_key_fingerprint !~ '^[a-f0-9]{64}$'
    OR p_command_payload_fingerprint !~ '^[a-f0-9]{64}$'
    OR p_routing_fingerprint !~ '^[a-f0-9]{64}$' OR p_config_fingerprint !~ '^[a-f0-9]{64}$'
    OR p_correlation_fingerprint IS NULL OR p_correlation_fingerprint !~ '^[a-f0-9]{64}$'
    OR (p_provider_idempotency_key_fingerprint IS NOT NULL AND p_provider_idempotency_key_fingerprint !~ '^[a-f0-9]{64}$')
    OR p_retry_budget NOT BETWEEN 0 AND 20
  THEN RAISE EXCEPTION 'fulfillment_provider_command_enqueue_invalid_input' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|' || p_shipment_id::text,0));
  PERFORM id FROM public.fulfillment_shipments WHERE id = p_shipment_id FOR UPDATE;
  v_idempotency_key_fingerprint := encode(sha256(convert_to('provider-command-idempotency|' || p_idempotency_key, 'UTF8')), 'hex');
  SELECT * INTO v_command FROM public.commerce_fulfillment_provider_commands WHERE idempotency_key_fingerprint = v_idempotency_key_fingerprint FOR UPDATE;
  IF FOUND THEN
    IF v_command.shipment_id <> p_shipment_id OR v_command.provider_kind <> p_provider_kind
      OR v_command.command_kind <> p_command_kind OR v_command.command_key_fingerprint <> p_command_key_fingerprint
      OR v_command.command_payload_fingerprint <> p_command_payload_fingerprint OR v_command.routing_fingerprint <> p_routing_fingerprint
      OR v_command.config_fingerprint <> p_config_fingerprint OR v_command.correlation_fingerprint <> p_correlation_fingerprint
      OR v_command.provider_idempotency_key_fingerprint IS DISTINCT FROM p_provider_idempotency_key_fingerprint
    THEN RAISE EXCEPTION 'fulfillment_provider_command_enqueue_identity_conflict' USING ERRCODE = '23505'; END IF;
    RETURN public.commerce_fulfillment_provider_command_result(v_command);
  END IF;
  SELECT order_id INTO v_order_id FROM public.fulfillment_shipments WHERE id = p_shipment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_provider_command_fulfillment_not_found' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=p_shipment_id AND (external_ref IS NOT NULL OR status IN ('submitting','uncertain','created'))) THEN RAISE EXCEPTION 'fulfillment_command_direct_effect_exists' USING ERRCODE='22023'; END IF;
  INSERT INTO public.commerce_fulfillment_provider_commands (
    shipment_id, order_id, provider_kind, command_kind, contract_version,
    idempotency_key_fingerprint, command_key_fingerprint, command_payload_fingerprint,
    provider_idempotency_key_fingerprint, routing_fingerprint, config_fingerprint,
    correlation_fingerprint, retry_budget
  ) VALUES (p_shipment_id, v_order_id, p_provider_kind, p_command_kind, p_contract_version,
    v_idempotency_key_fingerprint, p_command_key_fingerprint, p_command_payload_fingerprint,
    p_provider_idempotency_key_fingerprint, p_routing_fingerprint, p_config_fingerprint,
    p_correlation_fingerprint, p_retry_budget) RETURNING * INTO v_command;
  INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id, from_status, to_status, reason_code, command_version, attempt_count)
    VALUES (v_command.id, NULL, 'queued', 'command_enqueued', v_command.version, v_command.attempt_count);
  RETURN public.commerce_fulfillment_provider_command_result(v_command);
END;
$$;

CREATE FUNCTION public.commerce_fulfillment_claim_provider_commands(
  p_provider_kind text, p_command_kind text, p_limit integer, p_claim_owner text, p_lease_seconds integer
) RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE; v_token uuid; v_now timestamptz := now(); v_from text;
BEGIN
  IF p_provider_kind !~ '^[a-z][a-z0-9_-]{0,63}$' OR p_command_kind <> 'dispatch_create'
    OR p_claim_owner !~ '^[a-f0-9]{64}$' OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds NOT BETWEEN 10 AND 900
  THEN RAISE EXCEPTION 'fulfillment_provider_command_claim_invalid_input' USING ERRCODE = '22023'; END IF;
  FOR v_command IN SELECT * FROM public.commerce_fulfillment_provider_commands
    WHERE provider_kind = p_provider_kind AND command_kind = p_command_kind
      AND status IN ('queued', 'retry_wait') AND available_at <= v_now
      AND attempt_count < retry_budget
    ORDER BY available_at, created_at LIMIT p_limit
  LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('native-dispatch|' || v_command.shipment_id::text,0)) THEN CONTINUE; END IF;
    SELECT * INTO v_command FROM public.commerce_fulfillment_provider_commands
      WHERE id=v_command.id AND status IN ('queued','retry_wait') AND available_at<=v_now AND attempt_count<retry_budget
      FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=v_command.shipment_id AND (external_ref IS NOT NULL OR status IN ('submitting','uncertain','created'))) THEN CONTINUE; END IF;
    v_token := gen_random_uuid();
    v_from := v_command.status;
    UPDATE public.commerce_fulfillment_provider_commands SET status='claimed',
      claim_token=v_token, claim_owner_fingerprint=p_claim_owner,
      claim_expires_at=v_now + make_interval(secs => p_lease_seconds), claim_generation=claim_generation+1,
      last_reason_code='claimed', version=version+1, updated_at=v_now WHERE id=v_command.id RETURNING * INTO v_command;
    INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id, from_status, to_status, reason_code, command_version, attempt_count, claim_token, claim_generation)
      VALUES(v_command.id, v_from, 'claimed', 'claimed', v_command.version, v_command.attempt_count, v_command.claim_token, v_command.claim_generation);
    RETURN NEXT jsonb_build_object('commandId',v_command.id,'fulfillmentRef',v_command.shipment_id,'orderRef',v_command.order_id,
      'providerRef',v_command.provider_kind,'commandKind',v_command.command_kind,'contractVersion',v_command.contract_version,'status',v_command.status,'version',v_command.version,
      'commandKeyFingerprint',v_command.command_key_fingerprint,'commandPayloadFingerprint',v_command.command_payload_fingerprint,
      'providerIdempotencyKeyFingerprint',v_command.provider_idempotency_key_fingerprint,'routingFingerprint',v_command.routing_fingerprint,
      'configurationFingerprint',v_command.config_fingerprint,'correlationKeyFingerprint',v_command.correlation_fingerprint,
      'retryBudget',v_command.retry_budget,'retryCount',v_command.attempt_count,'claimToken',v_command.claim_token,
      'claimGeneration',v_command.claim_generation,'leaseExpiresAt',v_command.claim_expires_at);
  END LOOP;
END;
$$;

CREATE FUNCTION public.commerce_fulfillment_provider_command_fence(
  p_command_id uuid, p_claim_token uuid, p_claim_generation bigint, p_expected_version bigint
) RETURNS public.commerce_fulfillment_provider_commands LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE;
BEGIN
  SELECT * INTO v_command FROM public.commerce_fulfillment_provider_commands WHERE id=p_command_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_provider_command_not_found' USING ERRCODE='22023'; END IF;
  IF v_command.version <> p_expected_version OR v_command.claim_token IS DISTINCT FROM p_claim_token
    OR v_command.claim_generation <> p_claim_generation OR v_command.claim_expires_at <= now()
  THEN RAISE EXCEPTION 'fulfillment_provider_command_fence_conflict' USING ERRCODE='40001'; END IF;
  RETURN v_command;
END;
$$;

CREATE FUNCTION public.commerce_fulfillment_mark_command_submitting(
  p_command_id uuid,p_claim_token uuid,p_claim_generation bigint,p_expected_version bigint,p_provider_attempt_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE;
BEGIN
  v_command := public.commerce_fulfillment_provider_command_fence(p_command_id,p_claim_token,p_claim_generation,p_expected_version);
  IF v_command.status <> 'claimed' THEN RAISE EXCEPTION 'fulfillment_provider_command_not_claimed' USING ERRCODE='22023'; END IF;
  IF p_provider_attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fulfillment_provider_attempts a WHERE a.id=p_provider_attempt_id AND a.shipment_id=v_command.shipment_id AND a.provider_kind=v_command.provider_kind) THEN RAISE EXCEPTION 'fulfillment_provider_command_attempt_mismatch' USING ERRCODE='22023'; END IF;
  UPDATE public.commerce_fulfillment_provider_commands SET status='submitting',attempt_count=attempt_count+1,last_provider_attempt_id=p_provider_attempt_id,last_reason_code='submission_started',version=version+1,updated_at=now() WHERE id=p_command_id RETURNING * INTO v_command;
  INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id,from_status,to_status,reason_code,command_version,attempt_count,claim_token,claim_generation,provider_attempt_id) VALUES(v_command.id,'claimed','submitting','submission_started',v_command.version,v_command.attempt_count,p_claim_token,p_claim_generation,p_provider_attempt_id);
  RETURN public.commerce_fulfillment_provider_command_result(v_command);
END; $$;

CREATE FUNCTION public.commerce_fulfillment_apply_command_write_outcome(
  p_command_id uuid,p_claim_token uuid,p_claim_generation bigint,p_expected_version bigint,p_identity_fingerprint text,p_outcome_kind text,p_reason_code text,p_retry_not_before timestamptz DEFAULT NULL,p_provider_reference_fingerprint text DEFAULT NULL,p_provider_attempt_id uuid DEFAULT NULL,p_proof_kind text DEFAULT NULL,p_proof_fingerprint text DEFAULT NULL,p_proof_observed_at timestamptz DEFAULT NULL,p_proof_source text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE; v_to text;
BEGIN
  v_command := public.commerce_fulfillment_provider_command_fence(p_command_id,p_claim_token,p_claim_generation,p_expected_version);
  IF v_command.status <> 'submitting' THEN RAISE EXCEPTION 'fulfillment_provider_command_not_submitting' USING ERRCODE='22023'; END IF;
  IF p_provider_attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fulfillment_provider_attempts a WHERE a.id=p_provider_attempt_id AND a.shipment_id=v_command.shipment_id AND a.provider_kind=v_command.provider_kind) THEN RAISE EXCEPTION 'fulfillment_provider_command_attempt_mismatch' USING ERRCODE='22023'; END IF;
  IF p_identity_fingerprint !~ '^[a-f0-9]{64}$' OR (p_identity_fingerprint = v_command.command_key_fingerprint OR p_identity_fingerprint = v_command.correlation_fingerprint OR p_identity_fingerprint = v_command.provider_idempotency_key_fingerprint) IS NOT TRUE THEN RAISE EXCEPTION 'fulfillment_provider_command_outcome_identity_invalid' USING ERRCODE='22023'; END IF;
  IF p_outcome_kind='accepted' AND p_reason_code='provider_accepted' AND p_provider_reference_fingerprint ~ '^[a-f0-9]{64}$'
    AND p_proof_kind IS NULL AND p_proof_fingerprint IS NULL AND p_proof_observed_at IS NULL AND p_proof_source IS NULL THEN v_to:='accepted';
  ELSIF p_outcome_kind='uncertain' AND p_reason_code='write_uncertain'
    AND p_proof_kind IS NULL AND p_proof_fingerprint IS NULL AND p_proof_observed_at IS NULL AND p_proof_source IS NULL THEN v_to:='uncertain';
  ELSIF p_outcome_kind='rejected' AND p_reason_code IN ('terminal_rejection','safe_rejection')
    AND p_proof_kind='definitive_provider_rejection' AND p_proof_fingerprint ~ '^[a-f0-9]{64}$'
    AND p_proof_source='provider_response' AND p_proof_observed_at BETWEEN now()-interval '10 minutes' AND now()
  THEN
    IF p_reason_code='safe_rejection' AND v_command.attempt_count < v_command.retry_budget AND p_retry_not_before > now() THEN v_to:='retry_wait';
    ELSIF p_reason_code='safe_rejection' THEN v_to:='manual_review';
    ELSE v_to:='terminal_rejected'; END IF;
  ELSE RAISE EXCEPTION 'fulfillment_provider_command_outcome_invalid' USING ERRCODE='22023'; END IF;
  UPDATE public.commerce_fulfillment_provider_commands SET status=v_to,available_at=COALESCE(p_retry_not_before,available_at),provider_reference_fingerprint=CASE WHEN v_to='accepted' THEN p_provider_reference_fingerprint ELSE provider_reference_fingerprint END,last_provider_attempt_id=COALESCE(p_provider_attempt_id,last_provider_attempt_id),last_reason_code=p_reason_code,accepted_at=CASE WHEN v_to='accepted' THEN now() ELSE accepted_at END,finished_at=CASE WHEN v_to IN ('terminal_rejected','manual_review') THEN now() ELSE finished_at END,claim_token=CASE WHEN v_to='accepted' THEN claim_token ELSE NULL END,claim_owner_fingerprint=CASE WHEN v_to='accepted' THEN claim_owner_fingerprint ELSE NULL END,claim_expires_at=CASE WHEN v_to='accepted' THEN claim_expires_at ELSE NULL END,version=version+1,updated_at=now() WHERE id=p_command_id RETURNING * INTO v_command;
  INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id,from_status,to_status,reason_code,command_version,attempt_count,claim_token,claim_generation,provider_attempt_id,proof_kind,proof_fingerprint,proof_observed_at,proof_source) VALUES(v_command.id,'submitting',v_to,p_reason_code,v_command.version,v_command.attempt_count,p_claim_token,p_claim_generation,p_provider_attempt_id,p_proof_kind,p_proof_fingerprint,p_proof_observed_at,p_proof_source);
  RETURN public.commerce_fulfillment_provider_command_result(v_command);
END; $$;

CREATE FUNCTION public.commerce_fulfillment_confirm_provider_command(
  p_command_id uuid,p_claim_token uuid,p_claim_generation bigint,p_expected_version bigint,p_identity_fingerprint text,p_provider_attempt_id uuid DEFAULT NULL,p_proof_kind text DEFAULT NULL,p_proof_fingerprint text DEFAULT NULL,p_proof_observed_at timestamptz DEFAULT NULL,p_proof_source text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE;
BEGIN
  v_command := public.commerce_fulfillment_provider_command_fence(p_command_id,p_claim_token,p_claim_generation,p_expected_version);
  IF v_command.status <> 'accepted' OR v_command.provider_reference_fingerprint IS NULL THEN RAISE EXCEPTION 'fulfillment_provider_command_confirmation_invalid' USING ERRCODE='22023'; END IF;
  IF p_provider_attempt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fulfillment_provider_attempts a WHERE a.id=p_provider_attempt_id AND a.shipment_id=v_command.shipment_id AND a.provider_kind=v_command.provider_kind) THEN RAISE EXCEPTION 'fulfillment_provider_command_attempt_mismatch' USING ERRCODE='22023'; END IF;
  IF p_identity_fingerprint !~ '^[a-f0-9]{64}$' OR p_proof_kind NOT IN ('provider_reference','correlation_key','provider_idempotency_key') OR p_proof_fingerprint !~ '^[a-f0-9]{64}$' OR p_proof_source NOT IN ('provider_lookup','provider_webhook','operator_verified') OR p_proof_observed_at > now() OR p_proof_observed_at < now()-interval '24 hours'
    OR (p_identity_fingerprint = v_command.correlation_fingerprint OR p_identity_fingerprint = v_command.provider_idempotency_key_fingerprint) IS NOT TRUE
    OR (p_proof_kind='correlation_key' AND p_identity_fingerprint IS DISTINCT FROM v_command.correlation_fingerprint)
    OR (p_proof_kind='provider_idempotency_key' AND p_identity_fingerprint IS DISTINCT FROM v_command.provider_idempotency_key_fingerprint)
  THEN RAISE EXCEPTION 'fulfillment_provider_command_confirmation_proof_invalid' USING ERRCODE='22023'; END IF;
  UPDATE public.commerce_fulfillment_provider_commands SET status='confirmed',last_provider_attempt_id=COALESCE(p_provider_attempt_id,last_provider_attempt_id),confirmed_at=now(),finished_at=now(),last_reason_code='provider_effect_present',claim_token=NULL,claim_owner_fingerprint=NULL,claim_expires_at=NULL,version=version+1,updated_at=now() WHERE id=p_command_id RETURNING * INTO v_command;
  INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id,from_status,to_status,reason_code,command_version,attempt_count,claim_token,claim_generation,provider_attempt_id,proof_kind,proof_fingerprint,proof_observed_at,proof_source) VALUES(v_command.id,'accepted','confirmed','provider_effect_present',v_command.version,v_command.attempt_count,p_claim_token,p_claim_generation,p_provider_attempt_id,p_proof_kind,p_proof_fingerprint,p_proof_observed_at,p_proof_source);
  RETURN public.commerce_fulfillment_provider_command_result(v_command);
END; $$;

CREATE FUNCTION public.commerce_fulfillment_reconcile_provider_command(
  p_command_id uuid,p_expected_version bigint,p_identity_fingerprint text,p_proof_kind text,p_proof_fingerprint text,p_proof_observed_at timestamptz,p_proof_source text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE; v_from text;
BEGIN
  SELECT * INTO v_command FROM public.commerce_fulfillment_provider_commands WHERE id=p_command_id FOR UPDATE;
  IF NOT FOUND OR v_command.version<>p_expected_version THEN RAISE EXCEPTION 'fulfillment_provider_command_reconcile_conflict' USING ERRCODE='40001'; END IF;
  IF v_command.status NOT IN ('accepted','uncertain','manual_review') OR p_proof_kind NOT IN ('provider_reference','correlation_key','provider_idempotency_key') OR p_identity_fingerprint !~ '^[a-f0-9]{64}$' OR p_proof_fingerprint !~ '^[a-f0-9]{64}$' OR p_proof_source NOT IN ('provider_lookup','provider_webhook','operator_verified') OR p_proof_observed_at > now() OR p_proof_observed_at < now()-interval '24 hours'
    OR (p_identity_fingerprint = v_command.correlation_fingerprint OR p_identity_fingerprint = v_command.provider_idempotency_key_fingerprint) IS NOT TRUE
    OR (p_proof_kind='correlation_key' AND p_identity_fingerprint IS DISTINCT FROM v_command.correlation_fingerprint)
    OR (p_proof_kind='provider_idempotency_key' AND p_identity_fingerprint IS DISTINCT FROM v_command.provider_idempotency_key_fingerprint)
  THEN RAISE EXCEPTION 'fulfillment_provider_command_reconcile_proof_invalid' USING ERRCODE='22023'; END IF;
  v_from := v_command.status;
  UPDATE public.commerce_fulfillment_provider_commands SET status='confirmed',provider_reference_fingerprint=p_proof_fingerprint,confirmed_at=now(),finished_at=now(),last_reason_code='provider_effect_present',claim_token=NULL,claim_owner_fingerprint=NULL,claim_expires_at=NULL,version=version+1,updated_at=now() WHERE id=p_command_id RETURNING * INTO v_command;
  INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id,from_status,to_status,reason_code,command_version,attempt_count,proof_kind,proof_fingerprint,proof_observed_at,proof_source) VALUES(v_command.id,v_from,'confirmed','provider_effect_present',v_command.version,v_command.attempt_count,p_proof_kind,p_proof_fingerprint,p_proof_observed_at,p_proof_source);
  RETURN public.commerce_fulfillment_provider_command_result(v_command) || jsonb_build_object('proofRecorded',true);
END; $$;

CREATE FUNCTION public.commerce_fulfillment_resolve_uncertain_command(
  p_command_id uuid,p_expected_version bigint,p_identity_fingerprint text,p_decision text,p_reason_code text,p_proof_kind text,p_proof_fingerprint text,p_proof_observed_at timestamptz,p_proof_source text,p_retry_not_before timestamptz DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE; v_to text; v_from text;
BEGIN
  SELECT * INTO v_command FROM public.commerce_fulfillment_provider_commands WHERE id=p_command_id FOR UPDATE;
  IF NOT FOUND OR v_command.version<>p_expected_version OR v_command.status NOT IN ('uncertain','manual_review') THEN RAISE EXCEPTION 'fulfillment_provider_command_resolution_conflict' USING ERRCODE='40001'; END IF;
  IF p_identity_fingerprint !~ '^[a-f0-9]{64}$' OR p_proof_fingerprint !~ '^[a-f0-9]{64}$' OR p_proof_source NOT IN ('provider_lookup','provider_webhook','operator_verified') OR p_proof_observed_at > now() OR p_proof_observed_at < now()-interval '10 minutes'
    OR (p_identity_fingerprint = v_command.correlation_fingerprint OR p_identity_fingerprint = v_command.provider_idempotency_key_fingerprint) IS NOT TRUE
    OR (p_proof_kind='correlation_key' AND p_identity_fingerprint IS DISTINCT FROM v_command.correlation_fingerprint)
    OR (p_proof_kind='provider_idempotency_key' AND p_identity_fingerprint IS DISTINCT FROM v_command.provider_idempotency_key_fingerprint)
    OR (p_proof_kind='authoritative_absence' AND p_proof_fingerprint IS DISTINCT FROM p_identity_fingerprint)
  THEN RAISE EXCEPTION 'fulfillment_provider_command_resolution_proof_invalid' USING ERRCODE='22023'; END IF;
  IF p_decision='manual_review' AND p_reason_code IN ('effect_unknown','identity_mismatch','invalid_contract','unsafe_retry') AND p_proof_kind IN ('provider_reference','correlation_key','provider_idempotency_key') THEN v_to:='manual_review';
  ELSIF p_decision='retry_wait' AND p_reason_code='authoritative_absence' AND p_proof_kind='authoritative_absence' AND p_proof_source='provider_lookup' AND p_retry_not_before > now() THEN v_to:='retry_wait';
  ELSE RAISE EXCEPTION 'fulfillment_provider_command_resolution_unsafe' USING ERRCODE='22023'; END IF;
  v_from := v_command.status;
  UPDATE public.commerce_fulfillment_provider_commands SET status=v_to,available_at=COALESCE(p_retry_not_before,available_at),last_reason_code=p_reason_code,claim_token=NULL,claim_owner_fingerprint=NULL,claim_expires_at=NULL,version=version+1,updated_at=now() WHERE id=p_command_id RETURNING * INTO v_command;
  INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id,from_status,to_status,reason_code,command_version,attempt_count,proof_kind,proof_fingerprint,proof_observed_at,proof_source) VALUES(v_command.id,v_from,v_to,p_reason_code,v_command.version,v_command.attempt_count,p_proof_kind,p_proof_fingerprint,p_proof_observed_at,p_proof_source);
  RETURN public.commerce_fulfillment_provider_command_result(v_command) || jsonb_build_object('proofRecorded',true);
END; $$;

CREATE FUNCTION public.commerce_fulfillment_release_or_cancel_command(
  p_command_id uuid,p_claim_token uuid,p_claim_generation bigint,p_expected_version bigint,p_action text,p_reason_code text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE; v_to text;
BEGIN
  v_command := public.commerce_fulfillment_provider_command_fence(p_command_id,p_claim_token,p_claim_generation,p_expected_version);
  IF p_action='release' AND v_command.status='claimed' THEN v_to:='queued';
  ELSIF p_action='cancel' AND v_command.status='claimed' AND p_reason_code='operator_cancelled' THEN v_to:='cancelled';
  ELSE RAISE EXCEPTION 'fulfillment_provider_command_release_invalid' USING ERRCODE='22023'; END IF;
  UPDATE public.commerce_fulfillment_provider_commands SET status=v_to,last_reason_code=CASE WHEN v_to='cancelled' THEN 'operator_cancelled' ELSE 'command_enqueued' END,finished_at=CASE WHEN v_to='cancelled' THEN now() ELSE finished_at END,claim_token=NULL,claim_owner_fingerprint=NULL,claim_expires_at=NULL,version=version+1,updated_at=now() WHERE id=p_command_id RETURNING * INTO v_command;
  INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id,from_status,to_status,reason_code,command_version,attempt_count,claim_token,claim_generation) VALUES(v_command.id,'claimed',v_to,v_command.last_reason_code,v_command.version,v_command.attempt_count,p_claim_token,p_claim_generation);
  RETURN public.commerce_fulfillment_provider_command_result(v_command);
END; $$;

CREATE FUNCTION public.commerce_fulfillment_recover_expired_provider_commands(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_command public.commerce_fulfillment_provider_commands%ROWTYPE; v_results jsonb := '[]'::jsonb; v_from text;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'fulfillment_provider_command_recovery_invalid_limit' USING ERRCODE='22023'; END IF;
  FOR v_command IN SELECT * FROM public.commerce_fulfillment_provider_commands WHERE status IN ('claimed','submitting','accepted') AND claim_expires_at <= now() ORDER BY claim_expires_at FOR UPDATE SKIP LOCKED LIMIT p_limit LOOP
    v_from := v_command.status;
    UPDATE public.commerce_fulfillment_provider_commands SET status=CASE WHEN v_command.status IN ('submitting','accepted') THEN 'uncertain' ELSE 'queued' END,last_reason_code=CASE WHEN v_command.status IN ('submitting','accepted') THEN 'lease_expired' ELSE 'command_enqueued' END,claim_token=NULL,claim_owner_fingerprint=NULL,claim_expires_at=NULL,version=version+1,updated_at=now() WHERE id=v_command.id RETURNING * INTO v_command;
    INSERT INTO public.commerce_fulfillment_provider_command_transitions(command_id,from_status,to_status,reason_code,command_version,attempt_count) VALUES(v_command.id,v_from,v_command.status,v_command.last_reason_code,v_command.version,v_command.attempt_count);
    v_results := v_results || public.commerce_fulfillment_provider_command_result(v_command);
  END LOOP;
  RETURN v_results;
END; $$;


REVOKE ALL ON FUNCTION public.commerce_fulfillment_provider_command_transition_allowed(text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_fulfillment_provider_command_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_fulfillment_provider_command_result(public.commerce_fulfillment_provider_commands) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_fulfillment_enqueue_provider_command(uuid,text,text,text,text,text,text,text,text,text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_fulfillment_claim_provider_commands(text,text,integer,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_fulfillment_provider_command_fence(uuid,uuid,bigint,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_fulfillment_mark_command_submitting(uuid,uuid,bigint,bigint,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_fulfillment_apply_command_write_outcome(uuid,uuid,bigint,bigint,text,text,text,timestamptz,text,uuid,text,text,timestamptz,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_fulfillment_confirm_provider_command(uuid,uuid,bigint,bigint,text,uuid,text,text,timestamptz,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_fulfillment_reconcile_provider_command(uuid,bigint,text,text,text,timestamptz,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_fulfillment_resolve_uncertain_command(uuid,bigint,text,text,text,text,text,timestamptz,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_fulfillment_release_or_cancel_command(uuid,uuid,bigint,bigint,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commerce_fulfillment_recover_expired_provider_commands(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.fulfillment_provider_attempts FROM PUBLIC, anon, authenticated;

-- Host-owned contact revision/withholding is synchronized by the selected
-- preparation binding. It contains no recipient or provider payload.
CREATE TABLE public.fulfillment_dispatch_contexts (
  shipment_id uuid PRIMARY KEY REFERENCES public.fulfillment_shipments(id),
  contact_revision jsonb NOT NULL,
  provider_ref text NOT NULL CHECK (btrim(provider_ref) <> ''),
  withheld boolean NOT NULL DEFAULT false
);
CREATE TABLE public.fulfillment_dispatch_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key text NOT NULL UNIQUE CHECK (btrim(request_key) <> ''),
  shipment_id uuid NOT NULL UNIQUE REFERENCES public.fulfillment_shipments(id),
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
  parcel_ref text,
  external_ref text,
  mode text NOT NULL CHECK (mode IN ('shadow','stage','live')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitting','created','uncertain','failed','cancel_requested','cancelled')),
  evidence jsonb NOT NULL,
  remap_count integer NOT NULL DEFAULT 0 CHECK (remap_count BETWEEN 0 AND 1),
  acceptance jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.fulfillment_paid_handoffs (
  request_key text PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
  paid_fact_ref text NOT NULL,
  shipment_id uuid NOT NULL REFERENCES public.fulfillment_shipments(id),
  acknowledged_at timestamptz
);
CREATE TABLE public.fulfillment_observations (
  event_key text PRIMARY KEY,
  shipment_id uuid REFERENCES public.fulfillment_shipments(id),
  observation jsonb NOT NULL,
  first_received_at timestamptz NOT NULL,
  outcome jsonb,
  status_recorded boolean NOT NULL DEFAULT false
);
CREATE TABLE public.fulfillment_stock_movements (
  source_key text NOT NULL,
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  movement jsonb NOT NULL,
  PRIMARY KEY (source_key, request_key)
);

CREATE FUNCTION public.fulfillment_dispatch_read(p_ref public.fulfillment_dispatch_refs, p_replayed boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog AS $$
 SELECT jsonb_build_object('dispatchRef',p_ref.id,'requestKey',p_ref.request_key,
 'fulfillmentRef',p_ref.shipment_id,'orderRef',p_ref.order_id,'parcelRef',p_ref.parcel_ref,
 'externalRef',p_ref.external_ref,'mode',p_ref.mode,'status',p_ref.status,
 'evidence',p_ref.evidence,'replayed',p_replayed);
$$;
CREATE FUNCTION public.fulfillment_dispatch_claim(p_key text, p_shipment uuid, p_order uuid, p_parcel text, p_mode text, p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_ref public.fulfillment_dispatch_refs%ROWTYPE; v_context public.fulfillment_dispatch_contexts%ROWTYPE; v_replayed boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|' || p_shipment::text,0));
 PERFORM id FROM public.fulfillment_shipments WHERE id=p_shipment AND order_id=p_order FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_dispatch_identity_invalid' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_context FROM public.fulfillment_dispatch_contexts WHERE shipment_id=p_shipment FOR UPDATE;
 IF NOT FOUND OR v_context.withheld THEN RETURN jsonb_build_object('kind','refused','refusal',jsonb_build_object('reason','withheld','phase','claim','retryable',false)); END IF;
 IF v_context.provider_ref IS DISTINCT FROM p_evidence->>'providerRef' THEN RETURN jsonb_build_object('kind','refused','refusal',jsonb_build_object('reason','provider_mismatch','phase','claim','retryable',false)); END IF;
 IF v_context.contact_revision IS DISTINCT FROM p_evidence->'contactRevision' THEN
  RETURN jsonb_build_object('kind','refused','refusal',jsonb_build_object('reason','contact_stale','phase','claim','retryable',true));
 END IF;
 IF p_evidence->>'commandFingerprint' IS NULL OR p_evidence->>'commandFingerprint' !~ '^[a-f0-9]{64}$' OR btrim(COALESCE(p_evidence->>'providerRef',''))='' THEN
  RAISE EXCEPTION 'fulfillment_dispatch_evidence_invalid' USING ERRCODE='22023';
 END IF;
 SELECT * INTO v_ref FROM public.fulfillment_dispatch_refs WHERE request_key=p_key OR shipment_id=p_shipment FOR UPDATE;
 v_replayed := FOUND;
 IF FOUND THEN
  IF v_ref.request_key<>p_key OR v_ref.shipment_id<>p_shipment OR v_ref.order_id<>p_order OR v_ref.mode<>p_mode OR v_ref.parcel_ref IS DISTINCT FROM p_parcel THEN
   RAISE EXCEPTION 'fulfillment_dispatch_key_conflict' USING ERRCODE='23505';
  END IF;
  IF v_ref.evidence IS DISTINCT FROM p_evidence AND v_ref.status='draft' THEN
   IF v_ref.remap_count>=1 THEN RAISE EXCEPTION 'fulfillment_dispatch_remap_exhausted' USING ERRCODE='23505'; END IF;
   UPDATE public.fulfillment_dispatch_refs SET evidence=p_evidence,remap_count=remap_count+1,updated_at=now() WHERE id=v_ref.id RETURNING * INTO v_ref;
  END IF;
 ELSE
  INSERT INTO public.fulfillment_dispatch_refs(request_key,shipment_id,order_id,parcel_ref,mode,evidence)
  VALUES(p_key,p_shipment,p_order,p_parcel,p_mode,p_evidence) RETURNING * INTO v_ref;
 END IF;
 RETURN jsonb_build_object('kind','claimed','record',public.fulfillment_dispatch_read(v_ref,v_replayed));
END;
$$;
CREATE FUNCTION public.fulfillment_record_provider_attempt(p_key text,p_shipment uuid,p_evidence jsonb,p_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_attempt public.fulfillment_provider_attempts%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|' || p_shipment::text,0));
 PERFORM id FROM public.fulfillment_shipments WHERE id=p_shipment FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_attempt_shipment_missing' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_attempt FROM public.fulfillment_provider_attempts WHERE attempt_key=p_key;
 IF FOUND THEN
  IF v_attempt.shipment_id<>p_shipment OR v_attempt.evidence IS DISTINCT FROM p_evidence OR v_attempt.mode<>p_mode THEN RAISE EXCEPTION 'fulfillment_attempt_key_conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('replayed',true);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.fulfillment_dispatch_refs WHERE shipment_id=p_shipment AND evidence=p_evidence AND mode=p_mode) THEN
  RAISE EXCEPTION 'fulfillment_attempt_unclaimed_evidence' USING ERRCODE='22023';
 END IF;
 INSERT INTO public.fulfillment_provider_attempts(attempt_key,shipment_id,provider_kind,mode,evidence,status)
 VALUES(p_key,p_shipment,p_evidence->>'providerRef',p_mode,p_evidence,'recorded');
 RETURN jsonb_build_object('replayed',false);
END;
$$;
CREATE FUNCTION public.fulfillment_supersede_no_effect_commands(
  p_shipment_id uuid, p_provider_ref text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_command public.commerce_fulfillment_provider_commands%ROWTYPE;
  v_from_status text;
  v_blocked_count integer := 0;
  v_superseded_count integer := 0;
BEGIN
  IF p_shipment_id IS NULL THEN
    RAISE EXCEPTION 'fulfillment_dispatch_command_supersession_invalid_input'
      USING ERRCODE = '22023';
  END IF;

  -- Lock and preflight the whole logical command set before mutating any row.
  FOR v_command IN
    SELECT *
      FROM public.commerce_fulfillment_provider_commands AS command
     WHERE command.shipment_id = p_shipment_id
       AND command.provider_kind = p_provider_ref
       AND command.command_kind = 'dispatch_create'
     ORDER BY command.id
     FOR UPDATE
  LOOP
    IF (
        v_command.status = 'queued'
        AND v_command.attempt_count = 0
        AND v_command.claim_generation = 0
        AND v_command.last_reason_code = 'command_enqueued'
        AND 1 = (
          SELECT count(*)
            FROM public.commerce_fulfillment_provider_command_transitions AS transition
           WHERE transition.command_id = v_command.id
             AND transition.from_status IS NULL
             AND transition.to_status = 'queued'
             AND transition.reason_code = 'command_enqueued'
             AND transition.attempt_count = 0
             AND coalesce(transition.claim_generation, 0) = 0
        )
        AND 1 = (
          SELECT count(*)
            FROM public.commerce_fulfillment_provider_command_transitions AS transition
           WHERE transition.command_id = v_command.id
        )
      )
      OR (
        v_command.status = 'cancelled'
        AND v_command.last_reason_code = 'superseded_by_direct_dispatch'
      )
    THEN
      CONTINUE;
    END IF;
    v_blocked_count := v_blocked_count + 1;
  END LOOP;

  IF v_blocked_count > 0 THEN
    RETURN jsonb_build_object('supersededCount', 0, 'blockedCount', v_blocked_count);
  END IF;

  FOR v_command IN
    SELECT *
      FROM public.commerce_fulfillment_provider_commands AS command
     WHERE command.shipment_id = p_shipment_id
       AND command.provider_kind = p_provider_ref
       AND command.command_kind = 'dispatch_create'
       AND command.status = 'queued'
       AND command.attempt_count = 0
       AND command.claim_generation = 0
       AND command.last_reason_code = 'command_enqueued'
       AND 1 = (
         SELECT count(*)
           FROM public.commerce_fulfillment_provider_command_transitions AS transition
          WHERE transition.command_id = command.id
            AND transition.from_status IS NULL
            AND transition.to_status = 'queued'
            AND transition.reason_code = 'command_enqueued'
            AND transition.attempt_count = 0
            AND coalesce(transition.claim_generation, 0) = 0
       )
       AND 1 = (
         SELECT count(*)
           FROM public.commerce_fulfillment_provider_command_transitions AS transition
          WHERE transition.command_id = command.id
       )
     ORDER BY command.id
     FOR UPDATE
  LOOP
    v_from_status := v_command.status;
    UPDATE public.commerce_fulfillment_provider_commands
       SET status = 'cancelled',
           last_reason_code = 'superseded_by_direct_dispatch',
           finished_at = now(),
           claim_token = NULL,
           claim_owner_fingerprint = NULL,
           claim_expires_at = NULL,
           version = version + 1,
           updated_at = now()
     WHERE id = v_command.id
    RETURNING * INTO v_command;

    INSERT INTO public.commerce_fulfillment_provider_command_transitions (
      command_id, from_status, to_status, reason_code, command_version,
      attempt_count, claim_generation
    ) VALUES (
      v_command.id, v_from_status, 'cancelled',
      'superseded_by_direct_dispatch', v_command.version,
      v_command.attempt_count, v_command.claim_generation
    );
    v_superseded_count := v_superseded_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'supersededCount', v_superseded_count,
    'blockedCount', 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fulfillment_supersede_no_effect_commands(uuid,text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.fulfillment_dispatch_begin(p_id uuid,p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_ref public.fulfillment_dispatch_refs%ROWTYPE; v_revision jsonb;
BEGIN
 SELECT * INTO v_ref FROM public.fulfillment_dispatch_refs WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_dispatch_missing' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|' || v_ref.shipment_id::text,0));
 PERFORM id FROM public.fulfillment_shipments WHERE id=v_ref.shipment_id FOR UPDATE;
 SELECT * INTO v_ref FROM public.fulfillment_dispatch_refs WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_dispatch_missing' USING ERRCODE='22023'; END IF;
 SELECT contact_revision INTO v_revision FROM public.fulfillment_dispatch_contexts WHERE shipment_id=v_ref.shipment_id FOR UPDATE;
 IF v_ref.status='draft' AND v_revision IS DISTINCT FROM v_ref.evidence->'contactRevision' THEN
  RETURN jsonb_build_object('kind','refused','refusal',jsonb_build_object('reason','contact_stale','phase','begin','retryable',true));
 END IF;
 IF v_ref.evidence->>'commandFingerprint' IS DISTINCT FROM p_fingerprint THEN RAISE EXCEPTION 'fulfillment_dispatch_fingerprint_conflict' USING ERRCODE='23505'; END IF;
 IF v_ref.status<>'draft' THEN RETURN jsonb_build_object('kind','begun','record',public.fulfillment_dispatch_read(v_ref,true),'begun',false,'replayed',true); END IF;
 PERFORM id FROM public.commerce_orders WHERE id=v_ref.order_id FOR UPDATE;
 PERFORM id FROM public.fulfillment_shipments WHERE id=v_ref.shipment_id FOR UPDATE;
 IF EXISTS (SELECT 1 FROM public.fulfillment_dispatch_contexts WHERE shipment_id=v_ref.shipment_id AND (withheld OR provider_ref IS DISTINCT FROM v_ref.evidence->>'providerRef'))
 OR NOT EXISTS (SELECT 1 FROM public.commerce_orders WHERE id=v_ref.order_id AND status IN ('paid','fulfillment_pending'))
 OR NOT EXISTS (SELECT 1 FROM public.fulfillment_shipments shipment JOIN public.fulfillment_ports port USING(port_key) WHERE shipment.id=v_ref.shipment_id AND shipment.status IN ('created','label_pending') AND port.routable)
 OR EXISTS (SELECT 1 FROM public.commerce_order_holds WHERE order_id=v_ref.order_id AND status='active') THEN
  RETURN jsonb_build_object('kind','refused','refusal',jsonb_build_object('reason','not_dispatchable','phase','begin','retryable',false));
 END IF;
 IF (public.fulfillment_supersede_no_effect_commands(v_ref.shipment_id,v_ref.evidence->>'providerRef')->>'blockedCount')::integer>0 THEN
  RETURN jsonb_build_object('kind','refused','refusal',jsonb_build_object('reason','not_dispatchable','phase','begin','retryable',false));
 END IF;
 IF v_ref.mode='shadow' THEN RAISE EXCEPTION 'fulfillment_dispatch_shadow_submission' USING ERRCODE='22023'; END IF;
 UPDATE public.fulfillment_dispatch_refs SET status='submitting',updated_at=now() WHERE id=p_id RETURNING * INTO v_ref;
 RETURN jsonb_build_object('kind','begun','record',public.fulfillment_dispatch_read(v_ref),'begun',true,'replayed',false);
END;
$$;
CREATE FUNCTION public.fulfillment_dispatch_finish(p_id uuid,p_result jsonb,p_ack boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_ref public.fulfillment_dispatch_refs%ROWTYPE; v_replayed boolean := false;
BEGIN
 SELECT * INTO v_ref FROM public.fulfillment_dispatch_refs WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_dispatch_missing' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('native-dispatch|' || v_ref.shipment_id::text,0));
 PERFORM id FROM public.fulfillment_shipments WHERE id=v_ref.shipment_id FOR UPDATE;
 SELECT * INTO v_ref FROM public.fulfillment_dispatch_refs WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_dispatch_missing' USING ERRCODE='22023'; END IF;
 IF p_result->>'kind'='accepted' THEN
  IF v_ref.evidence IS DISTINCT FROM p_result->'evidence' OR btrim(COALESCE(p_result->>'externalRef',''))='' THEN RAISE EXCEPTION 'fulfillment_dispatch_acceptance_identity' USING ERRCODE='23505'; END IF;
  IF v_ref.external_ref IS NOT NULL AND v_ref.external_ref IS DISTINCT FROM p_result->>'externalRef' THEN RAISE EXCEPTION 'fulfillment_dispatch_acceptance_conflict' USING ERRCODE='23505'; END IF;
  IF v_ref.status='created' THEN
   IF v_ref.acceptance IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'fulfillment_dispatch_ack_key_conflict' USING ERRCODE='23505'; END IF;
   v_replayed := true;
  ELSIF v_ref.status IN ('submitting','uncertain') THEN
   UPDATE public.fulfillment_dispatch_refs SET external_ref=p_result->>'externalRef',status=CASE WHEN p_ack THEN 'created' ELSE 'uncertain' END,
    acceptance=p_result,updated_at=now() WHERE id=p_id RETURNING * INTO v_ref;
   IF p_ack THEN
    PERFORM public.fulfillment_supersede_no_effect_commands(v_ref.shipment_id,v_ref.evidence->>'providerRef');
    PERFORM public.fulfillment_record_provider_attempt(p_result->>'providerAttemptKey',v_ref.shipment_id,v_ref.evidence,v_ref.mode);
    IF btrim(COALESCE(p_result->>'labelKey',''))='' OR p_result->>'labelKey'=p_result->>'providerAttemptKey' THEN RAISE EXCEPTION 'fulfillment_dispatch_ack_keys_invalid' USING ERRCODE='22023'; END IF;
    -- A 3pl accepts an outbound command; it does not create a label owned by
    -- this kernel. Its native commitment is dispatch evidence, which also
    -- fences local cancellation. The host's label ACK key stays the receipt key.
    PERFORM public.fulfillment_record_evidence(p_result->>'labelKey',v_ref.shipment_id,'push','dispatch',p_result->>'externalRef','{}'::jsonb,now());
   END IF;
  ELSE RAISE EXCEPTION 'fulfillment_dispatch_not_submitted' USING ERRCODE='22023'; END IF;
 ELSE
  IF p_ack OR p_result->>'kind' NOT IN ('unknown','not_dispatched') THEN RAISE EXCEPTION 'fulfillment_dispatch_result_invalid' USING ERRCODE='22023'; END IF;
  IF v_ref.status='submitting' THEN
   UPDATE public.fulfillment_dispatch_refs SET status=CASE WHEN p_result->>'kind'='unknown' THEN 'uncertain' ELSE 'failed' END,updated_at=now() WHERE id=p_id RETURNING * INTO v_ref;
  END IF;
 END IF;
 IF p_ack THEN RETURN jsonb_build_object('acknowledged',true,'replayed',v_replayed,'record',public.fulfillment_dispatch_read(v_ref,v_replayed)); END IF;
 RETURN public.fulfillment_dispatch_read(v_ref,v_replayed);
END;
$$;
REVOKE ALL ON public.fulfillment_dispatch_contexts, public.fulfillment_dispatch_refs, public.fulfillment_paid_handoffs, public.fulfillment_observations, public.fulfillment_stock_movements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fulfillment_dispatch_read(public.fulfillment_dispatch_refs,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fulfillment_dispatch_claim(text,uuid,uuid,text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fulfillment_record_provider_attempt(text,uuid,jsonb,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fulfillment_dispatch_begin(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fulfillment_dispatch_finish(uuid,jsonb,boolean) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.fulfillment_ensure_paid_handoff(p_key text,p_order uuid,p_fact text,p_port text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_row public.fulfillment_paid_handoffs%ROWTYPE; v_shipment uuid; v_response jsonb;
BEGIN
 PERFORM id FROM public.commerce_orders WHERE id=p_order AND status IN ('paid','fulfillment_pending','fulfilled') FOR UPDATE;
 IF NOT FOUND OR btrim(COALESCE(p_fact,''))='' THEN RAISE EXCEPTION 'fulfillment_paid_obligation_requires_paid_order' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_row FROM public.fulfillment_paid_handoffs WHERE request_key=p_key;
 IF FOUND THEN
  IF v_row.order_id<>p_order OR v_row.paid_fact_ref<>p_fact THEN RAISE EXCEPTION 'fulfillment_paid_handoff_key_conflict' USING ERRCODE='23505'; END IF;
  RETURN jsonb_build_object('fulfillmentRef',v_row.shipment_id,'replayed',true);
 END IF;
 SELECT id INTO v_shipment FROM public.fulfillment_shipments WHERE order_id=p_order AND sequence_no=0;
 IF NOT FOUND THEN
  v_response := public.fulfillment_create_shipment(p_key,p_order,p_port,'{}'::jsonb,now());
  v_shipment := (v_response#>>'{shipment,id}')::uuid;
 END IF;
 INSERT INTO public.fulfillment_paid_handoffs(request_key,order_id,paid_fact_ref,shipment_id) VALUES(p_key,p_order,p_fact,v_shipment);
 RETURN jsonb_build_object('fulfillmentRef',v_shipment,'replayed',false);
END;
$$;
CREATE FUNCTION public.fulfillment_ack_paid_handoff(p_key text,p_shipment uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_row public.fulfillment_paid_handoffs%ROWTYPE; v_replayed boolean;
BEGIN
 SELECT * INTO v_row FROM public.fulfillment_paid_handoffs WHERE request_key=p_key FOR UPDATE;
 IF NOT FOUND OR v_row.shipment_id<>p_shipment THEN RAISE EXCEPTION 'fulfillment_paid_handoff_missing' USING ERRCODE='22023'; END IF;
 v_replayed := v_row.acknowledged_at IS NOT NULL;
 UPDATE public.fulfillment_paid_handoffs SET acknowledged_at=COALESCE(acknowledged_at,now()) WHERE request_key=p_key;
 RETURN jsonb_build_object('acknowledged',true,'replayed',v_replayed);
END;
$$;
REVOKE ALL ON FUNCTION public.fulfillment_ensure_paid_handoff(text,uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fulfillment_ack_paid_handoff(text,uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.fulfillment_record_stock_movement(p_source text,p_key text,p_fingerprint text,p_movement jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_row public.fulfillment_stock_movements%ROWTYPE; v_inserted boolean;
BEGIN
 INSERT INTO public.fulfillment_stock_movements(source_key,request_key,fingerprint,movement) VALUES(p_source,p_key,p_fingerprint,p_movement)
 ON CONFLICT DO NOTHING RETURNING * INTO v_row;
 v_inserted := FOUND;
 IF NOT FOUND THEN
  SELECT * INTO v_row FROM public.fulfillment_stock_movements WHERE source_key=p_source AND request_key=p_key;
  IF v_row.fingerprint IS DISTINCT FROM p_fingerprint THEN RAISE EXCEPTION 'fulfillment_movement_key_conflict' USING ERRCODE='23505'; END IF;
 END IF;
 RETURN jsonb_build_object('replayed',NOT v_inserted,'readBack',true);
END;
$$;
CREATE FUNCTION public.fulfillment_record_observation(p_event text,p_shipment uuid,p_observation jsonb,p_received timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_row public.fulfillment_observations%ROWTYPE; v_inserted boolean;
BEGIN
 INSERT INTO public.fulfillment_observations(event_key,shipment_id,observation,first_received_at) VALUES(p_event,p_shipment,p_observation,p_received)
 ON CONFLICT DO NOTHING RETURNING * INTO v_row;
 v_inserted := FOUND;
 IF NOT FOUND THEN
  SELECT * INTO v_row FROM public.fulfillment_observations WHERE event_key=p_event;
  IF v_row.shipment_id IS DISTINCT FROM p_shipment OR v_row.observation->'correlation' IS DISTINCT FROM p_observation->'correlation' THEN RAISE EXCEPTION 'fulfillment_observation_key_conflict' USING ERRCODE='23505'; END IF;
 END IF;
 RETURN jsonb_build_object('replayed',NOT v_inserted);
END;
$$;
CREATE FUNCTION public.fulfillment_mark_observation_processed(p_event text,p_outcome jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_row public.fulfillment_observations%ROWTYPE;
BEGIN
 SELECT * INTO v_row FROM public.fulfillment_observations WHERE event_key=p_event FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fulfillment_observation_missing' USING ERRCODE='22023'; END IF;
 IF v_row.outcome IS NOT NULL AND v_row.outcome IS DISTINCT FROM p_outcome THEN RAISE EXCEPTION 'fulfillment_observation_outcome_conflict' USING ERRCODE='23505'; END IF;
 UPDATE public.fulfillment_observations SET outcome=p_outcome WHERE event_key=p_event;
END;
$$;
REVOKE ALL ON FUNCTION public.fulfillment_record_stock_movement(text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fulfillment_record_observation(text,uuid,jsonb,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fulfillment_mark_observation_processed(text,jsonb) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.fulfillment_record_status_evidence(p_event text,p_shipment uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_row public.fulfillment_observations%ROWTYPE;
BEGIN
 SELECT * INTO v_row FROM public.fulfillment_observations WHERE event_key=p_event FOR UPDATE;
 IF NOT FOUND OR v_row.shipment_id IS DISTINCT FROM p_shipment THEN RAISE EXCEPTION 'fulfillment_status_evidence_correlation' USING ERRCODE='22023'; END IF;
 UPDATE public.fulfillment_observations SET status_recorded=true WHERE event_key=p_event;
 RETURN jsonb_build_object('replayed',v_row.status_recorded);
END;
$$;
REVOKE ALL ON FUNCTION public.fulfillment_record_status_evidence(text,uuid) FROM PUBLIC, anon, authenticated;
