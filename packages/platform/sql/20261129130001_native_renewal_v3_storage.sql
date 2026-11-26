-- Private renewal facts. The legacy worker continues to use its existing storage.
CREATE TABLE public.subscription_cycle_occurrences (
  cycle_key uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  original_anchor_at timestamptz NOT NULL,
  effective_due_at timestamptz NOT NULL,
  cadence_seconds bigint NOT NULL,
  rail text NOT NULL,
  lifecycle text NOT NULL,
  is_current boolean NOT NULL,
  deadline_rule_ref text,
  deadline_rule_revision bigint,
  lead_seconds bigint,
  late_cancel_disposition text,
  cancellation_receipt_id uuid REFERENCES public.subscription_command_receipts(id),
  cancellation_effective_at timestamptz,
  operation_id uuid,
  commercial_generation_id uuid,
  UNIQUE (subscription_id, cycle_key),
  CONSTRAINT cycle_occurrence_schedule_check CHECK (cadence_seconds BETWEEN 1 AND 9223372036854775807
    AND NOT (original_anchor_at IN ('-infinity', 'infinity') OR effective_due_at IN ('-infinity', 'infinity'))),
  CONSTRAINT cycle_occurrence_rail_check CHECK (rail IN ('legacy', 'v3')),
  CONSTRAINT cycle_occurrence_lifecycle_check CHECK (lifecycle IN ('active', 'paused', 'stopped', 'retired')),
  CONSTRAINT cycle_occurrence_pair_check CHECK ((operation_id IS NULL AND commercial_generation_id IS NULL)
    OR (operation_id IS NOT NULL AND commercial_generation_id IS NOT NULL)),
  CONSTRAINT cycle_occurrence_policy_check CHECK (
    (deadline_rule_ref IS NULL AND deadline_rule_revision IS NULL AND lead_seconds IS NULL AND late_cancel_disposition IS NULL)
    OR (deadline_rule_ref IS NOT NULL AND deadline_rule_revision IS NOT NULL AND lead_seconds IS NOT NULL AND late_cancel_disposition IS NOT NULL
      AND octet_length(deadline_rule_ref) BETWEEN 1 AND 200
      -- C's POSIX space class covers ASCII whitespace. The literal also covers
      -- U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028–U+2029, U+202F, U+205F, U+3000 and U+FEFF.
      AND NOT (deadline_rule_ref COLLATE "C" SIMILAR TO '[[:space:]                 　﻿]*')
      AND deadline_rule_revision BETWEEN 1 AND 9007199254740991 AND lead_seconds BETWEEN 0 AND cadence_seconds - 1
      AND late_cancel_disposition IN ('hold_current', 'allow_current_first_charge_if_authorized')))
);
CREATE UNIQUE INDEX subscription_cycle_occurrences_current_idx ON public.subscription_cycle_occurrences (subscription_id) WHERE is_current;

CREATE TABLE public.subscription_cycle_delivery_assignments (
  obligation_ref uuid PRIMARY KEY REFERENCES public.commerce_orders(id),
  assigned_cycle_key uuid NOT NULL REFERENCES public.subscription_cycle_occurrences(cycle_key),
  marker_cycle_key uuid REFERENCES public.subscription_cycle_occurrences(cycle_key),
  qualifying_actual_arrival_at timestamptz,
  applied_due_at timestamptz
);
CREATE INDEX subscription_cycle_delivery_assignments_cycle_idx ON public.subscription_cycle_delivery_assignments (assigned_cycle_key);

-- Retain the owner-verified delivery coordinates alongside the original observation.
CREATE TABLE public.subscription_cycle_delivery_evidence (
  observation_event_key text PRIMARY KEY REFERENCES public.fulfillment_observations(event_key),
  obligation_ref uuid NOT NULL REFERENCES public.subscription_cycle_delivery_assignments(obligation_ref),
  shipment_id uuid NOT NULL REFERENCES public.fulfillment_shipments(id),
  dispatch_ref_id uuid NOT NULL REFERENCES public.fulfillment_dispatch_refs(id),
  provider_ref text NOT NULL CHECK (NOT (btrim(provider_ref) = '')),
  actual_arrival_at timestamptz NOT NULL CHECK (NOT (actual_arrival_at IN ('-infinity', 'infinity'))),
  evidence_digest text NOT NULL,
  CONSTRAINT cycle_delivery_evidence_digest_check CHECK (length(evidence_digest) = 64
    AND translate(evidence_digest, '0123456789abcdef', '') = '')
);
CREATE INDEX subscription_cycle_delivery_evidence_obligation_idx
  ON public.subscription_cycle_delivery_evidence (obligation_ref, shipment_id);

