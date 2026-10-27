# Changelog history

Releases moved verbatim out of the packed `CHANGELOG.md`, which keeps the current release and the two previous ones.

## [0.26.0]

- Publishable on the npm `latest` dist-tag as `0.26.0`, from tag
  `openlup-outbox-v0.26.0`.
## [0.25.0]

- Publishable on the npm `latest` dist-tag as `0.25.0`, from tag
  `openlup-outbox-v0.25.0`.
## [0.24.0]

- Publishable on the npm `latest` dist-tag as `0.24.0`, from tag
  `openlup-outbox-v0.24.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.23.0` as part of the complete `0.24.0` package set.

Migration: upgrade the complete set together for exact internal peers; outbox introduces no API or schema migration.
## [0.23.0]

- Publishable on the npm `latest` dist-tag as `0.23.0`, from tag
  `openlup-outbox-v0.23.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.22.0` as part of the complete `0.23.0` package set.

Migration: upgrade the complete set together for exact internal peers; outbox introduces no API or schema migration.
## [0.22.0]

- Publishable on the npm `latest` dist-tag as `0.22.0`, from tag
  `openlup-outbox-v0.22.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.21.0` as part of the complete `0.22.0` package set.

Migration: upgrade the complete set together; outbox introduces no API or schema migration in this release.
## [0.21.0]

- Publishable on the npm `latest` dist-tag as `0.21.0`, from tag
  `openlup-outbox-v0.21.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.20.0` as part of the complete `0.21.0` package set.

Migration: upgrade the complete set together; outbox introduces no API or schema migration in this release.

## [0.20.0]

- Publishable on the npm `latest` dist-tag as `0.20.0`, from tag
  `openlup-outbox-v0.20.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.19.0` as part of the complete `0.20.0` package set.

Migration: upgrade the complete set together; outbox introduces no API or schema migration in this release.
## [0.19.0]

- Publishable on the npm `latest` dist-tag as `0.19.0`, from tag
  `openlup-outbox-v0.19.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.18.0` as part of the complete `0.19.0` package set.

Migration: upgrade the complete set together; outbox introduces no API or schema migration in this release.

## [0.18.0]

- Publishable on the npm `latest` dist-tag as `0.18.0`, from tag
  `openlup-outbox-v0.18.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.17.0`
  with the exact `@openlup/core` `0.18.0` peer pin in the complete set.

Migration: upgrade core and outbox together to `0.18.0`; no outbox API or schema
migration is introduced.

## [0.17.0]

- Publishable on the npm `latest` dist-tag as `0.17.0`, from tag
  `openlup-outbox-v0.17.0`.

- Republish with the exact `@openlup/core` `0.17.0` peer pin; APIs, runtime
  behavior and shipped SQL are unchanged from `0.16.0`.

Baseline evidence (2026-10-20): published `0.16.0` tarball 38,673 packed bytes,
SHA256 `1219a95952ae1dd8a7ceee80ad58b8ab5a9501527d5e20194b4c4db43d031ebd`.
The initial `0.16.0` release-gates baseline is retained under S1 option B.

## [0.16.0]

- Publishable on the npm `latest` dist-tag as `0.16.0`, from tag
  `openlup-outbox-v0.16.0`.

- Republish with the exact `@openlup/core` `0.16.0` peer pin; Outbox APIs, runtime behavior and shipped SQL are unchanged.

## [0.15.0]

- Publishable on the npm `latest` dist-tag as `0.15.0`, from tag
  `openlup-outbox-v0.15.0`.

- Republish with the exact `@openlup/core` `0.15.0` peer pin in the set that adds `@openlup/platform`; Outbox APIs, runtime behavior and shipped SQL are unchanged.

## [0.14.0]

- Publishable on the npm `latest` dist-tag as `0.14.0`, from tag
  `openlup-outbox-v0.14.0`.

- Republish with the exact `@openlup/core` `0.14.0` peer pin; Outbox APIs, runtime behavior and shipped SQL are unchanged.

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
