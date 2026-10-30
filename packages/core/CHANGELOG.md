# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.33.0]

- Publishable on the npm `latest` dist-tag as `0.33.0`, from tag
  `openlup-core-v0.33.0`.

- Improve installed context results by separating nested Markdown sections,
  suppressing copied excerpts when their installed owner page is also found,
  and adding opt-in `--package-code` source search. The small generated context
  now includes migration, idempotency, provider-adapter and
  subscription/delivery owner routes.

## [0.32.0]

- Publishable on the npm `latest` dist-tag as `0.32.0`, from tag
  `openlup-core-v0.32.0`.

- Clarify that the payment retry-count helper enforces only its local numeric
  bound and does not establish retry permission or compliance; runtime behavior
  is unchanged.
- Add the Node-only `openlup-context` bin for offline lookup across installed
  package documentation. It returns source citations, supports JSON results and
  an optional bounded local code scan, and adds no runtime dependency. A root
  `AGENT_CONTEXT.md` packages excerpts of canonical guidance with source paths,
  line ranges and excerpt digests; check cited source before relying on them.

## [0.31.0]

- Publishable on the npm `latest` dist-tag as `0.31.0`, from tag
  `openlup-core-v0.31.0`.
