# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.37.0]

- Publishable on the npm `latest` dist-tag as `0.37.0`, from tag
  `openlup-core-v0.37.0`.

- Ship declaration maps that navigate to the packaged TypeScript sources,
  consumer-first installation guidance and release-tagged agent source citations.
- Allow Node `>=24` while
  retaining Node 24 for contributor verification. Pin exact package versions and
  upgrade the OpenLup set together.
- The tool-only installed context lookup accepts release citations only for its
  own package and installed version, and deduplicates shared canonical owners
  across the matching package set without fetching links.

- Recognize `commerce.settlement.settled`, already emitted by the platform settlement rail, in `PLATFORM_EVENT_VOCABULARY`. A known settlement fact without a registered consumer can remain pending without blocking a later paid receipt on the same order aggregate. This adds no handler, acknowledgement, delivery or SQL seed.

Migration:

Hosts using the complete vocabulary for readiness must supply an explicit owned `ignored` or `dormant` exemption for this type when they select no consumer. The claim allowlist still derives from handlers; readiness refusal for an unhandled, unexempted type is unchanged. No schema, grant or package-version change is needed in this source fix.

## [0.36.0]

- Publishable on the npm `latest` dist-tag as `0.36.0`, from tag
  `openlup-core-v0.36.0`.

## [0.35.0]

- Publishable on the npm `latest` dist-tag as `0.35.0`, from tag
  `openlup-core-v0.35.0`.
