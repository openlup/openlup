-- NULL preserves the legacy gross amount basis.
ALTER TABLE public.price_lists ADD COLUMN amount_basis text;
ALTER TABLE public.price_lists ADD CONSTRAINT price_lists_basis_check CHECK (amount_basis IN ('tax_inclusive', 'tax_exclusive'));
