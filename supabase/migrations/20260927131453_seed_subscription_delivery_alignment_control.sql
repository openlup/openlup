-- Managed-only forward: restore the delivery-alignment control prerequisite.
-- The frozen schema-only baseline omitted the seed. With no singleton, readers
-- coalesce the mode to off, so a late delivery does not shift the next cycle
-- later. The subscription invariant requires auto_align on a fresh install.
-- Replay preserves an existing operator mode; this never resets that choice.
-- There is no portable twin: the delivery-alignment rail is managed-only.
-- This is a known portable capability gap, not installation-path parity.

INSERT INTO public.subscription_delivery_alignment_control (singleton, mode)
VALUES (true, 'auto_align')
ON CONFLICT (singleton) DO NOTHING;