CREATE TABLE public.subscription_cycle_generations (
  operation_id uuid NOT NULL REFERENCES public.subscription_renewal_operations(id),
  commercial_generation_id uuid NOT NULL,
  cycle_key uuid NOT NULL REFERENCES public.subscription_cycle_occurrences(cycle_key),
  agreement jsonb NOT NULL,
  agreement_fingerprint text NOT NULL,
  claim_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  lease_generation bigint NOT NULL,
  last_binding_seq bigint NOT NULL DEFAULT 0,
  current_binding_ref uuid,
  first_failure_at timestamptz,
  failure_cause text,
  failure_count bigint,
  next_eligible_at timestamptz,
  PRIMARY KEY (operation_id, commercial_generation_id),
  UNIQUE (cycle_key, operation_id, commercial_generation_id),
  CONSTRAINT cycle_generation_agreement_check CHECK (jsonb_typeof(agreement) = 'object'
    AND length(agreement_fingerprint) = 64 AND translate(agreement_fingerprint, '0123456789abcdef', '') = ''),
  CONSTRAINT cycle_generation_sequence_check CHECK (lease_generation BETWEEN 1 AND 9223372036854775807
    AND last_binding_seq BETWEEN 0 AND 9223372036854775807),
  CONSTRAINT cycle_generation_deferral_check CHECK (
    (first_failure_at IS NULL AND failure_cause IS NULL AND failure_count IS NULL AND next_eligible_at IS NULL)
    OR (first_failure_at IS NOT NULL AND failure_cause IS NOT NULL AND failure_count IS NOT NULL AND next_eligible_at IS NOT NULL
      AND failure_count BETWEEN 1 AND 9223372036854775807))
);

