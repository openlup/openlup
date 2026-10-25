# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.26.0]

- Publishable on the npm `latest` dist-tag as `0.26.0`, from tag
  `openlup-core-v0.26.0`.

## [0.25.0]

- Publishable on the npm `latest` dist-tag as `0.25.0`, from tag
  `openlup-core-v0.25.0`.

- Keep active subscriptions unchanged when the retry ladder is exhausted; the compatibility function emits no pause event and retains historical paused-row recovery.

Migration notes: Exhaustion no longer changes an active subscription to paused. Existing paused records are not rewritten; explicit customer lifecycle commands and historical recovery remain separate.

## [0.24.0]

- Publishable on the npm `latest` dist-tag as `0.24.0`, from tag
  `openlup-core-v0.24.0`.

- Require Zod `^4.6.6` to fix GHSA-mrhx-c7xc-m3w5; oversized constrained
  collections fail before element validation accumulates errors. Public exports
  and accepted bounded inputs are unchanged.

- Republish the remaining APIs, runtime behavior and shipped SQL unchanged from `0.23.0`.

Migration: upgrade the complete set together for exact internal peers; core introduces no API or schema migration. The Zod floor above changes validation of oversized constrained collections.

### Known limitations

The fulfillment status map retains localized adopter labels; hosts still need injected labels or internationalization keys.
