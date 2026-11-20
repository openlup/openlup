### Connected settings require an explicit PostgreSQL target

- For connected `openlup settings show` and `preview`, supply a canonical PostgreSQL URL with one TCP host, a username and one non-empty database path segment. For the exact URL rules, see [Configure settings, “Read the effective behavior”](../how-to/operate/configure-settings.md#read-the-effective-behavior).
- Set the target and TLS mode in the URL. An omitted `sslmode` selects plaintext. The launcher's pool ignores `PG`-prefixed environment variables and skips password files. Connected `show` and `preview` refuse when `NODE_PG_FORCE_NATIVE` selects the native client.
- The experimental settings host's `bind` input now carries the admitted connection options in `database`, replacing the raw `databaseUrl` string.
