-- Public platform shipment rail: an order may hold more than one shipment.
-- Three columns, two rules, one constraint swap, one index, no behaviour.
--
-- WHAT THIS FORWARD SHIPS. `fulfillment_shipments` carried `UNIQUE (order_id)`, which said that an
-- order is fulfilled once and only once. That is true of the ordinary case and false of the case
-- every shop eventually meets: the parcel was lost, arrived damaged, or came back undelivered, and
-- the operator has to send another one. This forward replaces the single-column key with
-- `UNIQUE (order_id, sequence_no)` and gives a second shipment the three facts it needs to be more
-- than an accidental duplicate -- its ordinal within the order, the shipment it stands in for, and
-- why it was sent.
--
-- WHY IT IS A SECOND SHIPMENT AND NOT A SECOND ORDER. The buyer bought once. Making the replacement
-- a new order would produce a second document trail, a second settlement and a second identifier
-- the buyer never agreed to; every one of those is a defect a support desk then has to undo. The
-- order stays the commercial fact and the shipment becomes the repeatable one, which is the same
-- direction the lifecycle already points: shipments already carry their own state machine, their own
-- external references and their own operation ledger, all keyed on the shipment rather than on the
-- order.
--
-- WHY THE ORDINAL RATHER THAN A FLAG. A boolean `is_replacement` cannot answer the third question --
-- the second replacement -- and a timestamp cannot be made unique without also making it a key.
-- `sequence_no` is derivable, orderable and stable, so a caller can compute the external identifier
-- for a shipment without inventing one, and the unique key above refuses the same ordinal twice.
--
-- WHY THE SHAPE RULE IS NOT OPTIONAL. Dropping a unique constraint gives up a real defence: today a
-- stray second insert for one order is refused by the database. The shape rule is what is put in its
-- place. An ordinal of 0 is the original and must carry neither a predecessor nor a reason; an
-- ordinal above 0 must carry both. A stray insert that simply omits the ordinal therefore still
-- takes 0 and still collides, exactly as it did before this forward, and writing a second shipment
-- on purpose now means filling three columns consistently.
--
-- WHY IT CHANGES NOTHING TODAY. `sequence_no` takes 0 by column default, so the new key is
-- constraint-for-constraint as strict as the one it replaces for every row that exists. No function
-- in this catalogue writes an ordinal, and none needs a repair to read one: every lifecycle function
-- is keyed on the shipment identifier, the notification suppressor is an `EXISTS`, and the retention
-- reads that join a shipment to its order either sit inside `SELECT EXISTS (...)` or collapse under
-- an order-scoped idempotency key. This forward is therefore the transition and only the transition.
--
-- NOT VALID on both rules follows this catalogue's convention for a constraint added to a table that
-- may already carry rows: every write from this statement on is checked, no blocking scan is taken,
-- and every pre-existing row satisfies the rule trivially because its ordinal is 0 and both new
-- columns are NULL.
--
-- WHAT THIS FORWARD DELIBERATELY DOES NOT SHIP:
--   * no way to create the second shipment. `fulfillment_create_shipment` replays through the
--     operation ledger and opens exactly one shipment per idempotency key; it is untouched, and
--     until an operator command is authored nothing can reach an ordinal above 0;
--   * no external identifier scheme. What a deployment calls the replacement at its integration is
--     derivable from the ordinal, and deriving it is the host application's business;
--   * no refund, return or restock consequence. Sending a replacement says nothing about the money;
--   * no reader. Nothing in this catalogue selects the three columns, and the resolution order the
--     index carries is a hint for a future reader, not a policy this forward enforces.

ALTER TABLE public.fulfillment_shipments
  ADD COLUMN sequence_no smallint NOT NULL DEFAULT 0,
  ADD COLUMN replaces_shipment_id uuid,
  ADD COLUMN replacement_reason text;

-- SET NULL rather than CASCADE: erasing a superseded shipment must not erase the record that its
-- successor was sent, and the ordinal keeps the successor legible on its own.
ALTER TABLE public.fulfillment_shipments
  ADD CONSTRAINT fulfillment_shipments_replaces_shipment_id_fkey
  FOREIGN KEY (replaces_shipment_id) REFERENCES public.fulfillment_shipments(id)
  ON DELETE SET NULL NOT VALID;

ALTER TABLE public.fulfillment_shipments
  ADD CONSTRAINT fulfillment_shipments_replacement_reason_check CHECK (
    replacement_reason IS NULL
    OR replacement_reason IN ('damaged', 'lost', 'returned_undelivered', 'other')
  ) NOT VALID;

-- The rule that replaces the guarantee the dropped key was giving.
ALTER TABLE public.fulfillment_shipments
  ADD CONSTRAINT fulfillment_shipments_replacement_shape_check CHECK (
    (sequence_no = 0 AND replaces_shipment_id IS NULL AND replacement_reason IS NULL)
    OR (sequence_no > 0 AND replaces_shipment_id IS NOT NULL AND replacement_reason IS NOT NULL)
  ) NOT VALID;

ALTER TABLE public.fulfillment_shipments
  DROP CONSTRAINT fulfillment_shipments_order_id_key;

-- The unique key swap is this migration's whole point and cannot be expressed without
-- building a unique index. It is spelled as a unique INDEX rather than a UNIQUE CONSTRAINT
-- because that is this repository's established shape for in-transaction uniqueness -- it
-- enforces identically and needs only the one accepted ignore. CONCURRENTLY is unavailable:
-- the migration runner wraps each file in a transaction, which is what the squawk gate assumes.
-- The build cannot find a duplicate: `sequence_no` is NOT NULL DEFAULT 0, so every
-- pre-existing row backfills to the same ordinal and the new key is exactly as strict as the
-- one it replaces.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_shipments_order_id_sequence_no_key
  ON public.fulfillment_shipments (order_id, sequence_no);
COMMENT ON COLUMN public.fulfillment_shipments.sequence_no IS
  'Ordinal of this shipment within its order. 0 is the original; a replacement takes the next free ordinal. Externally derivable and stable; the buyer never sees it.';
COMMENT ON COLUMN public.fulfillment_shipments.replaces_shipment_id IS
  'The shipment this one stands in for. This is the linkage truth; never recover it by parsing an external identifier.';
COMMENT ON COLUMN public.fulfillment_shipments.replacement_reason IS
  'Why the replacement was sent: damaged, lost, returned_undelivered, other. NULL on the original.';
