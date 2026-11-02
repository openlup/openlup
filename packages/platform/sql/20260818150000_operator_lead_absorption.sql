-- Lead absorption on the node-postgres lane.
--
-- WHAT THIS FORWARD SHIPS HERE. The operator command that moves a marketing
-- lead's footprint onto a customer, frees the address the lead was holding, and
-- refuses -- by name, with nothing mutated -- anything that is not a plain
-- shell. It arrives on this lane in the same release as the managed one rather
-- than a release later, because a command that exists on only one runtime is a
-- named refusal in the second-runtime coverage report, and the recovery console
-- already proved a twin is cheap when the semantics are pure Postgres.
--
-- PORTABLE BY CONSTRUCTION, WHICH IS WHY THE TWIN IS POSSIBLE AT ALL. The
-- routine refuses any lead carrying an authorization identity, so it never
-- reads, writes or asks anything of an identity provider; the enumeration of
-- what references `clients` comes from stock `pg_constraint`. There is no
-- managed-platform surface anywhere in its semantics.
--
-- THE THREE HONEST DIFFERENCES FROM THE MANAGED FORWARD, NOT COPY DRIFT.
-- First, this lane carries the authorization link on `clients.principal_id`
-- rather than `clients.auth_user_id`, so the identity refusal reads that column;
-- the rule is the same rule. Second, this lane has no support command ledgers
-- yet -- the managed pair was created by the operator-subscription forward that
-- has no twin -- so the receipt and audit tables are created here, with the same
-- shape, the same append-only intent and the same `command_kind` vocabulary
-- already widened to the value this command uses. Third, this lane has no
-- `service_role`: every object below is revoked from PUBLIC and both browser
-- roles and granted to nobody, which is how every operator-owned object on this
-- lane is already published.
--
-- WHY THE CLASSIFICATION IS SEEDED FOR THIS LANE'S OWN TABLES, AND WHY IT NEEDED
-- A THIRD WORD. The policy is read at run time against the live foreign-key set,
-- so it must describe the schema it actually runs on. Eleven of this lane's
-- twelve referencing tables are commercial and block. The twelfth,
-- `customer_subject_lifecycle_events`, is what proved `block|carry` was not a
-- complete vocabulary: every record has rows in it from the moment it is
-- created, so blocking on it would refuse every absorption on this lane forever
-- -- a dead capability dressed as caution -- while carrying it would move
-- transitions that genuinely happened to the archived record, and its
-- append-only trigger refuses the UPDATE outright. It is `retain`: the rows stay
-- with the archived row, which still exists precisely so they can. Nothing on
-- this lane is `carry` yet, because the marketing tables absorption carries on
-- the managed lane have no twin here; the counters therefore answer zero, and
-- the capability that matters -- refuse the commercial record, archive the
-- shell, free the address -- is whole.

CREATE TABLE public.client_absorption_policy (
  table_name text PRIMARY KEY,
  disposition text NOT NULL,
  note text,
  CONSTRAINT client_absorption_policy_table_name_check
    CHECK (btrim(table_name) <> ''),
  CONSTRAINT client_absorption_policy_disposition_check
    CHECK (disposition IN ('block', 'carry', 'retain'))
);

COMMENT ON TABLE public.client_absorption_policy IS
  'Disposition of every table referencing public.clients when a lead is absorbed into a customer: block refuses the absorption while the lead has rows there, carry moves those rows to the customer, retain leaves them on the archived record because they are that record own history. customer_support_absorb_lead_v1 reads the live foreign-key set from pg_constraint and refuses any referencing table missing from this table, so a new table blocks until it is classified here.';

INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES
  ('channel_order_ingests', 'block', 'Marketplace order intake: commercial, and keyed to an external buyer identity.'),
  ('commerce_checkout_recovery_tokens', 'block', 'A recovery token is a bearer credential scoped to one record.'),
  ('commerce_orders', 'block', 'Order history is never absorbed silently; the first blocker every surveyed system names.'),
  ('commerce_promotion_claims', 'block', 'A claimed promotion is a commitment with a value.'),
  ('commerce_return_requests', 'block', 'An open return moves goods and money for a named record.'),
  ('customer_identity_challenges', 'block', 'An identity challenge is authorization state; absorption never takes an identity.'),
  ('customer_subject_lifecycle_events', 'retain', 'The subject own journey trail, append-only by trigger. Not blocking, because every record has one from creation and it holds no financial instrument; not carried, because those transitions happened to the archived record and moving them would falsify a ledger the trigger refuses to rewrite anyway.'),
  ('risk_manual_review_cases', 'block', 'An open review case names a record a human is looking at.'),
  ('subscription_activations', 'block', 'An activation is the start of a paid plan.'),
  ('subscription_dunning_cases', 'block', 'A dunning case is an unpaid balance being chased.'),
  ('subscription_dunning_notifications', 'block', 'Dunning notices are addressed to the record that owes the balance.'),
  ('subscriptions', 'block', 'A subscription contract. The single loudest blocker in the market reference list.');

-- One immutable answer per operator command, keyed by the idempotency key the
-- caller chose; the fingerprint is derived by the routine, never supplied.
CREATE TABLE public.customer_support_subscription_commands (
  idempotency_key text PRIMARY KEY,
  payload_fingerprint text NOT NULL,
  operator_id uuid NOT NULL REFERENCES public.platform_communication_operators(principal_id),
  -- NULL exactly when the named target resolved to no subject. Recording the
  -- target id here instead would make the ledger lie to the complaint it exists
  -- to answer.
  subject_id uuid,
  target_id uuid NOT NULL,
  command_kind text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_support_subscription_commands_key_check
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  CONSTRAINT customer_support_subscription_commands_fingerprint_check
    CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_support_subscription_commands_kind_check
    CHECK (command_kind IN ('subscription_action', 'email_correction', 'phone_correction', 'lead_absorption')),
  CONSTRAINT customer_support_subscription_commands_response_check
    CHECK (jsonb_typeof(response) = 'object')
);

-- Append-only, and it records refusals as loudly as it records mutations: a
-- support ledger that only remembers the successes cannot answer the complaint
-- that nothing happened.
CREATE TABLE public.customer_support_subscription_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES public.platform_communication_operators(principal_id),
  subject_id uuid,
  target_id uuid NOT NULL,
  command_kind text NOT NULL,
  requested_action text NOT NULL,
  idempotency_key text NOT NULL,
  outcome text NOT NULL,
  refusal_code text,
  value_before text,
  value_after text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_support_subscription_audit_events_kind_check
    CHECK (command_kind IN ('subscription_action', 'email_correction', 'phone_correction', 'lead_absorption')),
  CONSTRAINT customer_support_subscription_audit_events_outcome_check
    CHECK (outcome IN ('applied', 'noop', 'replayed', 'refused', 'conflict')),
  CONSTRAINT customer_support_subscription_audit_events_refusal_check
    CHECK ((outcome IN ('refused', 'conflict')) = (refusal_code IS NOT NULL))
);

CREATE INDEX customer_support_subscription_audit_events_subject_idx
  ON public.customer_support_subscription_audit_events (subject_id, occurred_at DESC);

