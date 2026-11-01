# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.35.0]

- Publishable on the npm `latest` dist-tag as `0.35.0`, from tag
  `openlup-core-v0.35.0`.

## [0.34.0]

- Publishable on the npm `latest` dist-tag as `0.34.0`, from tag
  `openlup-core-v0.34.0`.

- Republish with the complete `0.34.0` package set for Platform’s optional
  measurement consent policies. Core runtime, exports and SQL are unchanged.

## [0.33.0]

- Publishable on the npm `latest` dist-tag as `0.33.0`, from tag
  `openlup-core-v0.33.0`.

- Improve installed context results by separating nested Markdown sections,
  suppressing copied excerpts when their installed owner page is also found,
  and adding opt-in `--package-code` source search. The small generated context
  now includes migration, idempotency, provider-adapter and
  subscription/delivery owner routes.
