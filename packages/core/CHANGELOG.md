# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

- Export `MAX_CADENCE_DAYS = 3660` from `./subscription` for fresh platform cadence
  admission. The ten-year whole-day bound avoids the timestamp and
  settlement integer overflows admitted by the former PostgreSQL integer maximum,
  with lateness margin. Adopters still choose their offered cadences.

Migration: fresh quotes, drafts and editor results above 3660 days now refuse;
historical transport, stored data and completed receipts retain integer
representation. Completed editor, native draft and renewal receipts replay before
current limits. Checkout-command and saga-fallback paths can quote before replay
and may still refuse stored cadence above 3660; this affects unreleased development
data only and remains a follow-up.

## [0.43.0]

- Publishable on the npm `latest` dist-tag as `0.43.0`, from tag
  `openlup-core-v0.43.0`.

- Keep the shared fulfillment status facade and generated JSON neutral; provider dictionaries own translation. Canonical `packed` remains preferred and every historical display alias keeps its customer-step result.

Migration: shared status-map JSON no longer carries adapter trace columns. Consumers needing provider translation use adapter-owned dictionaries. Existing status tokens, ranks, effects and customer steps are unchanged.

## [0.42.0]

- Publishable on the npm `latest` dist-tag as `0.42.0`, from tag
  `openlup-core-v0.42.0`.

- Republish unchanged Core runtime, exports and SQL with the complete `0.42.0`
  package set. The reader guide adds the native payments upgrade notes.

## [0.41.0]

- Publishable on the npm `latest` dist-tag as `0.41.0`, from tag
  `openlup-core-v0.41.0`.

- Republish unchanged Core runtime, exports and SQL with the complete `0.41.0`
  package set. The reader guide lists Platform's new `./payments/testing` subpath.
