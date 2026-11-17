# Changelog

## [Unreleased]

## [1.0.1]

- Publishable on the npm `latest` dist-tag as `1.0.1`, from tag
  `openlup-outbox-v1.0.1`.

- Republish unchanged runtime, exports and SQL with the exact `@openlup/core@1.0.1`
  peer. The packaged starter migration supersedes published 1.0.0 after failed
  starter-upgrade qualification; qualification of 1.0.1 is recorded after publication.

## [1.0.0]

- Publishable on the npm `latest` dist-tag as `1.0.0`, from tag
  `openlup-outbox-v1.0.0`.

Declare per-subpath stable, experimental and test-support policies for the coherent 1.0.0 package set. Stable APIs follow SemVer with open unions and literal sets; symbols tagged `@experimental` remain outside the stable promise. Consumer evidence is explicitly first-party.

Migration: keep a default branch for unknown union and literal-set values. Check the generated maturity table for experimental and test-support subpaths before upgrading. No runtime behavior or package export changes.
- Allow intentional API snapshot updates with a new or modified package change fragment; retain changed `CHANGELOG.md` as a legacy route. Fragment contents are validated during release preparation.

## [0.43.0]

- Publishable on the npm `latest` dist-tag as `0.43.0`, from tag
  `openlup-outbox-v0.43.0`.

- Republish unchanged Outbox runtime, exports and SQL with the complete `0.43.0`
  package set and exact `@openlup/core@0.43.0` peer.
