-- Public provider-neutral communications control plane.
--
-- This forward adds only opaque operator, control, template and command
-- identifiers around the existing transactional-delivery receipt. It stores no
-- recipient address, message content, provider identifier or transport payload.
-- Every routine is invoker-rights with a fixed search path; browser principals
-- receive no table or function grant and the catalog contains no branded seed.

CREATE TABLE public.platform_communication_operators (
  principal_id uuid PRIMARY KEY,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_communication_operators_timestamp_check
    CHECK (updated_at >= created_at)
);

CREATE TABLE public.communication_delivery_controls (
  control_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communication_delivery_controls_key_check
    CHECK (control_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT communication_delivery_controls_revision_check CHECK (revision >= 1)
);

CREATE TABLE public.communication_delivery_templates (
  template_reference text PRIMARY KEY,
  control_key text NOT NULL REFERENCES public.communication_delivery_controls(control_key),
  active boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communication_delivery_templates_reference_check
    CHECK (template_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT communication_delivery_templates_revision_check CHECK (revision >= 1)
);

CREATE TABLE public.communication_delivery_preparations (
  idempotency_key text PRIMARY KEY,
  command_fingerprint text NOT NULL,
  template_reference text NOT NULL REFERENCES public.communication_delivery_templates(template_reference),
  control_key text NOT NULL REFERENCES public.communication_delivery_controls(control_key),
  recipient_fingerprint text NOT NULL,
  operator_id uuid NOT NULL REFERENCES public.platform_communication_operators(principal_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communication_delivery_preparations_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT communication_delivery_preparations_fingerprint_check
    CHECK (command_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT communication_delivery_preparations_recipient_fingerprint_check
    CHECK (recipient_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT communication_delivery_preparations_timestamp_check
    CHECK (updated_at >= created_at)
);

CREATE TABLE public.communication_delivery_commands (
  idempotency_key text PRIMARY KEY,
  command_fingerprint text NOT NULL,
  template_reference text NOT NULL REFERENCES public.communication_delivery_templates(template_reference),
  control_key text NOT NULL REFERENCES public.communication_delivery_controls(control_key),
  recipient_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communication_delivery_commands_receipt_fk
    FOREIGN KEY (idempotency_key)
    REFERENCES public.transactional_delivery_receipts(idempotency_key)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT communication_delivery_commands_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT communication_delivery_commands_fingerprint_check
    CHECK (command_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT communication_delivery_commands_recipient_fingerprint_check
    CHECK (recipient_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT communication_delivery_commands_timestamp_check
    CHECK (updated_at >= created_at)
);

CREATE TABLE public.communication_delivery_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL
    REFERENCES public.communication_delivery_commands(idempotency_key),
  transition text NOT NULL,
  attempt_count integer NOT NULL,
  operator_id uuid NOT NULL REFERENCES public.platform_communication_operators(principal_id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communication_delivery_events_transition_check
    CHECK (transition IN ('attempted', 'accepted', 'failed', 'replayed')),
  CONSTRAINT communication_delivery_events_attempt_check CHECK (attempt_count >= 1)
);

CREATE INDEX communication_delivery_commands_updated_idx
  ON public.communication_delivery_commands(updated_at DESC, idempotency_key);
CREATE INDEX communication_delivery_events_command_idx
  ON public.communication_delivery_events(idempotency_key, event_id);

CREATE FUNCTION public.communications_refuse_delivery_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE LOG 'communications_delivery_events_append_only_rejected';
  RAISE EXCEPTION 'communications_delivery_events_append_only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER communications_delivery_events_append_only
BEFORE UPDATE OR DELETE ON public.communication_delivery_events
FOR EACH ROW EXECUTE FUNCTION public.communications_refuse_delivery_event_mutation();

REVOKE ALL ON TABLE
  public.platform_communication_operators,
  public.communication_delivery_controls,
  public.communication_delivery_templates,
  public.communication_delivery_preparations,
  public.communication_delivery_commands,
  public.communication_delivery_events
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.communication_delivery_events_event_id_seq
FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.communications_operator_is_active(p_principal_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.platform_communication_operators AS operator_row
    WHERE operator_row.principal_id = p_principal_id
      AND operator_row.active IS TRUE
  );
$$;

CREATE FUNCTION public.communications_require_active_operator(p_operator_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_operator_id IS NULL OR NOT public.communications_operator_is_active(p_operator_id) THEN
    RAISE EXCEPTION 'communications_operator_inactive' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION public.communications_set_delivery_control(
  p_operator_id uuid,
  p_control_key text,
  p_enabled boolean
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_revision integer;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF p_control_key IS NULL
     OR p_control_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'communications_control_invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.communication_delivery_controls(control_key, enabled)
  VALUES (p_control_key, p_enabled)
  ON CONFLICT (control_key) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        revision = public.communication_delivery_controls.revision + 1,
        updated_at = now()
  RETURNING revision INTO v_revision;
  RETURN v_revision;
END;
$$;

CREATE FUNCTION public.communications_set_delivery_template(
  p_operator_id uuid,
  p_template_reference text,
  p_control_key text,
  p_active boolean
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_revision integer;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF p_template_reference IS NULL
     OR p_template_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR p_control_key IS NULL
     OR p_control_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR p_active IS NULL THEN
    RAISE EXCEPTION 'communications_template_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.communication_delivery_controls
    WHERE control_key = p_control_key
  ) THEN
    RAISE EXCEPTION 'communications_control_not_found' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.communication_delivery_templates(
    template_reference, control_key, active
  ) VALUES (p_template_reference, p_control_key, p_active)
  ON CONFLICT (template_reference) DO UPDATE
    SET control_key = EXCLUDED.control_key,
        active = EXCLUDED.active,
        revision = public.communication_delivery_templates.revision + 1,
        updated_at = now()
  RETURNING revision INTO v_revision;
  RETURN v_revision;
END;
$$;

CREATE FUNCTION public.communications_prepare_delivery_command(
  p_operator_id uuid,
  p_idempotency_key text,
  p_command_fingerprint text,
  p_template_reference text,
  p_recipient_fingerprint text
)
RETURNS TABLE(action text, attempt_count integer)
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_command public.communication_delivery_commands%ROWTYPE;
  v_preparation public.communication_delivery_preparations%ROWTYPE;
  v_receipt public.transactional_delivery_receipts%ROWTYPE;
  v_control_key text;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR p_command_fingerprint IS NULL
     OR p_command_fingerprint !~ '^[a-f0-9]{64}$'
     OR p_template_reference IS NULL
     OR p_template_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
     OR p_recipient_fingerprint IS NULL
     OR p_recipient_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'communications_command_invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key, 0));
  SELECT * INTO v_command
  FROM public.communication_delivery_commands
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_command.command_fingerprint <> p_command_fingerprint
       OR v_command.template_reference <> p_template_reference
       OR v_command.recipient_fingerprint <> p_recipient_fingerprint THEN
      RAISE EXCEPTION 'communications_command_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO STRICT v_receipt
    FROM public.transactional_delivery_receipts
    WHERE idempotency_key = p_idempotency_key
    FOR UPDATE;
    IF v_receipt.state = 'accepted' THEN
      INSERT INTO public.communication_delivery_events(
        idempotency_key, transition, attempt_count, operator_id
      ) VALUES (p_idempotency_key, 'replayed', v_receipt.attempt_count, p_operator_id);
      RETURN QUERY SELECT 'replayed'::text, v_receipt.attempt_count;
      RETURN;
    END IF;

    -- A durable accepted receipt always replays, even if policy changes later.
    -- A failed command is a new delivery attempt and must re-check current
    -- eligibility before invoking the captured delivery adapter again.
    IF NOT EXISTS (
      SELECT 1
      FROM public.communication_delivery_templates AS template_row
      JOIN public.communication_delivery_controls AS control_row
        ON control_row.control_key = template_row.control_key
      WHERE template_row.template_reference = v_command.template_reference
        AND template_row.active IS TRUE
        AND control_row.enabled IS TRUE
    ) THEN
      RAISE EXCEPTION 'communications_delivery_disabled' USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.communication_delivery_events(
      idempotency_key, transition, attempt_count, operator_id
    ) VALUES (p_idempotency_key, 'attempted', v_receipt.attempt_count + 1, p_operator_id);
    RETURN QUERY SELECT 'proceed'::text, v_receipt.attempt_count + 1;
    RETURN;
  END IF;

  SELECT * INTO v_preparation
  FROM public.communication_delivery_preparations
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_preparation.command_fingerprint <> p_command_fingerprint
       OR v_preparation.template_reference <> p_template_reference
       OR v_preparation.recipient_fingerprint <> p_recipient_fingerprint
       OR v_preparation.operator_id <> p_operator_id THEN
      RAISE EXCEPTION 'communications_command_conflict' USING ERRCODE = '23505';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.communication_delivery_templates AS template_row
      JOIN public.communication_delivery_controls AS control_row
        ON control_row.control_key = template_row.control_key
      WHERE template_row.template_reference = v_preparation.template_reference
        AND template_row.active IS TRUE
        AND control_row.enabled IS TRUE
    ) THEN
      RAISE EXCEPTION 'communications_delivery_disabled' USING ERRCODE = '23505';
    END IF;
    UPDATE public.communication_delivery_preparations
    SET updated_at = now() WHERE idempotency_key = p_idempotency_key;
    RETURN QUERY SELECT 'proceed'::text, 1;
    RETURN;
  END IF;

  SELECT template_row.control_key INTO v_control_key
  FROM public.communication_delivery_templates AS template_row
  JOIN public.communication_delivery_controls AS control_row
    ON control_row.control_key = template_row.control_key
  WHERE template_row.template_reference = p_template_reference
    AND template_row.active IS TRUE
    AND control_row.enabled IS TRUE
  FOR UPDATE OF template_row, control_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'communications_delivery_disabled' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.communication_delivery_preparations(
    idempotency_key, command_fingerprint, template_reference,
    control_key, recipient_fingerprint, operator_id
  ) VALUES (
    p_idempotency_key, p_command_fingerprint, p_template_reference,
    v_control_key, p_recipient_fingerprint, p_operator_id
  );
  RETURN QUERY SELECT 'proceed'::text, 1;
END;
$$;

CREATE FUNCTION public.communications_record_delivery_accepted(
  p_operator_id uuid,
  p_idempotency_key text,
  p_command_fingerprint text,
  p_delivery_reference text
)
RETURNS SETOF public.transactional_delivery_receipts
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_command public.communication_delivery_commands%ROWTYPE;
  v_preparation public.communication_delivery_preparations%ROWTYPE;
  v_receipt public.transactional_delivery_receipts%ROWTYPE;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key, 0));
  SELECT * INTO v_command FROM public.communication_delivery_commands
  WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND AND v_command.command_fingerprint <> p_command_fingerprint THEN
    RAISE EXCEPTION 'communications_command_conflict' USING ERRCODE = '23505';
  END IF;
  IF NOT FOUND THEN
    SELECT * INTO v_preparation FROM public.communication_delivery_preparations
    WHERE idempotency_key = p_idempotency_key FOR UPDATE;
    IF NOT FOUND OR v_preparation.command_fingerprint <> p_command_fingerprint
       OR v_preparation.operator_id <> p_operator_id THEN
      RAISE EXCEPTION 'communications_command_conflict' USING ERRCODE = '23505';
    END IF;
  END IF;
  SELECT * INTO v_receipt FROM public.transactional_delivery_record_accepted(
    p_idempotency_key, p_command_fingerprint, p_delivery_reference
  );
  IF v_command.idempotency_key IS NULL THEN
    INSERT INTO public.communication_delivery_commands(
      idempotency_key, command_fingerprint, template_reference,
      control_key, recipient_fingerprint
    ) VALUES (
      v_preparation.idempotency_key, v_preparation.command_fingerprint,
      v_preparation.template_reference, v_preparation.control_key,
      v_preparation.recipient_fingerprint
    );
    INSERT INTO public.communication_delivery_events(
      idempotency_key, transition, attempt_count, operator_id
    ) VALUES (p_idempotency_key, 'attempted', v_receipt.attempt_count, p_operator_id);
    DELETE FROM public.communication_delivery_preparations
    WHERE idempotency_key = p_idempotency_key;
  END IF;
  UPDATE public.communication_delivery_commands
  SET updated_at = now() WHERE idempotency_key = p_idempotency_key;
  INSERT INTO public.communication_delivery_events(
    idempotency_key, transition, attempt_count, operator_id
  ) VALUES (p_idempotency_key, 'accepted', v_receipt.attempt_count, p_operator_id);
  RETURN NEXT v_receipt;
END;
$$;

CREATE FUNCTION public.communications_record_delivery_failed(
  p_operator_id uuid,
  p_idempotency_key text,
  p_command_fingerprint text,
  p_error_code text
)
RETURNS SETOF public.transactional_delivery_receipts
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_command public.communication_delivery_commands%ROWTYPE;
  v_preparation public.communication_delivery_preparations%ROWTYPE;
  v_receipt public.transactional_delivery_receipts%ROWTYPE;
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key, 0));
  SELECT * INTO v_command FROM public.communication_delivery_commands
  WHERE idempotency_key = p_idempotency_key FOR UPDATE;
  IF FOUND AND v_command.command_fingerprint <> p_command_fingerprint THEN
    RAISE EXCEPTION 'communications_command_conflict' USING ERRCODE = '23505';
  END IF;
  IF NOT FOUND THEN
    SELECT * INTO v_preparation FROM public.communication_delivery_preparations
    WHERE idempotency_key = p_idempotency_key FOR UPDATE;
    IF NOT FOUND OR v_preparation.command_fingerprint <> p_command_fingerprint
       OR v_preparation.operator_id <> p_operator_id THEN
      RAISE EXCEPTION 'communications_command_conflict' USING ERRCODE = '23505';
    END IF;
  END IF;
  SELECT * INTO v_receipt FROM public.transactional_delivery_record_failed(
    p_idempotency_key, p_command_fingerprint, p_error_code
  );
  IF v_command.idempotency_key IS NULL THEN
    INSERT INTO public.communication_delivery_commands(
      idempotency_key, command_fingerprint, template_reference,
      control_key, recipient_fingerprint
    ) VALUES (
      v_preparation.idempotency_key, v_preparation.command_fingerprint,
      v_preparation.template_reference, v_preparation.control_key,
      v_preparation.recipient_fingerprint
    );
    INSERT INTO public.communication_delivery_events(
      idempotency_key, transition, attempt_count, operator_id
    ) VALUES (p_idempotency_key, 'attempted', v_receipt.attempt_count, p_operator_id);
    DELETE FROM public.communication_delivery_preparations
    WHERE idempotency_key = p_idempotency_key;
  END IF;
  UPDATE public.communication_delivery_commands
  SET updated_at = now() WHERE idempotency_key = p_idempotency_key;
  INSERT INTO public.communication_delivery_events(
    idempotency_key, transition, attempt_count, operator_id
  ) VALUES (p_idempotency_key, 'failed', v_receipt.attempt_count, p_operator_id);
  RETURN NEXT v_receipt;
END;
$$;

CREATE FUNCTION public.communications_list_delivery_operations(
  p_operator_id uuid,
  p_page integer,
  p_page_size integer
)
RETURNS TABLE(
  idempotency_key text, template_reference text, recipient_fingerprint text,
  state text, delivery_reference text, error_code text, attempt_count integer,
  created_at timestamptz, updated_at timestamptz, total_count bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  IF p_page IS NULL OR p_page < 0 OR p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 100 THEN
    RAISE EXCEPTION 'communications_page_invalid' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT command_row.idempotency_key, command_row.template_reference,
         command_row.recipient_fingerprint, receipt.state,
         receipt.delivery_reference, receipt.error_code, receipt.attempt_count,
         command_row.created_at, command_row.updated_at, count(*) OVER ()
  FROM public.communication_delivery_commands AS command_row
  JOIN public.transactional_delivery_receipts AS receipt
    ON receipt.idempotency_key = command_row.idempotency_key
  ORDER BY command_row.updated_at DESC, command_row.idempotency_key
  LIMIT p_page_size OFFSET p_page * p_page_size;
END;
$$;

CREATE FUNCTION public.communications_list_delivery_events(
  p_operator_id uuid,
  p_idempotency_key text
)
RETURNS TABLE(
  event_id bigint, idempotency_key text, transition text, attempt_count integer,
  operator_id uuid, occurred_at timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  RETURN QUERY
  SELECT event_row.event_id, event_row.idempotency_key, event_row.transition,
         event_row.attempt_count, event_row.operator_id, event_row.occurred_at
  FROM public.communication_delivery_events AS event_row
  WHERE event_row.idempotency_key = p_idempotency_key
  ORDER BY event_row.event_id;
END;
$$;

CREATE FUNCTION public.communications_list_delivery_controls(p_operator_id uuid)
RETURNS SETOF public.communication_delivery_controls
LANGUAGE plpgsql STABLE SET search_path = pg_catalog
AS $$ BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  RETURN QUERY SELECT * FROM public.communication_delivery_controls ORDER BY control_key;
END; $$;

CREATE FUNCTION public.communications_list_delivery_templates(p_operator_id uuid)
RETURNS SETOF public.communication_delivery_templates
LANGUAGE plpgsql STABLE SET search_path = pg_catalog
AS $$ BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  RETURN QUERY SELECT * FROM public.communication_delivery_templates ORDER BY template_reference;
END; $$;

CREATE FUNCTION public.communications_delivery_health(p_operator_id uuid)
RETURNS TABLE(attempted bigint, accepted bigint, failed bigint)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog
AS $$ BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  RETURN QUERY SELECT
    count(*) FILTER (WHERE transition = 'attempted'),
    count(*) FILTER (WHERE transition = 'accepted'),
    count(*) FILTER (WHERE transition = 'failed')
  FROM public.communication_delivery_events;
END; $$;

CREATE FUNCTION public.communications_delivery_readiness(p_operator_id uuid)
RETURNS TABLE(required_control_count bigint, disabled_control_keys text[])
LANGUAGE plpgsql STABLE SET search_path = pg_catalog
AS $$ BEGIN
  PERFORM public.communications_require_active_operator(p_operator_id);
  RETURN QUERY SELECT count(*),
    COALESCE(array_agg(control_key ORDER BY control_key) FILTER (WHERE enabled IS FALSE), ARRAY[]::text[])
  FROM public.communication_delivery_controls;
END; $$;

REVOKE ALL ON FUNCTION public.communications_operator_is_active(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_refuse_delivery_event_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_require_active_operator(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_set_delivery_control(uuid,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_set_delivery_template(uuid,text,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_prepare_delivery_command(uuid,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_record_delivery_accepted(uuid,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_record_delivery_failed(uuid,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_list_delivery_operations(uuid,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_list_delivery_events(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_list_delivery_controls(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_list_delivery_templates(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_delivery_health(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.communications_delivery_readiness(uuid) FROM PUBLIC, anon, authenticated;
