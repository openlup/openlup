-- Public platform transactional-delivery receipt capability.
--
-- The forward exposes one neutral durable receipt and three invoker-rights RPCs:
-- read, record accepted, and record failed. It persists only a command digest,
-- a neutral delivery reference, a constrained failure code, transition state,
-- attempt count and timestamps. Delivery content and transport diagnostics stay
-- outside this compact kernel boundary.

CREATE TABLE public.transactional_delivery_receipts (
  idempotency_key text PRIMARY KEY,
  command_fingerprint text NOT NULL,
  state text NOT NULL,
  delivery_reference text,
  error_code text,
  attempt_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  failed_at timestamptz,
  CONSTRAINT transactional_delivery_receipts_idempotency_key_nonempty_check
    CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT transactional_delivery_receipts_idempotency_key_format_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT transactional_delivery_receipts_fingerprint_format_check
    CHECK (command_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT transactional_delivery_receipts_state_check
    CHECK (state IN ('accepted', 'failed')),
  CONSTRAINT transactional_delivery_receipts_attempt_count_check
    CHECK (attempt_count >= 1),
  CONSTRAINT transactional_delivery_receipts_evidence_shape_check
    CHECK (
      (state = 'accepted'
        AND delivery_reference IS NOT NULL
        AND error_code IS NULL
        AND accepted_at IS NOT NULL)
      OR
      (state = 'failed'
        AND delivery_reference IS NULL
        AND error_code IS NOT NULL
        AND accepted_at IS NULL
        AND failed_at IS NOT NULL)
    ),
  CONSTRAINT transactional_delivery_receipts_timestamp_order_check
    CHECK (
      updated_at >= created_at
      AND (accepted_at IS NULL OR accepted_at >= created_at)
      AND (failed_at IS NULL OR failed_at >= created_at)
    )
);

CREATE FUNCTION public.transactional_delivery_read_receipt(
  p_idempotency_key text
)
RETURNS SETOF public.transactional_delivery_receipts
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT receipt.*
    FROM public.transactional_delivery_receipts AS receipt
   WHERE receipt.idempotency_key = p_idempotency_key;
$$;

CREATE FUNCTION public.transactional_delivery_record_accepted(
  p_idempotency_key text,
  p_command_fingerprint text,
  p_delivery_reference text
)
RETURNS public.transactional_delivery_receipts
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_receipt public.transactional_delivery_receipts%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' THEN
    RAISE EXCEPTION 'transactional_delivery_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_command_fingerprint IS NULL OR p_command_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'transactional_delivery_invalid_command_fingerprint' USING ERRCODE = '22023';
  END IF;
  IF p_delivery_reference IS NULL
     OR p_delivery_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' THEN
    RAISE EXCEPTION 'transactional_delivery_invalid_delivery_reference' USING ERRCODE = '22023';
  END IF;

  LOOP
    SELECT * INTO v_receipt
      FROM public.transactional_delivery_receipts
     WHERE idempotency_key = p_idempotency_key
     FOR UPDATE;

    IF FOUND THEN
      IF v_receipt.command_fingerprint <> p_command_fingerprint THEN
        RAISE EXCEPTION 'transactional_delivery_command_fingerprint_conflict' USING ERRCODE = '22023';
      END IF;
      IF v_receipt.state = 'accepted' THEN
        RETURN v_receipt;
      END IF;

      UPDATE public.transactional_delivery_receipts
         SET state = 'accepted',
             delivery_reference = p_delivery_reference,
             error_code = NULL,
             attempt_count = attempt_count + 1,
             updated_at = now(),
             accepted_at = now()
       WHERE idempotency_key = p_idempotency_key
       RETURNING * INTO v_receipt;
      RETURN v_receipt;
    END IF;

    INSERT INTO public.transactional_delivery_receipts (
      idempotency_key,
      command_fingerprint,
      state,
      delivery_reference,
      attempt_count,
      accepted_at
    ) VALUES (
      p_idempotency_key,
      p_command_fingerprint,
      'accepted',
      p_delivery_reference,
      1,
      now()
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING * INTO v_receipt;

    IF FOUND THEN
      RETURN v_receipt;
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION public.transactional_delivery_record_failed(
  p_idempotency_key text,
  p_command_fingerprint text,
  p_error_code text
)
RETURNS public.transactional_delivery_receipts
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_receipt public.transactional_delivery_receipts%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' THEN
    RAISE EXCEPTION 'transactional_delivery_invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_command_fingerprint IS NULL OR p_command_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'transactional_delivery_invalid_command_fingerprint' USING ERRCODE = '22023';
  END IF;
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z][a-z0-9_.-]{0,127}$' THEN
    RAISE EXCEPTION 'transactional_delivery_invalid_error_code' USING ERRCODE = '22023';
  END IF;

  LOOP
    SELECT * INTO v_receipt
      FROM public.transactional_delivery_receipts
     WHERE idempotency_key = p_idempotency_key
     FOR UPDATE;

    IF FOUND THEN
      IF v_receipt.command_fingerprint <> p_command_fingerprint THEN
        RAISE EXCEPTION 'transactional_delivery_command_fingerprint_conflict' USING ERRCODE = '22023';
      END IF;
      IF v_receipt.state = 'accepted' THEN
        RETURN v_receipt;
      END IF;

      UPDATE public.transactional_delivery_receipts
         SET error_code = p_error_code,
             attempt_count = attempt_count + 1,
             updated_at = now(),
             failed_at = now()
       WHERE idempotency_key = p_idempotency_key
       RETURNING * INTO v_receipt;
      RETURN v_receipt;
    END IF;

    INSERT INTO public.transactional_delivery_receipts (
      idempotency_key,
      command_fingerprint,
      state,
      error_code,
      attempt_count,
      failed_at
    ) VALUES (
      p_idempotency_key,
      p_command_fingerprint,
      'failed',
      p_error_code,
      1,
      now()
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING * INTO v_receipt;

    IF FOUND THEN
      RETURN v_receipt;
    END IF;
  END LOOP;
END;
$$;
