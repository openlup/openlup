-- Repair the shared acquisition locale constraint for the shipped partner kind.
--
-- WHAT THIS FORWARD SHIPS. It replaces the contradictory case-wide locale
-- check with a source-aware constraint: tester applications retain their
-- existing two-language contract and partner inquiries use the already-
-- persisted neutral BCP 47 sentinel. The replacement is installed NOT VALID;
-- the next forward validates existing rows outside this transaction.
--
-- WHAT IT DELIBERATELY DOES NOT SHIP. No row rewrite, submit-function change,
-- broader tester locale, new lifecycle, route, adapter, role or privilege.
--
-- OPERATIONAL CONTRACT. This is a forward-only correction of the merged
-- C-D23B schema contradiction. Disable partner acquisition if validation fails;
-- do not mutate historical case facts to force the check green.

ALTER TABLE acquisition_private.cases
  DROP CONSTRAINT acquisition_case_locale_check;

ALTER TABLE acquisition_private.cases
  ADD CONSTRAINT acquisition_case_locale_check CHECK (
    (source_kind = 'tester_application' AND locale IN ('en', 'pl'))
    OR (source_kind = 'partner_inquiry' AND locale = 'und')
  ) NOT VALID;
