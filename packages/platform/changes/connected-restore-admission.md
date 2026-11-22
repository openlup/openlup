### Shared PostgreSQL restore admission checks

The experimental `@openlup/platform/portability` subpath exposes
`assertCompatiblePostgresPacket` for pure packet validation and
`assertCompatiblePostgresTarget` for checking the live table descriptors and
enabled insert triggers under the caller's existing transaction locks.
The connected-store adapter uses these checks before temporary owner grants.
