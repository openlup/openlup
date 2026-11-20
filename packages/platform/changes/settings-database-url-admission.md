### Connected settings require an explicit PostgreSQL target

- For connected `openlup settings show` and `preview`, supply a canonical PostgreSQL URL with one TCP host, a username and one non-empty database path segment. For the exact URL rules, see the reader guide, Configure settings, section “Read the effective behavior”.
- The URL alone sets the host, port, username, password, database and TLS mode. An omitted `sslmode` selects plaintext. `PG`-prefixed environment variables and password files cannot change those settings. Other driver variables still apply. Both commands refuse when the driver loads the native client. Unset `NODE_PG_FORCE_NATIVE` to use the JavaScript client.
- The experimental settings host's `bind` input now carries the admitted connection options in `database`, replacing the raw `databaseUrl` string.
