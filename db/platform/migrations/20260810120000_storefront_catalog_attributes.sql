-- Public platform catalogue attributes: the three columns a public listing needs.
--
-- Authored from scratch for this delta. The read-parity forward that created these two
-- relations deliberately left every sellable attribute out, on the ruling that the slice
-- which actually executes them would author them as its own forward. This is that slice,
-- and the demand is no longer a guess: the shipped response contract was validated against
-- an assembly read out of a live kernel database, and it refused with thirteen issues over
-- five field paths -- a product line, a positive net weight per sellable unit, a non-empty
-- declared composition with at least one entry, and a non-empty format label. Every one of
-- them is `too_small`, which is the schema saying "you gave me nothing", not "you gave me
-- the wrong thing". Nothing here is optional decoration: without these three columns the
-- listing route answers 502 for an operator's own rows, on any schema.
--
-- WHY THESE THREE NAMES AND NOT THE FIVE THAT WERE SIZED. The neutral projection is served
-- to BOTH bundles by the discovery harness, so a column this kernel invents and the managed
-- chain lacks would fail the managed half of the proof on contact. The names below are the
-- ones that chain already carries with a compatible type and, critically, with no foreign
-- key. Two further names were sized and are refused here: on the managed chain both are
-- foreign keys into lookup relations of sellable-unit vocabulary, so honouring them would
-- force this kernel to grow two dictionaries of exactly the domain language the public
-- platform must not own. The packaging unit therefore stays at the assembly's own default
-- and the calorific figures stay absent, which is why the composition this platform can
-- express is a list of declared entries and not the richer card set an overlay keeps beside
-- it.
--
-- WHY NULLABILITY IS SPENT AS A DEFAULT AND NOT AS NULL. Every column arrives NOT NULL with
-- a neutral zero value -- an empty array, an empty object, a zero integer -- so an already
-- populated deployment boots unchanged and no read has to branch on absence. A zero weight
-- and an empty composition are still refused by the response contract, which is the correct
-- outcome: the platform now HAS somewhere to put the answer, and an operator who has not
-- put one there has published nothing, rather than published something broken. No CHECK is
-- added, for the same reason the managed chain has none on these columns -- the shape that
-- matters is enforced by the response contract, one layer up, where it can name the field.
--
-- NO FUNCTION, NO TRIGGER, NO POLICY, NO GRANT, NO INDEX. Three ALTER TABLE statements and
-- three comments. The read path that consumes them is a projection widening in application
-- code, not a database behaviour.

ALTER TABLE public.catalog_products
  ADD COLUMN ingredients text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN marketing_content jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.catalog_skus
  ADD COLUMN net_weight_g integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.catalog_products.ingredients IS
  'Declared composition, one free-text entry per line. An entry may end in a percentage share; the read splits it, and keeps the whole entry as the label when it does not.';
COMMENT ON COLUMN public.catalog_products.marketing_content IS
  'Front-of-house copy the platform stores and never interprets. The public read looks up two keys in it: line_name and format_marketing_copy.';
COMMENT ON COLUMN public.catalog_skus.net_weight_g IS
  'Net weight of one sellable unit, in grams. Zero means the operator has not declared one, and the response contract refuses such a unit.';
