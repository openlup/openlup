-- Validate only the eight acquisition lifecycle constraints installed as
-- NOT VALID by the immediately preceding partner-acquisition forward. Keeping
-- validation in this later transaction avoids taking the stronger same-
-- transaction read lock while preserving the exact C-D23A and C-D23B rows.

ALTER TABLE acquisition_private.cases
  VALIDATE CONSTRAINT acquisition_case_source_check;
ALTER TABLE acquisition_private.cases
  VALIDATE CONSTRAINT acquisition_case_lifecycle_check;
ALTER TABLE acquisition_private.cases
  VALIDATE CONSTRAINT acquisition_case_source_path_check;
ALTER TABLE acquisition_private.cases
  VALIDATE CONSTRAINT acquisition_case_address_shape_check;

ALTER TABLE acquisition_private.commands
  VALIDATE CONSTRAINT acquisition_commands_scope_check;
ALTER TABLE acquisition_private.commands
  VALIDATE CONSTRAINT acquisition_command_result_check;

ALTER TABLE acquisition_private.audit
  VALIDATE CONSTRAINT acquisition_audit_from_lifecycle_check;
ALTER TABLE acquisition_private.audit
  VALIDATE CONSTRAINT acquisition_audit_to_lifecycle_check;
