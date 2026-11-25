-- Retain accepted order money as private, typed facts. Runtime writers continue
-- to omit the version and line key until the order-money writer is available.
CREATE TABLE public.commerce_order_tax_snapshots (
  order_id uuid PRIMARY KEY REFERENCES public.commerce_orders(id) DEFERRABLE INITIALLY DEFERRED,
  calculation_id uuid NOT NULL REFERENCES public.tax_calculations(calculation_id) DEFERRABLE INITIALLY DEFERRED,
  accepted_quote_id uuid,
  cycle_binding_ref uuid,
  destination_snapshot_ref uuid NOT NULL,
  accepted_quote_digest text CHECK (length(accepted_quote_digest) = 64 AND translate(accepted_quote_digest,'0123456789abcdef','') = ''),
  token_digest text CHECK (
    length(token_digest) = 64 AND translate(token_digest,
      '0123456789abcdef','') = ''
  ),
  accepted_money_digest text NOT NULL CHECK (length(accepted_money_digest) = 64 AND translate(accepted_money_digest,'0123456789abcdef','') = ''),
  evidence_digest text NOT NULL CHECK (length(evidence_digest) = 64 AND translate(evidence_digest,'0123456789abcdef','') = ''),
  coverage_digest text NOT NULL CHECK (length(coverage_digest) = 64 AND translate(coverage_digest,'0123456789abcdef','') = ''),
  destination_digest text CHECK (length(destination_digest) = 64 AND translate(destination_digest,'0123456789abcdef','') = ''),
  destination_policy_revision text CHECK (length(destination_policy_revision) BETWEEN 1 AND 256),
  delivery_selection_ref text CHECK (length(delivery_selection_ref) BETWEEN 1 AND 256),
  destination_erased boolean NOT NULL DEFAULT false,
  acceptance_ref text CHECK (length(acceptance_ref) BETWEEN 1 AND 256),
  price_list_ref text NOT NULL CHECK (length(price_list_ref) BETWEEN 1 AND 256),
  price_context_digest text NOT NULL CHECK (length(price_context_digest) = 64 AND translate(price_context_digest,'0123456789abcdef','') = ''),
  price_evidence_ref text NOT NULL CHECK (length(price_evidence_ref) BETWEEN 1 AND 256),
  class_map_revision text NOT NULL CHECK (length(class_map_revision) BETWEEN 1 AND 256),
  catalogue_evidence_ref text NOT NULL CHECK (length(catalogue_evidence_ref) BETWEEN 1 AND 256),
  limit_profile_ref text NOT NULL CHECK (length(limit_profile_ref) BETWEEN 1 AND 256),
  limit_channel_key text NOT NULL CHECK (length(limit_channel_key) BETWEEN 1 AND 256),
  money_version text NOT NULL CHECK (length(money_version) BETWEEN 1 AND 128),
  amount_basis text NOT NULL CHECK (length(amount_basis) BETWEEN 1 AND 128),
  currency text NOT NULL CHECK (length(currency) = 3 AND translate(currency,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','') = ''),
  mode text NOT NULL CHECK (length(mode) BETWEEN 1 AND 128),
  promotion_engine text NOT NULL CHECK (length(promotion_engine) BETWEEN 1 AND 128),
  tax_date timestamptz NOT NULL,
  evaluation_expires_at timestamptz NOT NULL,
  cadence_days integer CHECK (cadence_days BETWEEN 1 AND 3660),
  limit_revision integer NOT NULL CHECK (limit_revision BETWEEN 1 AND 2147483647),
  limit_min_minor bigint NOT NULL CHECK (limit_min_minor BETWEEN 0 AND 9007199254740991),
  limit_max_minor bigint NOT NULL CHECK (limit_max_minor BETWEEN limit_min_minor AND 9007199254740991),
  net_total bigint NOT NULL CHECK (net_total BETWEEN 0 AND 9007199254740991),
  tax_total bigint NOT NULL CHECK (tax_total BETWEEN 0 AND 9007199254740991),
  fee_total bigint NOT NULL CHECK (fee_total BETWEEN 0 AND 9007199254740991),
  payable_minor bigint NOT NULL CHECK (payable_minor BETWEEN 1 AND 2147483647),
  UNIQUE (order_id, money_version),
  CONSTRAINT commerce_order_money_v2_snapshots_accepted_quote_key UNIQUE (accepted_quote_id),
  CONSTRAINT commerce_order_money_v2_snapshots_calculation_key UNIQUE (calculation_id),
  CONSTRAINT commerce_order_tax_snapshots_origin_check CHECK (
    (accepted_quote_id IS NOT NULL AND accepted_quote_digest IS NOT NULL AND token_digest IS NOT NULL
      AND acceptance_ref IS NOT NULL AND cycle_binding_ref IS NULL)
    OR (accepted_quote_id IS NULL AND accepted_quote_digest IS NULL AND token_digest IS NULL
      AND acceptance_ref IS NULL AND cycle_binding_ref IS NOT NULL)
  ),
  CONSTRAINT commerce_order_tax_snapshots_destination_check CHECK (
    (NOT destination_erased AND destination_digest IS NOT NULL
      AND destination_policy_revision IS NOT NULL AND delivery_selection_ref IS NOT NULL)
    OR (destination_erased AND destination_digest IS NULL
      AND destination_policy_revision IS NULL AND delivery_selection_ref IS NULL)
  )
);

CREATE TABLE public.commerce_order_line_sources (
  order_id uuid NOT NULL REFERENCES public.commerce_order_tax_snapshots(order_id) DEFERRABLE INITIALLY DEFERRED,
  sku_id uuid NOT NULL REFERENCES public.catalog_skus(id) DEFERRABLE INITIALLY DEFERRED,
  line_key text NOT NULL CHECK (length(line_key) BETWEEN 1 AND 128),
  tax_class_key text NOT NULL CHECK (length(tax_class_key) BETWEEN 1 AND 256),
  assignment_ref text NOT NULL CHECK (length(assignment_ref) BETWEEN 1 AND 256),
  sku_code text NOT NULL CHECK (length(sku_code) BETWEEN 1 AND 256),
  mode text NOT NULL CHECK (length(mode) BETWEEN 1 AND 128),
  source_ordinal integer NOT NULL CHECK (source_ordinal BETWEEN 1 AND 2147483647),
  source_rank integer NOT NULL CHECK (source_rank BETWEEN 1 AND 50),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_basis_minor bigint NOT NULL CHECK (unit_basis_minor BETWEEN 0 AND 2147483647),
  pre_discount_minor bigint NOT NULL CHECK (pre_discount_minor BETWEEN 0 AND 9007199254740991),
  effective_minor bigint NOT NULL CHECK (effective_minor BETWEEN 0 AND 9007199254740991),
  net_minor bigint NOT NULL CHECK (net_minor BETWEEN 0 AND 9007199254740991),
  tax_minor bigint NOT NULL CHECK (tax_minor BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (order_id, line_key),
  UNIQUE (order_id, source_ordinal)
);

-- Part zero carries delivery facts. Positive parts carry the ordered amounts.
-- The fixed header coordinate lets every part use the same deferred key.
CREATE TABLE public.commerce_order_delivery_buckets (
  order_id uuid NOT NULL REFERENCES public.commerce_order_tax_snapshots(order_id) DEFERRABLE INITIALLY DEFERRED,
  bucket_key text NOT NULL CHECK (length(bucket_key) BETWEEN 1 AND 128),
  tax_class_key text CHECK (length(tax_class_key) BETWEEN 1 AND 256),
  assignment_ref text CHECK (length(assignment_ref) BETWEEN 1 AND 256),
  cost_ref text CHECK (length(cost_ref) BETWEEN 1 AND 256),
  carrier_ref text CHECK (length(carrier_ref) BETWEEN 1 AND 256),
  service_ref text CHECK (length(service_ref) BETWEEN 1 AND 256),
  destination_erased boolean NOT NULL DEFAULT false,
  kind text CHECK (length(kind) BETWEEN 1 AND 128),
  cost_currency text CHECK (length(cost_currency) = 3 AND translate(cost_currency,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','') = ''),
  bucket_rank integer CHECK (bucket_rank BETWEEN 1 AND 256),
  part_no integer NOT NULL CHECK (part_no BETWEEN 0 AND 50),
  header_part_no integer NOT NULL DEFAULT 0 CHECK (header_part_no = 0),
  source_ordinal integer CHECK (source_ordinal BETWEEN 1 AND 2147483647),
  separately_stated boolean,
  cost_amount_minor bigint CHECK (cost_amount_minor BETWEEN 0 AND 9007199254740991),
  pre_discount_minor bigint CHECK (pre_discount_minor BETWEEN 0 AND 9007199254740991),
  effective_minor bigint CHECK (effective_minor BETWEEN 0 AND 9007199254740991),
  net_minor bigint CHECK (net_minor BETWEEN 0 AND 9007199254740991),
  tax_minor bigint CHECK (tax_minor BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (order_id, bucket_key, part_no),
  CONSTRAINT commerce_order_delivery_buckets_header_fkey FOREIGN KEY (order_id, bucket_key, header_part_no)
    REFERENCES public.commerce_order_delivery_buckets(order_id, bucket_key, part_no) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT commerce_order_delivery_buckets_part_check CHECK (
    (part_no = 0 AND tax_class_key IS NOT NULL AND assignment_ref IS NOT NULL AND cost_ref IS NOT NULL
      AND kind IS NOT NULL AND cost_currency IS NOT NULL AND bucket_rank IS NOT NULL AND separately_stated IS NOT NULL
      AND cost_amount_minor IS NOT NULL AND source_ordinal IS NULL AND pre_discount_minor IS NULL AND effective_minor IS NULL
      AND net_minor IS NULL AND tax_minor IS NULL)
    OR (part_no BETWEEN 1 AND 50 AND tax_class_key IS NULL AND assignment_ref IS NULL AND cost_ref IS NULL
      AND kind IS NULL AND cost_currency IS NULL AND bucket_rank IS NULL AND separately_stated IS NULL AND cost_amount_minor IS NULL
      AND pre_discount_minor IS NOT NULL AND effective_minor IS NOT NULL AND net_minor IS NOT NULL AND tax_minor IS NOT NULL)
  ),
  CONSTRAINT commerce_order_delivery_buckets_destination_check CHECK (
    (part_no = 0 AND NOT destination_erased AND carrier_ref IS NOT NULL AND service_ref IS NOT NULL)
    OR (part_no = 0 AND destination_erased AND carrier_ref IS NULL AND service_ref IS NULL)
    OR (part_no BETWEEN 1 AND 50 AND NOT destination_erased AND carrier_ref IS NULL AND service_ref IS NULL)
  )
);

CREATE TABLE public.commerce_order_line_allocations (
  order_id uuid NOT NULL,
  allocation_id uuid PRIMARY KEY,
  adjustment_id uuid NOT NULL REFERENCES public.commerce_order_adjustments(id) DEFERRABLE INITIALLY DEFERRED,
  line_key text CHECK (length(line_key) BETWEEN 1 AND 128),
  bucket_key text CHECK (length(bucket_key) BETWEEN 1 AND 128),
  adjustment_ref text NOT NULL CHECK (length(adjustment_ref) BETWEEN 1 AND 128),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 256),
  part_no integer CHECK (part_no BETWEEN 1 AND 50),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 20),
  basis_reduction_minor bigint NOT NULL CHECK (basis_reduction_minor BETWEEN 1 AND 9007199254740991),
  net_reduction_minor bigint NOT NULL CHECK (net_reduction_minor BETWEEN 0 AND 9007199254740991),
  tax_reduction_minor bigint NOT NULL CHECK (tax_reduction_minor BETWEEN 0 AND 9007199254740991),
  before_basis_minor bigint NOT NULL CHECK (before_basis_minor BETWEEN 0 AND 9007199254740991),
  before_net_minor bigint NOT NULL CHECK (before_net_minor BETWEEN 0 AND 9007199254740991),
  before_tax_minor bigint NOT NULL CHECK (before_tax_minor BETWEEN 0 AND 9007199254740991),
  after_basis_minor bigint NOT NULL CHECK (after_basis_minor BETWEEN 0 AND 9007199254740991),
  after_net_minor bigint NOT NULL CHECK (after_net_minor BETWEEN 0 AND 9007199254740991),
  after_tax_minor bigint NOT NULL CHECK (after_tax_minor BETWEEN 0 AND 9007199254740991),
  CONSTRAINT commerce_order_line_allocations_target_check CHECK (
    (line_key IS NOT NULL AND bucket_key IS NULL AND part_no IS NULL)
    OR (line_key IS NULL AND bucket_key IS NOT NULL AND part_no IS NOT NULL)
  ),
  CONSTRAINT commerce_order_allocations_line_sequence_key UNIQUE (order_id, line_key, sequence),
  CONSTRAINT commerce_order_allocations_part_sequence_key UNIQUE (order_id, bucket_key, part_no, sequence),
  CONSTRAINT commerce_order_allocations_line_identity_key UNIQUE (order_id, allocation_id, sequence, line_key),
  CONSTRAINT commerce_order_allocations_part_identity_key UNIQUE (order_id, allocation_id, sequence, bucket_key, part_no),
  FOREIGN KEY (order_id, line_key) REFERENCES public.commerce_order_line_sources(order_id, line_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (order_id, bucket_key, part_no)
    REFERENCES public.commerce_order_delivery_buckets(order_id, bucket_key, part_no) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE public.commerce_order_tax_positions (
  order_id uuid NOT NULL,
  allocation_id uuid,
  position_ref text NOT NULL CHECK (length(position_ref) BETWEEN 1 AND 128),
  line_key text CHECK (length(line_key) BETWEEN 1 AND 128),
  bucket_key text CHECK (length(bucket_key) BETWEEN 1 AND 128),
  rule_ref text NOT NULL CHECK (length(rule_ref) BETWEEN 1 AND 256),
  assignment_ref text NOT NULL CHECK (length(assignment_ref) BETWEEN 1 AND 256),
  policy_revision text NOT NULL CHECK (length(policy_revision) BETWEEN 1 AND 256),
  resolution_source_ref text NOT NULL CHECK (length(resolution_source_ref) BETWEEN 1 AND 256),
  resolution_source_digest text CHECK (length(resolution_source_digest) = 64 AND translate(resolution_source_digest,'0123456789abcdef','') = ''),
  resolution_digest text NOT NULL CHECK (length(resolution_digest) = 64 AND translate(resolution_digest,'0123456789abcdef','') = ''),
  jurisdiction_ref text NOT NULL CHECK (length(jurisdiction_ref) BETWEEN 1 AND 256),
  taxability_reason text NOT NULL CHECK (length(taxability_reason) BETWEEN 1 AND 256),
  provider_line_ref text CHECK (length(provider_line_ref) BETWEEN 1 AND 256),
  state_side text NOT NULL CHECK (length(state_side) BETWEEN 1 AND 128),
  level text NOT NULL CHECK (length(level) BETWEEN 1 AND 256),
  tax_kind text NOT NULL CHECK (length(tax_kind) BETWEEN 1 AND 256),
  rate_decimal text CHECK (length(rate_decimal) BETWEEN 1 AND 17 AND translate(rate_decimal,'0123456789.','') = ''),
  part_no integer CHECK (part_no BETWEEN 1 AND 50),
  allocation_slot integer NOT NULL CHECK (allocation_slot BETWEEN 0 AND 20),
  position_rank integer NOT NULL CHECK (position_rank BETWEEN 1 AND 32),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  taxable_minor bigint NOT NULL CHECK (taxable_minor BETWEEN 0 AND 9007199254740991),
  tax_minor bigint NOT NULL CHECK (tax_minor BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (order_id, position_ref, state_side, allocation_slot),
  CONSTRAINT commerce_order_tax_positions_target_check CHECK (
    (line_key IS NOT NULL AND bucket_key IS NULL AND part_no IS NULL)
    OR (line_key IS NULL AND bucket_key IS NOT NULL AND part_no IS NOT NULL)
  ),
  CONSTRAINT commerce_order_tax_positions_state_check CHECK (
    (state_side = 'final' AND allocation_id IS NULL AND allocation_slot = 0)
    OR (NOT (state_side = 'final') AND allocation_id IS NOT NULL AND allocation_slot BETWEEN 1 AND 20)
  ),
  FOREIGN KEY (order_id, line_key) REFERENCES public.commerce_order_line_sources(order_id, line_key) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (order_id, bucket_key, part_no)
    REFERENCES public.commerce_order_delivery_buckets(order_id, bucket_key, part_no) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT commerce_order_tax_positions_line_allocation_fkey FOREIGN KEY (order_id, allocation_id, allocation_slot, line_key)
    REFERENCES public.commerce_order_line_allocations(order_id, allocation_id, sequence, line_key) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT commerce_order_tax_positions_part_allocation_fkey FOREIGN KEY (order_id, allocation_id, allocation_slot, bucket_key, part_no)
    REFERENCES public.commerce_order_line_allocations(order_id, allocation_id, sequence, bucket_key, part_no) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX commerce_order_tax_positions_final_key
  ON public.commerce_order_tax_positions (order_id, position_ref) WHERE allocation_slot = 0;

CREATE TABLE public.commerce_order_fee_lines (
  order_id uuid NOT NULL REFERENCES public.commerce_order_tax_snapshots(order_id) DEFERRABLE INITIALLY DEFERRED,
  fee_key text NOT NULL CHECK (length(fee_key) BETWEEN 1 AND 128),
  bucket_key text CHECK (length(bucket_key) BETWEEN 1 AND 128),
  refund_rule_ref text NOT NULL CHECK (length(refund_rule_ref) BETWEEN 1 AND 256),
  refund_rule_revision text NOT NULL CHECK (length(refund_rule_revision) BETWEEN 1 AND 256),
  jurisdiction_ref text NOT NULL CHECK (length(jurisdiction_ref) BETWEEN 1 AND 256),
  provider_position_ref text CHECK (length(provider_position_ref) BETWEEN 1 AND 256),
  fee_kind text NOT NULL CHECK (length(fee_kind) BETWEEN 1 AND 256),
  scope_kind text NOT NULL CHECK (length(scope_kind) BETWEEN 1 AND 128),
  fee_rank integer NOT NULL CHECK (fee_rank BETWEEN 1 AND 256),
  bucket_part_no integer,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (order_id, fee_key),
  CONSTRAINT commerce_order_fee_lines_scope_check CHECK (
    (scope_kind = 'delivery' AND bucket_key IS NOT NULL AND bucket_part_no IS NOT NULL AND bucket_part_no = 0)
    OR (NOT (scope_kind = 'delivery') AND bucket_key IS NULL AND bucket_part_no IS NULL)
  ),
  FOREIGN KEY (order_id, bucket_key, bucket_part_no)
    REFERENCES public.commerce_order_delivery_buckets(order_id, bucket_key, part_no) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE public.commerce_orders ADD COLUMN money_version text;
ALTER TABLE public.commerce_orders ADD CONSTRAINT commerce_orders_money_snapshot_fkey
  FOREIGN KEY (id, money_version) REFERENCES public.commerce_order_tax_snapshots(order_id, money_version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.commerce_order_items ADD COLUMN line_key text;
ALTER TABLE public.commerce_order_items ADD CONSTRAINT commerce_order_items_money_source_fkey
  FOREIGN KEY (order_id, line_key) REFERENCES public.commerce_order_line_sources(order_id, line_key) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.commerce_order_tax_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_order_line_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_order_delivery_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_order_line_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_order_tax_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_order_fee_lines ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.commerce_order_tax_snapshots FROM PUBLIC;
REVOKE ALL ON TABLE public.commerce_order_line_sources FROM PUBLIC;
REVOKE ALL ON TABLE public.commerce_order_delivery_buckets FROM PUBLIC;
REVOKE ALL ON TABLE public.commerce_order_line_allocations FROM PUBLIC;
REVOKE ALL ON TABLE public.commerce_order_tax_positions FROM PUBLIC;
REVOKE ALL ON TABLE public.commerce_order_fee_lines FROM PUBLIC;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_order_tax_snapshots, public.commerce_order_line_sources,
    public.commerce_order_delivery_buckets, public.commerce_order_line_allocations,
    public.commerce_order_tax_positions, public.commerce_order_fee_lines FROM anon;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_order_tax_snapshots, public.commerce_order_line_sources,
    public.commerce_order_delivery_buckets, public.commerce_order_line_allocations,
    public.commerce_order_tax_positions, public.commerce_order_fee_lines FROM authenticated;';
END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  EXECUTE 'REVOKE ALL ON TABLE public.commerce_order_tax_snapshots, public.commerce_order_line_sources,
    public.commerce_order_delivery_buckets, public.commerce_order_line_allocations,
    public.commerce_order_tax_positions, public.commerce_order_fee_lines FROM service_role;';
END IF; END; $$;
