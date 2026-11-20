### Connected settings require an explicit PostgreSQL target

- For `openlup settings show` and `preview`, supply a PostgreSQL URL naming its TCP host, username and database. The only supported query option is `sslmode` with `disable`, `require` or `verify-full`. Omitting it selects plaintext.
- PostgreSQL connection defaults in the process environment do not affect these reads.
- The experimental `runSettingsCommand` host binding receives admitted connection options in `bind({ database })` in place of `bind({ databaseUrl })`.