ALTER TABLE public.subscription_cycle_occurrences ADD CONSTRAINT cycle_occurrence_selected_pair_fkey
  FOREIGN KEY (cycle_key, operation_id, commercial_generation_id)
  REFERENCES public.subscription_cycle_generations(cycle_key, operation_id, commercial_generation_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.subscription_cycle_stock_holds (
  hold_incarnation_id uuid PRIMARY KEY,
  cycle_key uuid NOT NULL,
  operation_id uuid NOT NULL,
  commercial_generation_id uuid NOT NULL,
  reservation_id uuid NOT NULL REFERENCES public.fulfillment_inventory_reservations(id),
  expires_at timestamptz NOT NULL,
  state text NOT NULL,
  FOREIGN KEY (cycle_key, operation_id, commercial_generation_id)
    REFERENCES public.subscription_cycle_generations(cycle_key, operation_id, commercial_generation_id),
  CONSTRAINT cycle_stock_hold_state_check CHECK (state IN ('held', 'released', 'expired', 'superseded', 'committed'))
);
CREATE UNIQUE INDEX subscription_cycle_stock_holds_live_cycle_idx ON public.subscription_cycle_stock_holds (cycle_key) WHERE state = 'held';
CREATE UNIQUE INDEX subscription_cycle_stock_holds_live_reservation_idx ON public.subscription_cycle_stock_holds (reservation_id) WHERE state = 'held';

CREATE TABLE public.subscription_cycle_tax_issuances (
  evaluation_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  commercial_generation_id uuid NOT NULL,
  binding_seq bigint NOT NULL,
  hold_incarnation_id uuid NOT NULL REFERENCES public.subscription_cycle_stock_holds(hold_incarnation_id),
  issued_calculation_id uuid NOT NULL UNIQUE,
  request_digest text NOT NULL,
  request_evidence jsonb,
  erased_at timestamptz,
  UNIQUE (operation_id, commercial_generation_id, binding_seq),
  FOREIGN KEY (operation_id, commercial_generation_id) REFERENCES public.subscription_cycle_generations(operation_id, commercial_generation_id),
  CONSTRAINT cycle_tax_issuance_sequence_check CHECK (binding_seq BETWEEN 1 AND 9223372036854775807),
  CONSTRAINT cycle_tax_issuance_digest_check CHECK (length(request_digest) = 64 AND translate(request_digest, '0123456789abcdef', '') = ''),
  CONSTRAINT cycle_tax_issuance_evidence_check CHECK (
    (erased_at IS NULL AND request_evidence IS NOT NULL AND jsonb_typeof(request_evidence) = 'object')
    OR (erased_at IS NOT NULL AND request_evidence IS NULL))
);

CREATE TABLE public.subscription_cycle_tax_bindings (
  binding_ref uuid PRIMARY KEY,
  evaluation_id uuid NOT NULL UNIQUE REFERENCES public.subscription_cycle_tax_issuances(evaluation_id),
  cycle_key uuid NOT NULL,
  operation_id uuid NOT NULL,
  commercial_generation_id uuid NOT NULL,
  binding_seq bigint NOT NULL,
  calculation_id uuid NOT NULL REFERENCES public.tax_calculations(calculation_id),
  bind_digest text NOT NULL,
  accepted_money_digest text NOT NULL,
  payable_minor bigint NOT NULL,
  currency text NOT NULL,
  tax_point timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  live_evidence jsonb,
  erased_at timestamptz,
  UNIQUE (operation_id, commercial_generation_id, binding_seq),
  UNIQUE (operation_id, commercial_generation_id, binding_ref),
  FOREIGN KEY (cycle_key, operation_id, commercial_generation_id)
    REFERENCES public.subscription_cycle_generations(cycle_key, operation_id, commercial_generation_id),
  CONSTRAINT cycle_tax_binding_money_check CHECK (binding_seq BETWEEN 1 AND 9223372036854775807
    AND payable_minor BETWEEN 1 AND 2147483647 AND length(currency) = 3 AND translate(currency, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '') = ''),
  CONSTRAINT cycle_tax_binding_digest_check CHECK (length(bind_digest) = 64 AND translate(bind_digest, '0123456789abcdef', '') = ''
    AND length(accepted_money_digest) = 64 AND translate(accepted_money_digest, '0123456789abcdef', '') = ''),
  CONSTRAINT cycle_tax_binding_evidence_check CHECK (
    (erased_at IS NULL AND live_evidence IS NOT NULL AND jsonb_typeof(live_evidence) = 'object')
    OR (erased_at IS NOT NULL AND live_evidence IS NULL))
);

ALTER TABLE public.subscription_cycle_generations ADD CONSTRAINT cycle_generation_current_binding_fkey
  FOREIGN KEY (operation_id, commercial_generation_id, current_binding_ref)
  REFERENCES public.subscription_cycle_tax_bindings(operation_id, commercial_generation_id, binding_ref) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.subscription_cycle_cases (
  case_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  commercial_generation_id uuid NOT NULL,
  case_kind text NOT NULL CHECK (case_kind IN ('tax_preflight', 'fiscal_drift_retry')),
  state text NOT NULL,
  cause text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9223372036854775807),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  FOREIGN KEY (operation_id, commercial_generation_id) REFERENCES public.subscription_cycle_generations(operation_id, commercial_generation_id),
  CONSTRAINT cycle_case_state_check CHECK ((state = 'open' AND closed_at IS NULL)
    OR (state = 'closed' AND closed_at IS NOT NULL AND closed_at BETWEEN opened_at AND 'infinity'))
);
CREATE UNIQUE INDEX subscription_cycle_cases_open_idx ON public.subscription_cycle_cases (operation_id, commercial_generation_id, case_kind) WHERE state = 'open';

