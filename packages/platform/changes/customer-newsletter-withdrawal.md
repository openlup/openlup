- Portable PostgreSQL account newsletter opt-out now atomically denies newsletter
  permission, including repeated opt-outs, while preserving suppression and other
  purposes. Opting back in changes the account preference but leaves the evaluator
  refusing until an explicit grant is recorded separately.
- An opt-out recorded before this version does not change an existing `granted`
  row until an operator runs the idempotent upgrade statement in the data and
  migrations guide. The account setter schedules no external provider sync, and
  a denial stays tied to the old email fingerprint after an email change.
