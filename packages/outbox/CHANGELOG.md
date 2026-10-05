# Changelog

## [Unreleased]

## [0.13.0]

- Publishable on the npm `latest` dist-tag as `0.13.0`, from tag
  `openlup-outbox-v0.13.0`.

- Introduce the experimental transactional outbox rail with bare dispatch, registry composition, typed-payload validation and lease-bound dispatch/prune schedules.
- Ship the default PostgreSQL store and fresh-install schema; terminal compaction preserves dedupe identities and leaves uncertain discard ages untouched.

Migration: before, an application owned its copied dispatch engine. After, compose the package and keep application-owned drivers, handlers, recovery and producer transactions; apply the shipped baseline only to a fresh database through your migration chain, then admit the exact candidate before effects. Upgrade the whole package set when released.
