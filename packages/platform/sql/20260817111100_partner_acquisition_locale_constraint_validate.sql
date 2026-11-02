-- Validate the source-aware acquisition locale constraint added by the
-- preceding forward in a separate transaction.

ALTER TABLE acquisition_private.cases
  VALIDATE CONSTRAINT acquisition_case_locale_check;
