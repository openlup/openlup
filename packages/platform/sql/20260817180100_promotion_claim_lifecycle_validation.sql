-- Validate promotion lifecycle constraints without coupling validation to DDL.
--
-- CHANGE. This forward validates the promoted order-item allocation constraint
-- and the draft-receipt invalidation constraint added as NOT VALID by the
-- preceding promotion-claim lifecycle forward.
--
-- WHY. Existing rows are structurally compatible, but validating in the same
-- transaction as ADD CONSTRAINT would retain the stronger DDL lock for the
-- table scan. A separate forward lets PostgreSQL validate under its lower-lock
-- validation path.
--
-- SAFETY. No data or routine body changes. New writes were already checked from
-- the moment the constraints were added; this pass only certifies historical
-- rows. Deployment order is fixed by the platform migration manifest.
--
-- ROLLBACK. No rollback is required. If validation finds legacy drift the
-- transaction aborts without changing data or constraint validity.

ALTER TABLE public.commerce_order_items
  VALIDATE CONSTRAINT commerce_order_items_promoted_allocation_check;

ALTER TABLE public.commerce_order_draft_receipts
  VALIDATE CONSTRAINT commerce_order_draft_receipts_invalidation_check;
