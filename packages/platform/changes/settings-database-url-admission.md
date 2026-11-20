### Connected settings require an explicit PostgreSQL target

- For `openlup settings show` and `preview`, supply a canonical PostgreSQL URL with one TCP host, a username and a single database path segment. Use DNS labels of at most 63 characters or write IPv4 octets in decimal without leading zeros. Use at most 63 UTF-8 bytes each for the decoded username and database name. The only supported query option is `sslmode` with `disable`, `require` or `verify-full`. Omitting it selects plaintext.
- For a connected read, the launcher removes `PG`-prefixed environment variables before using the driver and skips password files by supplying an empty password if the URL omits one. Connected settings commands refuse when `NODE_PG_FORCE_NATIVE` is nonempty. Unset it to use the JavaScript driver.
- The experimental `runSettingsCommand` host binding receives admitted connection options in `bind({ database })` in place of `bind({ databaseUrl })`.