ALTER TABLE public.client_absorption_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_support_subscription_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_support_subscription_audit_events ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.customer_support_absorb_lead_v1(
  p_operator_id uuid,
  p_customer_id uuid,
  p_lead_id uuid,
  p_expected_lead_email text,
  p_idempotency_key text,
  p_now timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_existing public.customer_support_subscription_commands%ROWTYPE;
  v_lead public.clients%ROWTYPE;
  v_customer public.clients%ROWTYPE;
  v_now timestamptz := COALESCE(p_now, now());
  v_expected text := lower(btrim(COALESCE(p_expected_lead_email, '')));
  v_fingerprint text;
  v_refusal_code text;
  v_outcome text;
  v_response jsonb;
  v_referencing record;
  v_blocking text[] := ARRAY[]::text[];
  v_unclassified text[] := ARRAY[]::text[];
  v_named text[] := ARRAY[]::text[];
  v_present bigint;
  v_moved bigint;
  v_carried jsonb := jsonb_build_object(
    'personalization', 0, 'consents', 0, 'sourceLinks', 0, 'deliveries', 0);
  v_carried_by_table jsonb := '{}'::jsonb;
  v_lead_email text;
  v_tombstone text;
  v_subject_id uuid;
BEGIN
  -- The gate answers first, before a single row of customer state is read.
  PERFORM public.communications_require_active_operator(p_operator_id);

  IF p_customer_id IS NULL
     OR p_lead_id IS NULL
     OR p_customer_id = p_lead_id
     OR char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR char_length(v_expected) NOT BETWEEN 3 AND 320
  THEN
    RAISE EXCEPTION 'customer_support_absorb_lead_invalid' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'lead_absorption|' || p_customer_id::text || '|' || p_lead_id::text || '|' || v_expected, 'utf8')),
    'hex');

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-subscription:' || p_idempotency_key, 0)
  );
  -- Both subjects, in a fixed id order, so two absorptions naming the same pair
  -- from opposite directions serialize instead of deadlocking. Proving the lead
  -- is empty and then emptying it has to be one indivisible act: a concurrent
  -- insert between the two is the only way this routine could destroy data.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-subject:'
      || LEAST(p_customer_id, p_lead_id)::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('customer-support-subject:'
      || GREATEST(p_customer_id, p_lead_id)::text, 0));

  SELECT * INTO v_existing
    FROM public.customer_support_subscription_commands AS command_row
   WHERE command_row.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.payload_fingerprint <> v_fingerprint
       OR v_existing.operator_id <> p_operator_id
       OR v_existing.target_id <> p_lead_id
       OR v_existing.command_kind <> 'lead_absorption'
    THEN
      RAISE EXCEPTION 'customer_support_idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_existing.response->>'outcome' IN ('refused', 'conflict') THEN
      RETURN v_existing.response;
    END IF;
    RETURN jsonb_set(v_existing.response, '{outcome}', '"replayed"'::jsonb, true);
  END IF;

  SELECT * INTO v_lead
    FROM public.clients AS lead_row
   WHERE lead_row.id = p_lead_id
   FOR UPDATE;
  IF NOT FOUND THEN
    v_refusal_code := 'lead_not_found';
  END IF;

  IF v_refusal_code IS NULL THEN
    SELECT * INTO v_customer
      FROM public.clients AS customer_row
     WHERE customer_row.id = p_customer_id
     FOR UPDATE;
    IF NOT FOUND THEN
      v_refusal_code := 'customer_not_found';
    ELSE
      v_subject_id := p_customer_id;
    END IF;
  END IF;

  v_lead_email := v_lead.email;

  -- An already-absorbed pair is a settled fact, not a stale expectation: the
  -- address it is asked about is precisely the one this routine moved away.
  IF v_refusal_code IS NULL
     AND v_lead.metadata #>> '{absorption,absorbedIntoClientId}' = p_customer_id::text
  THEN
    v_outcome := 'noop';
  ELSIF v_refusal_code IS NULL
        AND lower(btrim(COALESCE(v_lead.email, ''))) IS DISTINCT FROM v_expected
  THEN
    v_refusal_code := 'lead_email_expectation_conflict';
  END IF;

  -- This lane names the authorization link `principal_id`; the rule it enforces
  -- is the managed lane's rule exactly.
  IF v_refusal_code IS NULL AND v_outcome IS NULL AND v_lead.principal_id IS NOT NULL THEN
    v_refusal_code := 'lead_has_identity';
  END IF;

  IF v_refusal_code IS NULL AND v_outcome IS NULL THEN
    FOR v_referencing IN
      SELECT referencing.relname::text AS table_name,
             local_column.attname::text AS column_name,
             policy_row.disposition AS disposition
        FROM pg_catalog.pg_constraint AS fk
        JOIN pg_catalog.pg_class AS referencing ON referencing.oid = fk.conrelid
        JOIN pg_catalog.pg_namespace AS referencing_schema
          ON referencing_schema.oid = referencing.relnamespace
        CROSS JOIN LATERAL unnest(fk.conkey, fk.confkey) AS key_pair(local_attnum, remote_attnum)
        JOIN pg_catalog.pg_attribute AS local_column
          ON local_column.attrelid = fk.conrelid AND local_column.attnum = key_pair.local_attnum
        JOIN pg_catalog.pg_attribute AS remote_column
          ON remote_column.attrelid = fk.confrelid AND remote_column.attnum = key_pair.remote_attnum
        LEFT JOIN public.client_absorption_policy AS policy_row
          ON policy_row.table_name = referencing.relname
       WHERE fk.contype = 'f'
         AND fk.confrelid = 'public.clients'::regclass
         AND referencing_schema.nspname = 'public'
         AND remote_column.attname = 'id'
       ORDER BY 1, 2
    LOOP
      IF v_referencing.disposition IS NULL THEN
        IF NOT (v_referencing.table_name = ANY (v_unclassified)) THEN
          v_unclassified := v_unclassified || v_referencing.table_name;
        END IF;
      ELSIF v_referencing.disposition = 'block' THEN
        EXECUTE format(
          'SELECT count(*) FROM public.%I AS blocking_row WHERE blocking_row.%I = $1',
          v_referencing.table_name, v_referencing.column_name)
          INTO v_present USING p_lead_id;
        IF v_present > 0 AND NOT (v_referencing.table_name = ANY (v_blocking)) THEN
          v_blocking := v_blocking || v_referencing.table_name;
        END IF;
      END IF;
    END LOOP;

    IF array_length(v_unclassified, 1) IS NOT NULL THEN
      v_refusal_code := 'unclassified_referencing_table';
      v_named := v_unclassified;
    ELSIF array_length(v_blocking, 1) IS NOT NULL THEN
      v_refusal_code := 'lead_has_commercial_footprint';
      v_named := v_blocking;
    END IF;
  END IF;

  IF v_refusal_code IS NULL AND v_outcome IS NULL THEN
    FOR v_referencing IN
      SELECT referencing.relname::text AS table_name,
             local_column.attname::text AS column_name
        FROM pg_catalog.pg_constraint AS fk
        JOIN pg_catalog.pg_class AS referencing ON referencing.oid = fk.conrelid
        JOIN pg_catalog.pg_namespace AS referencing_schema
          ON referencing_schema.oid = referencing.relnamespace
        CROSS JOIN LATERAL unnest(fk.conkey, fk.confkey) AS key_pair(local_attnum, remote_attnum)
        JOIN pg_catalog.pg_attribute AS local_column
          ON local_column.attrelid = fk.conrelid AND local_column.attnum = key_pair.local_attnum
        JOIN pg_catalog.pg_attribute AS remote_column
          ON remote_column.attrelid = fk.confrelid AND remote_column.attnum = key_pair.remote_attnum
        JOIN public.client_absorption_policy AS policy_row
          ON policy_row.table_name = referencing.relname
       WHERE fk.contype = 'f'
         AND fk.confrelid = 'public.clients'::regclass
         AND referencing_schema.nspname = 'public'
         AND remote_column.attname = 'id'
         AND policy_row.disposition = 'carry'
       ORDER BY 1, 2
    LOOP
      BEGIN
        EXECUTE format(
          'UPDATE public.%I AS carried_row SET %I = $1 WHERE carried_row.%I = $2',
          v_referencing.table_name, v_referencing.column_name, v_referencing.column_name)
          USING p_customer_id, p_lead_id;
        GET DIAGNOSTICS v_moved = ROW_COUNT;
      EXCEPTION WHEN unique_violation THEN
        -- The customer already occupies this table's own key. Theirs is kept
        -- untouched and the lead's stays on the archived record; overwriting
        -- would be the one destructive act this routine must never perform.
        v_moved := 0;
        INSERT INTO public.customer_support_subscription_audit_events (
          operator_id, subject_id, target_id, command_kind, requested_action,
          idempotency_key, outcome, refusal_code, value_before, value_after, occurred_at
        ) VALUES (
          p_operator_id, v_subject_id, p_lead_id, 'lead_absorption',
          'absorb_lead_carry_conflict', p_idempotency_key, 'noop', NULL,
          v_referencing.table_name, 'retained_by_customer', v_now
        );
      END;
      v_carried_by_table := v_carried_by_table
        || jsonb_build_object(v_referencing.table_name, v_moved);
    END LOOP;

    -- The four named counters are the contract the callers read. This lane does
    -- not carry those four tables yet, so they answer zero honestly rather than
    -- reporting whatever else moved; `absorption.carried` on the archived row
    -- below is the complete per-table record.
    v_carried := jsonb_build_object(
      'personalization', COALESCE((v_carried_by_table->>'customer_personalization')::int, 0),
      'consents', COALESCE((v_carried_by_table->>'client_consents')::int, 0),
      'sourceLinks', COALESCE((v_carried_by_table->>'client_source_links')::int, 0),
      'deliveries', COALESCE((v_carried_by_table->>'communication_email_deliveries')::int, 0));

    -- The reserved .invalid namespace can never resolve, so the archived row
    -- can hold an address forever without anyone ever mailing it -- and the
    -- real one is now free for the correction that was refused.
    v_tombstone := 'absorbed+' || replace(p_lead_id::text, '-', '') || '@absorbed.invalid';
    UPDATE public.clients AS lead_row
       SET email = v_tombstone,
           metadata = lead_row.metadata || jsonb_build_object(
             'absorption', jsonb_build_object(
               'absorbedIntoClientId', p_customer_id,
               'absorbedAt', v_now,
               'originalEmail', v_lead_email,
               'idempotencyKey', p_idempotency_key,
               'carried', v_carried_by_table)),
           updated_at = v_now
     WHERE lead_row.id = p_lead_id;
  END IF;

  IF v_refusal_code IS NOT NULL THEN
    v_outcome := CASE
      WHEN v_refusal_code = 'lead_email_expectation_conflict' THEN 'conflict'
      ELSE 'refused' END;
    v_response := jsonb_build_object(
      'outcome', v_outcome,
      'action', 'absorb_lead',
      'leadId', p_lead_id,
      'refusalCode', v_refusal_code
    );
    IF v_refusal_code IN ('lead_has_commercial_footprint', 'unclassified_referencing_table') THEN
      v_response := v_response || jsonb_build_object('blockingTables', to_jsonb(v_named));
    END IF;
  ELSE
    v_response := jsonb_build_object(
      'outcome', COALESCE(v_outcome, 'applied'),
      'action', 'absorb_lead',
      'leadId', p_lead_id,
      'customerId', p_customer_id,
      'carried', v_carried
    );
  END IF;

  INSERT INTO public.customer_support_subscription_commands (
    idempotency_key, payload_fingerprint, operator_id, subject_id, target_id,
    command_kind, response, created_at
  ) VALUES (
    p_idempotency_key, v_fingerprint, p_operator_id, v_subject_id, p_lead_id,
    'lead_absorption', v_response, v_now
  );

  INSERT INTO public.customer_support_subscription_audit_events (
    operator_id, subject_id, target_id, command_kind, requested_action,
    idempotency_key, outcome, refusal_code, value_before, value_after, occurred_at
  ) VALUES (
    p_operator_id, v_subject_id, p_lead_id, 'lead_absorption', 'absorb_lead',
    p_idempotency_key, v_response->>'outcome', v_refusal_code,
    v_lead_email,
    CASE WHEN v_refusal_code IS NULL AND v_outcome IS NULL THEN v_tombstone ELSE NULL END,
    v_now
  );

  RETURN v_response;
END;
$$;

REVOKE ALL ON TABLE public.client_absorption_policy FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_support_subscription_commands FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.customer_support_subscription_audit_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_support_absorb_lead_v1(
  uuid, uuid, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.customer_support_absorb_lead_v1(
  uuid, uuid, uuid, text, text, timestamptz
) IS
  'Operator absorption of a marketing lead into a customer, so a customer whose address is held by a shell can have that address corrected onto them. Refuses by name and mutates nothing when the lead carries an authorization identity, has rows in a block table, or references a table client_absorption_policy does not classify; the refusal names the tables. Carries the classified tables, tombstones the lead address in the reserved .invalid namespace instead of deleting the row, and leaves one receipt plus an append-only audit trail for every outcome including refusals.';
