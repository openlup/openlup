-- Public platform sellable bundles: a bill of materials over catalogue units,
-- priced once instead of summed.
--
-- WHAT THIS FORWARD SHIPS. Three relations and nothing else. A bundle names a set of
-- catalogue units and the multiplicity of each; a price row states, for one price list
-- and one purchase mode, the single amount an operator wants the whole set to cost. No
-- routine, no trigger, no policy, no grant. Every capability that reads or writes these
-- rows arrives in a later slice, so on a fresh database this forward changes what the
-- schema can express and changes nothing the runtime does.
--
-- WHY THE PRICE IS A TARGET AND NOT A DISCOUNT. The obvious alternative -- store a
-- percentage or an absolute reduction and derive the amount from the components at read
-- time -- makes the bundle's price a function of rows that move independently of it. An
-- operator who repriced one unit would silently reprice every bundle containing it, and
-- the amount a customer was quoted would not be recoverable from the record afterwards.
-- Storing the target directly makes the operator's decision the stored fact and leaves
-- any comparison against the component sum to the layer that wants to display it.
--
-- WHY THERE IS NO CURRENCY COLUMN HERE. Currency and region are properties of the price
-- list this row points at. A second copy on the price row could disagree with the first,
-- and there is no rule that could decide which of the two an operator meant. The foreign
-- key is therefore the only statement of currency, and it is RESTRICT: a price list may
-- not be removed while rows still depend on it for their meaning.
--
-- WHY THE COMPOSITION CONSTRAINT IS OPAQUE. `composition_constraint` is a jsonb envelope
-- the platform stores and never interprets -- a kind, a version, and a payload the rules
-- engine of a later slice owns. Encoding today's understanding of those rules as a CHECK
-- would buy no safety the engine does not already enforce, and would cost a migration
-- every time the engine learned a new shape. It defaults to an empty object so an
-- unconstrained bundle needs no special case on read.
--
-- TWO FULFILMENT MODES, ONE OF THEM AHEAD OF ITS RUNTIME. A 'virtual' bundle is expanded
-- into its components downstream; a 'kitted' bundle is handled as one pre-packed unit.
-- Only the first has a runtime. The second is admitted by the CHECK anyway, because the
-- alternative is widening an enumeration on a populated column later, and refusing it is
-- a rule the code that fulfils bundles can state far more precisely than a CHECK can.
--
-- DELETE BEHAVIOUR IS NOT UNIFORM, AND THE ASYMMETRY IS THE POINT. Components and prices
-- CASCADE from their bundle, because removing a bundle is a decision about the whole
-- entity. Both outward references -- to a catalogue unit and to a price list -- RESTRICT,
-- because those rows belong to other operators' decisions and a bundle must not be the
-- reason one of them silently disappears, nor be left pointing at nothing.
--
-- NO ROW LEVEL SECURITY AND NO GRANTS, DELIBERATELY. These are operator-owned relations.
-- A table created here carries privileges for its owner alone; the actor bootstrap grants
-- `anon` and `authenticated` schema usage and one routine, never table access, so both
-- principals are already denied without a REVOKE to say so. Enabling row level security
-- with no policy would add catalogue objects that change no answer. The customer-facing
-- read lane, if bundles ever need one, is a policy authored by the slice that opens it.

CREATE TABLE public.catalog_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  fulfillment_mode text NOT NULL DEFAULT 'virtual',
  composition_constraint jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_bundles_code_key UNIQUE (code),
  CONSTRAINT catalog_bundles_code_nonempty_check CHECK (btrim(code) <> ''),
  CONSTRAINT catalog_bundles_status_check
    CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT catalog_bundles_fulfillment_mode_check
    CHECK (fulfillment_mode IN ('virtual', 'kitted'))
);

CREATE INDEX idx_catalog_bundles_status ON public.catalog_bundles (status);

CREATE TABLE public.catalog_bundle_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id uuid NOT NULL REFERENCES public.catalog_bundles (id) ON DELETE CASCADE,
  catalog_sku_id uuid NOT NULL REFERENCES public.catalog_skus (id) ON DELETE RESTRICT,
  quantity integer NOT NULL,
  is_addon boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_bundle_components_quantity_check CHECK (quantity > 0),
  CONSTRAINT catalog_bundle_components_unique UNIQUE (bundle_id, catalog_sku_id)
);

CREATE INDEX idx_catalog_bundle_components_catalog_sku_id
  ON public.catalog_bundle_components (catalog_sku_id);

CREATE TABLE public.catalog_bundle_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id uuid NOT NULL REFERENCES public.catalog_bundles (id) ON DELETE CASCADE,
  price_list_id uuid NOT NULL REFERENCES public.price_lists (id) ON DELETE RESTRICT,
  mode text NOT NULL DEFAULT 'one_time',
  target_price_minor integer NOT NULL,
  amount_kind text NOT NULL DEFAULT 'gross',
  active boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_bundle_prices_mode_check
    CHECK (mode IN ('one_time', 'subscription', 'any')),
  CONSTRAINT catalog_bundle_prices_target_price_check CHECK (target_price_minor >= 0),
  CONSTRAINT catalog_bundle_prices_amount_kind_check
    CHECK (amount_kind IN ('gross', 'net')),
  CONSTRAINT catalog_bundle_prices_validity_check
    CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT catalog_bundle_prices_window_key
    UNIQUE (bundle_id, price_list_id, mode, valid_from)
);

CREATE INDEX idx_catalog_bundle_prices_lookup
  ON public.catalog_bundle_prices (bundle_id, price_list_id, mode, active);

COMMENT ON TABLE public.catalog_bundles IS
  'A sellable set of catalogue units carrying one operator-set price. Inert until a later slice reads it.';
COMMENT ON COLUMN public.catalog_bundles.code IS
  'Stable operator-facing identifier for one bundle. Assigned once and never regenerated.';
COMMENT ON COLUMN public.catalog_bundles.composition_constraint IS
  'Opaque rules envelope: a kind, a version and a payload the platform stores and never interprets. Empty means unconstrained.';
COMMENT ON COLUMN public.catalog_bundles.fulfillment_mode IS
  'How the bundle reaches a customer: expanded into its components, or handled as one pre-packed unit. Only the first has a runtime today.';
COMMENT ON TABLE public.catalog_bundle_components IS
  'Bill of materials: one row per catalogue unit in a bundle. Multiplicity is the quantity column, never repeated rows.';
COMMENT ON TABLE public.catalog_bundle_prices IS
  'One operator-set amount per bundle, price list, purchase mode and validity start. Currency comes from the price list and is not duplicated here.';
COMMENT ON COLUMN public.catalog_bundle_prices.target_price_minor IS
  'The amount the whole bundle should cost, in the minor unit of the price list currency. A stored decision, not a figure derived from component prices.';
