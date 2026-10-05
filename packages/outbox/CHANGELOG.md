# Changelog

## [Unreleased]

## [0.13.1]

- Publishable on the npm `latest` dist-tag as `0.13.1`, from tag
  `openlup-outbox-v0.13.1`.

- Build the exact workspace core peer before packing outbox on a fresh publication runner. The `0.13.0` outbox publication stopped before npm; `0.13.1` restores the complete package set without changing APIs, runtime behavior or shipped SQL.

## [0.13.0]

- Publishable on the npm `latest` dist-tag as `0.13.0`, from tag
  `openlup-outbox-v0.13.0`.

- Introduce the experimental transactional outbox rail with bare dispatch, registry composition, typed-payload validation and lease-bound dispatch/prune schedules.
- Ship the default PostgreSQL store and fresh-install schema; terminal compaction preserves dedupe identities and leaves uncertain discard ages untouched.

Migration: before, an application owned its copied dispatch engine. After, compose the package and keep application-owned drivers, handlers, recovery and producer transactions; apply the shipped baseline only to a fresh database through your migration chain, then admit the exact candidate before effects. Upgrade the whole package set when released.
