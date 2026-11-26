### Authenticate the starter's runtime database login

The starter provisions an individual PostgreSQL runtime credential for each
Compose project. The runtime credential file must stay in owner-only
configuration. The starter validates it at start.

Migration: Stop the application, then run the updated `./lifecycle up` in the
same Compose project. [Starter guide](../docs/guide/how-to/build/customize-the-starter.md#database-login)
