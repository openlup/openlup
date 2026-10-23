# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.23.0]

- Publishable on the npm `latest` dist-tag as `0.23.0`, from tag
  `openlup-core-v0.23.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.22.0` as part of the complete `0.23.0` package set.

Migration: upgrade the complete set together for exact internal peers; core introduces no API or schema migration.

### Known limitations

The fulfillment status map retains localized adopter labels; hosts still need injected labels or internationalization keys.

## [0.22.0]

- Publishable on the npm `latest` dist-tag as `0.22.0`, from tag
  `openlup-core-v0.22.0`.

- Add pure fulfillment status, tracking-progress, current-parcel and canonical
  fact-parser helpers to the existing `./fulfillment` subpath. Generic fact types
  retain their names; narrowed fact aliases use the `Canonical` prefix. New
  fulfillment re-exports carry the same `@beta` annotation as existing facts.

Migration: existing platform fulfillment imports remain compatible re-exports;
no application import or schema migration is required.

### Known limitations

- `FULFILLMENT_STATUS_MAP` carries localized adopter labels. Replace them with host-injected labels or internationalization keys before any stable-framework claim.

## [0.21.0]

- Publishable on the npm `latest` dist-tag as `0.21.0`, from tag
  `openlup-core-v0.21.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.20.0` as part of the complete `0.21.0` package set.

Migration: upgrade the complete set together; core introduces no API or schema migration in this release.
