-- Public platform channel delivery selection: a selling surface declares how its parcels ship.
--
-- WHAT THIS FORWARD SHIPS. One column on `sales_channels` and one shape constraint on it. The
-- registry forward taught this kernel that a sale can come from a surface other than the shop's
-- own; nothing on that surface said how the goods then leave the building. This does: a surface
-- carries the delivery selection its orders are shipped under, written in the same object shape an
-- order carries on its own metadata, so the two can be compared without translation.
--
-- WHY A KERNEL THAT WRITES NO ORDER STILL OWNS THIS. The order ingest forward stated the boundary
-- plainly: this kernel ships no order writer, because the identity, event-log and payment-control
-- relations such a writer needs are absent here. That boundary is unchanged and this forward does
-- not cross it. What it ships is a DECLARATION, and a declaration is portable even when the code
-- that consumes it is not: the same table on this kernel already carries `pull_cursor` for a puller
-- that does not exist here either. A host application reads this column when it creates an order,
-- exactly as the private chain's ingest function does, and the shape it must honour is stated here
-- rather than reinvented per adopter.
--
-- WHY THE SHAPE CHECK ONLY CHECKS SHAPE. `providerKind` must be present and non-blank, and nothing
-- else is asserted. Which shipping providers exist, and which service codes each accepts, is
-- knowledge that changes whenever a deployment signs a carrier; a database that enumerated them
-- would demand a migration for a commercial decision. The host application owns the vocabulary and
-- this kernel owns only the guarantee that the field an order router reads is actually there.
--
-- WHY NULL IS ALLOWED HERE AND STILL MEANS "NOT READY". The column is nullable because a surface is
-- registered before it is configured, and a forward that demanded a value would be unappliable
-- against a catalogue that already has rows. The rule that an order is refused while it is NULL is
-- an order-writer rule, and the order writer is not on this chain -- so this forward states the
-- shape and the intent, and leaves the refusal to whoever writes the order. Said out loud rather
-- than implied: ON THIS KERNEL A NULL HERE IS NOT ENFORCED BY ANYTHING.
--
-- DEPARTURES FROM THE PRIVATE CHAIN, NAMED RATHER THAN SILENT.
--   1. NO ROW-LEVEL SECURITY, NO POLICY, NO GRANT/REVOKE, matching every forward in this catalogue.
--      None of the private chain's principals exists here.
--   2. THE ORDER WRITER IS NOT REPLACED. The private twin's second half copies this column onto the
--      order it writes and refuses when it is absent. Here that statement has no subject; the
--      function it would replace has never existed on this chain.
--   3. `ALTER` IS UNCONDITIONAL AND THE CONSTRAINT IS NAMED, because a manifest-ordered forward runs
--      exactly once against a known prefix, and `IF NOT EXISTS` there would hide drift instead of
--      surviving it.

ALTER TABLE public.sales_channels
  ADD COLUMN delivery_selection jsonb;

ALTER TABLE public.sales_channels
  ADD CONSTRAINT sales_channels_delivery_selection_shape CHECK (
    delivery_selection IS NULL
    OR (
      jsonb_typeof(delivery_selection) = 'object'
      AND NULLIF(btrim(COALESCE(delivery_selection->>'providerKind', '')), '') IS NOT NULL
    )
  ) NOT VALID;

COMMENT ON COLUMN public.sales_channels.delivery_selection IS
  'How parcels sold on this surface ship, in the same object shape an order carries on its own metadata. The host application copies it onto every order it creates for this surface; a surface that has not declared one has not said how it ships, and an order writer should refuse rather than choose a carrier on the buyer''s behalf without saying so.';