CREATE TABLE public.subscription_cycle_preparations (
  preparation_id uuid PRIMARY KEY,
  cycle_key uuid NOT NULL,
  cycle_id uuid NOT NULL UNIQUE REFERENCES public.subscription_cycles(id),
  operation_id uuid NOT NULL,
  commercial_generation_id uuid NOT NULL,
  binding_ref uuid NOT NULL UNIQUE,
  binding_seq bigint NOT NULL,
  hold_incarnation_id uuid NOT NULL REFERENCES public.subscription_cycle_stock_holds(hold_incarnation_id),
  order_id uuid NOT NULL UNIQUE REFERENCES public.commerce_orders(id) DEFERRABLE INITIALLY DEFERRED,
  settlement_intent_id uuid NOT NULL UNIQUE REFERENCES public.commerce_settlement_intents(id) DEFERRABLE INITIALLY DEFERRED,
  payment_attempt_id uuid NOT NULL UNIQUE REFERENCES public.payment_provider_attempts(id) DEFERRABLE INITIALLY DEFERRED,
  opening_key text NOT NULL UNIQUE,
  accepted_money_digest text NOT NULL,
  prepared_at timestamptz NOT NULL,
  closed_unsent_at timestamptz,
  replaces_preparation_id uuid UNIQUE REFERENCES public.subscription_cycle_preparations(preparation_id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (operation_id, commercial_generation_id, binding_seq),
  FOREIGN KEY (cycle_key, operation_id, commercial_generation_id)
    REFERENCES public.subscription_cycle_generations(cycle_key, operation_id, commercial_generation_id),
  FOREIGN KEY (operation_id, commercial_generation_id, binding_ref)
    REFERENCES public.subscription_cycle_tax_bindings(operation_id, commercial_generation_id, binding_ref),
  CONSTRAINT cycle_preparation_digest_check CHECK (length(accepted_money_digest) = 64 AND translate(accepted_money_digest, '0123456789abcdef', '') = '')
);

CREATE TABLE public.subscription_cycle_payment_attempts (
  payment_attempt_id uuid PRIMARY KEY REFERENCES public.payment_provider_attempts(id),
  preparation_id uuid NOT NULL REFERENCES public.subscription_cycle_preparations(preparation_id),
  attempt_kind text NOT NULL,
  predecessor_attempt_id uuid REFERENCES public.subscription_cycle_payment_attempts(payment_attempt_id) DEFERRABLE INITIALLY DEFERRED,
  retry_key text,
  recovery_authorization_ref uuid,
  UNIQUE (preparation_id, retry_key),
  CONSTRAINT cycle_attempt_kind_check CHECK (
    (attempt_kind = 'initial' AND predecessor_attempt_id IS NULL AND retry_key IS NULL AND recovery_authorization_ref IS NULL)
    OR (attempt_kind = 'retry' AND predecessor_attempt_id IS NOT NULL AND retry_key IS NOT NULL AND recovery_authorization_ref IS NOT NULL))
);
CREATE INDEX subscription_cycle_payment_attempts_preparation_idx ON public.subscription_cycle_payment_attempts (preparation_id);

CREATE TABLE public.subscription_cycle_dispatch_grants (
  grant_id uuid PRIMARY KEY,
  payment_attempt_id uuid NOT NULL REFERENCES public.subscription_cycle_payment_attempts(payment_attempt_id),
  confirmation_step_ref text NOT NULL,
  confirmation_kind text NOT NULL,
  authorized_hold_ref text,
  authorized_hold_expires_at timestamptz,
  provider_account_ref text NOT NULL,
  provider_mode text NOT NULL CHECK (provider_mode IN ('test', 'live')),
  request_digest text NOT NULL,
  idempotency_key text NOT NULL,
  checked_at timestamptz NOT NULL,
  send_by timestamptz NOT NULL,
  notice_decision jsonb NOT NULL,
  UNIQUE (payment_attempt_id, confirmation_step_ref),
  UNIQUE (provider_account_ref, provider_mode, idempotency_key),
  CONSTRAINT cycle_dispatch_hold_check CHECK (
    (confirmation_kind = 'server_confirmation' AND authorized_hold_ref IS NULL AND authorized_hold_expires_at IS NULL)
    OR (confirmation_kind = 'server_capture' AND authorized_hold_ref IS NOT NULL AND authorized_hold_expires_at IS NOT NULL
      AND send_by BETWEEN checked_at AND authorized_hold_expires_at)),
  CONSTRAINT cycle_dispatch_deadline_check CHECK (send_by BETWEEN checked_at AND 'infinity'
    AND NOT (checked_at IN ('-infinity', 'infinity') OR send_by IN (checked_at, 'infinity'))),
  CONSTRAINT cycle_dispatch_evidence_check CHECK (length(request_digest) = 64 AND translate(request_digest, '0123456789abcdef', '') = ''
    AND jsonb_typeof(notice_decision) = 'object')
);

CREATE TABLE public.subscription_cycle_calculation_rebinds (
  rebind_id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.commerce_orders(id),
  preparation_id uuid NOT NULL REFERENCES public.subscription_cycle_preparations(preparation_id),
  retry_attempt_id uuid NOT NULL UNIQUE REFERENCES public.subscription_cycle_payment_attempts(payment_attempt_id),
  sale_key text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9223372036854775807),
  previous_calculation_id uuid NOT NULL REFERENCES public.tax_calculations(calculation_id),
  effective_calculation_id uuid NOT NULL UNIQUE REFERENCES public.tax_calculations(calculation_id),
  accepted_money_digest text NOT NULL,
  proof_digest text NOT NULL,
  rebound_at timestamptz NOT NULL,
  UNIQUE (order_id, sequence),
  CONSTRAINT cycle_rebind_digest_check CHECK (length(accepted_money_digest) = 64 AND translate(accepted_money_digest, '0123456789abcdef', '') = ''
    AND length(proof_digest) = 64 AND translate(proof_digest, '0123456789abcdef', '') = '')
);

