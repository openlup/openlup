### Fixed

- The migration runner refused its own ledger on PostgreSQL 16.16, 17.12 and later minors, which set attribute options on new columns. It now accepts only the numeric `pg_attver` version marker and still refuses any other attribute option.

### Known issue in 0.38.0 and earlier

- Fresh installations on those PostgreSQL minors are refused at the first migration. Upgrade to this release before installing.
