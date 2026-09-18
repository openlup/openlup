-- Public platform order source axis: the order row learns which selling surface produced it.
-- Three columns, one referential link, one coherence rule, two indexes, no behaviour.
--
-- WHAT THIS FORWARD SHIPS. The previous forward registered channels and then said, in as many
-- words, that it deliberately did not ship "a channel column on the order row, and no join from an
-- order to a channel. Attribution is its own capability with its own forward". This is that
-- forward. After it, an order can name the surface it came from, and the kernel can refuse a row
-- that names one incoherently. Nothing reads the columns yet and nothing writes them; the storefront
-- default is what every existing row already is.
--
-- WHY COLUMNS RATHER THAN AN ASSOCIATION TABLE. Origin is not an annotation. It is the fact that
-- decides which invoice policy applies, who is permitted to contact the buyer, and how the money
-- settles -- all three of which the registry forward stored per channel. Reaching them through an
-- association row makes each of those an outer join that may legally return nothing, so every
-- consumer would have to invent a fallback, and the fallbacks would disagree. Three typed columns
-- on the order let the constraint below refuse the incoherent state outright, which is the one
-- place refusing it is cheap.
--
-- WHY THE DEFAULT IS BOTH SAFE AND TRUE. `source_kind` defaults to 'storefront', which is the slug
-- and kind the registry forward seeds, and which describes every order any deployment has taken up
-- to this point -- a kernel before this forward had exactly one place a sale could happen. The
-- default is a constant, so an instance that already carries orders materialises the column as
-- metadata rather than rewriting its table, and a freshly booted one has nothing to materialise.
-- This is why NOT NULL is admissible here where the hold rail's `client_id` had to stay nullable:
-- that column had no default to give existing rows, and this one does.
--
-- THE UNIQUE INDEX IS THE IDEMPOTENCY BACKBONE, AND IT IS THE REASON THIS FORWARD EXISTS NOW. Any
-- loop that imports orders from an external surface is a polling loop, and a poll that overlaps its
-- predecessor re-delivers rows it already delivered. `(source_channel_id, source_order_ref)` unique
-- within a channel is what turns the second delivery into a conflict the importer can resolve
-- instead of a second order the customer is charged for. It has to exist before the first importer
-- does. `source_order_ref` is opaque: this kernel stores it and compares it for equality, and never
-- parses it, because its format is the far side's business.
--
-- WHERE THE SEMANTICS COME FROM, AND EVERY DEPARTURE. The shape below was derived from the managed
-- chain's axis authored in the same wave. Two departures, each named, because a silent one is how a
-- kernel and its origin quietly stop being the same machine:
--
--   1. `ALTER` IS UNCONDITIONAL AND EVERY CONSTRAINT IS NAMED. The managed twin guards each column
--      with `IF NOT EXISTS` and states two of its CHECKs inline, because it is written for a
--      chronological chain that may meet a partially-applied database. A manifest-ordered forward
--      runs exactly once against a known prefix, so a conditional `ADD COLUMN` there would hide the
--      drift the migration ledger exists to catch, and an inline CHECK would take a generated name
--      no later forward could address.
--   2. NO LINTER DIRECTIVES. The managed twin carries per-statement suppressions for the lock
--      advisory its own apply pipeline raises on a non-concurrent index build. Those name a tool
--      this catalogue does not run. The underlying judgement is carried instead as the sentence
--      below, which is the part an adopter actually needs.
--
-- LOCKING, STATED RATHER THAN SUPPRESSED. Both indexes are built without CONCURRENTLY, because a
-- forward is applied inside a transaction and CONCURRENTLY cannot run in one. The unique index is
-- partial on a column this same forward introduces, so it is empty at creation on every instance
-- and has nothing to scan. The second spans a column whose value is the constant default on every
-- existing row; an adopter carrying a very large order history should expect that build to hold a
-- write lock for its duration, and may instead create it out of band.
--
-- WHAT THIS FORWARD DELIBERATELY DOES NOT SHIP:
--   * no writer. Nothing in this catalogue sets `source_kind` to anything but its default, and no
--     forward here creates a row that names a channel;
--   * no reader. No view, no function and no index-backed query in this catalogue selects these
--     columns; a host application is what surfaces them;
--   * no import loop, no reconciliation, no de-duplication policy beyond the constraint the unique
--     index expresses. What an importer does when it meets that conflict is the importer's design;
--   * no per-channel pricing, tax, fee or payout arithmetic. The channel is named on the order and
--     nothing is derived from it here;
--   * no backfill. Every existing row takes the default, which is the true answer for it.

ALTER TABLE public.commerce_orders
  ADD COLUMN source_kind text NOT NULL DEFAULT 'storefront',
  ADD COLUMN source_channel_id uuid,
  ADD COLUMN source_order_ref text;

ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_source_kind_check
  CHECK (btrim(source_kind) <> '' AND char_length(source_kind) <= 32) NOT VALID;

ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_source_order_ref_check
  CHECK (
    source_order_ref IS NULL
    OR (btrim(source_order_ref) <> '' AND char_length(source_order_ref) <= 128)
  ) NOT VALID;

-- RESTRICT rather than CASCADE: a channel that still owns orders is retired, never erased out from
-- under the rows that name it. NOT VALID follows this catalogue's convention for a constraint on a
-- table that may already carry rows -- every new write is checked from this statement on, no
-- blocking scan is taken, and the column it covers is NULL on every row that predates it.
ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_source_channel_id_fkey
  FOREIGN KEY (source_channel_id) REFERENCES public.sales_channels(id)
  ON DELETE RESTRICT NOT VALID;

-- The coherence rule, and the whole reason the axis is three columns instead of one: a storefront
-- order has no external counterpart to point at, and an order from anywhere else is unusable
-- without both the surface and that surface's own identifier for it. Half-populated is the state
-- an importer produces when it fails midway, and this is where that state stops.
ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_source_axis_coherent_check CHECK (
    (source_kind = 'storefront' AND source_channel_id IS NULL AND source_order_ref IS NULL)
    OR (source_kind <> 'storefront' AND source_channel_id IS NOT NULL AND source_order_ref IS NOT NULL)
  ) NOT VALID;

-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX commerce_orders_channel_source_uk
  ON public.commerce_orders (source_channel_id, source_order_ref)
  WHERE source_channel_id IS NOT NULL;

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX commerce_orders_source_kind_created_idx
  ON public.commerce_orders (source_kind, created_at DESC);

COMMENT ON COLUMN public.commerce_orders.source_kind IS
  'Which class of selling surface produced this order. Defaults to the storefront, which is what every row predating the channel registry is.';
COMMENT ON COLUMN public.commerce_orders.source_channel_id IS
  'The registered channel this order came from. NULL exactly when source_kind is the storefront.';
COMMENT ON COLUMN public.commerce_orders.source_order_ref IS
  'The originating surface own identifier for this order. Opaque; stored and compared, never parsed. Unique within its channel so a repeated import conflicts instead of duplicating.';