ALTER TABLE public.subscription_cycle_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cycle_delivery_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cycle_delivery_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cycle_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cycle_stock_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cycle_tax_issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cycle_tax_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cycle_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cycle_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cycle_payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cycle_dispatch_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cycle_calculation_rebinds ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.subscription_cycle_occurrences FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_cycle_delivery_assignments FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_cycle_delivery_evidence FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_cycle_generations FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_cycle_stock_holds FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_cycle_tax_issuances FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_cycle_tax_bindings FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_cycle_cases FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_cycle_preparations FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_cycle_payment_attempts FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_cycle_dispatch_grants FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_cycle_calculation_rebinds FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.subscription_cycle_occurrences, public.subscription_cycle_delivery_assignments,
    public.subscription_cycle_delivery_evidence,
    public.subscription_cycle_generations, public.subscription_cycle_stock_holds, public.subscription_cycle_tax_issuances,
    public.subscription_cycle_tax_bindings, public.subscription_cycle_cases, public.subscription_cycle_preparations,
    public.subscription_cycle_payment_attempts, public.subscription_cycle_dispatch_grants, public.subscription_cycle_calculation_rebinds FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.subscription_cycle_occurrences, public.subscription_cycle_delivery_assignments,
    public.subscription_cycle_delivery_evidence,
    public.subscription_cycle_generations, public.subscription_cycle_stock_holds, public.subscription_cycle_tax_issuances,
    public.subscription_cycle_tax_bindings, public.subscription_cycle_cases, public.subscription_cycle_preparations,
    public.subscription_cycle_payment_attempts, public.subscription_cycle_dispatch_grants, public.subscription_cycle_calculation_rebinds FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.subscription_cycle_occurrences, public.subscription_cycle_delivery_assignments,
    public.subscription_cycle_delivery_evidence,
    public.subscription_cycle_generations, public.subscription_cycle_stock_holds, public.subscription_cycle_tax_issuances,
    public.subscription_cycle_tax_bindings, public.subscription_cycle_cases, public.subscription_cycle_preparations,
    public.subscription_cycle_payment_attempts, public.subscription_cycle_dispatch_grants, public.subscription_cycle_calculation_rebinds FROM service_role;';
END IF; END; $$;

INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('subscription_cycle_occurrences', 'block', 'Renewal occurrence history stays with its original client.');
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'GRANT SELECT (client_id) ON TABLE public.subscription_cycle_occurrences TO service_role;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'CREATE POLICY subscription_cycle_occurrences_absorption_census ON public.subscription_cycle_occurrences FOR SELECT TO service_role USING (true);';
END IF; END; $$;
