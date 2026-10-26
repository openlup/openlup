# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.27.0]

- Publishable on the npm `latest` dist-tag as `0.27.0`, from tag
  `openlup-core-v0.27.0`.

## [0.26.0]

- Publishable on the npm `latest` dist-tag as `0.26.0`, from tag
  `openlup-core-v0.26.0`.

## [0.25.0]

- Publishable on the npm `latest` dist-tag as `0.25.0`, from tag
  `openlup-core-v0.25.0`.

- Keep active subscriptions unchanged when the retry ladder is exhausted; the compatibility function emits no pause event and retains historical paused-row recovery.

Migration notes: Exhaustion no longer changes an active subscription to paused. Existing paused records are not rewritten; explicit customer lifecycle commands and historical recovery remain separate.
