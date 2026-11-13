# Versioning and stability

Use this policy to understand which application dependencies OpenLup promises
to preserve and how to plan an upgrade. OpenLup is in development preview.

## Public API

The public compatibility contract covers what your application consumes when
declared public or shipped by an official stable or core module:

- Package exports, types, call shapes, documented behavior and error codes.
- Domain and runtime event names, payloads, ordering and delivery semantics.
- Extension, module, adapter, registry and capability identifiers.
- Public HTTP routes, methods, request and response shapes, and errors.
- Configuration keys, schemas, defaults and documented environment behavior.
- Migration identities, order, ledger semantics and code compatibility with
  the expanded database schema during an upgrade.

An export snapshot covers only the package-export part of this contract.
Documented application dependencies cannot be reclassified as internal to
avoid compatibility obligations. Undeclared implementation details may change
in any release; explicitly experimental surfaces follow preview rules.

## Version numbers

A preview version identifies a reproducible release without promising stable
compatibility or a support window. Preview APIs and extension seams may change
incompatibly, but the release notes must name each affected contract and its
upgrade actions. Preview notes apply only to the adjacent transition they name.

Stable releases follow semantic versioning across the whole public contract:

- **Major:** may remove a previously deprecated contract after its compatibility
  bridge has been provided.
- **Minor:** adds contracts or deprecates existing ones without breaking them.
- **Patch:** fixes defects without intentionally changing the public contract.

A deprecation must keep the old behavior working, name its replacement and
explain the upgrade action. This compatibility bridge remains through at least
one supported stable minor; removal can happen no earlier than the next major,
with explicit upgrade notes. Stable status, idempotency and adapter-extension
commitments depend on completion of the stable-framework requirements.

During preview, all `@openlup/*` packages share one `0.N.P` set version from one
commit. Each package has a tag `openlup-<package>-v<version>` at that commit.
A source preview contains no npm package.

## Support window

Once stable releases exist, the latest minor of the current stable major
receives fixes, security fixes and new features. The latest minor of the
previous stable major, if any, receives only security and critical-defect fixes
for six months after the new major's release.

Older minors receive no fixes: upgrade to the latest minor and reproduce a
defect there before reporting it. Majors older than the previous stable major
receive no fixes, including security fixes. The previous stable major reaches
end of life when its window expires; the published window is advance notice,
without a separate campaign.
Preview releases never qualify as a previous stable major.

## Exceptional cessation

If issues go unanswered for six consecutive months, the project enters
exceptional cessation. A notice in the
[versioning policy](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/.github/VERSIONING_AND_EOL.md#exceptional-cessation)
and at the top of the
[repository README](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/README.md)
records the decision date, exact end-of-maintenance date and last supported
releases. The repository is archived on or after that date; if no stable
channel ever existed, it may be archived as soon as the condition is recorded.

If maintenance ends before an advertised stable support window is complete,
the notice must correct the support claim. Cessation does not erase the licence
or prevent forking a released artifact.

## Upgrades

Upgrade all `@openlup/*` packages together. Stable upgrades proceed one major
at a time, in order; skipping a major is unsupported even if it appears to work.

Database changes are forward-only, with no supported downgrade path. Before
upgrading, take a backup and test restoring it. Schema evolution
expands the schema, deploys code compatible with old and new shapes, backfills
data, then removes the old shape in a later release. A code rollback must work
with the expanded schema and must not depend on a database down migration.
