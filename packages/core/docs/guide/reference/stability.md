# Versioning and stability

Use the release policy to understand which application dependencies OpenLup
promises to preserve and how to plan an upgrade. Consult the
[versioning policy](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/.github/VERSIONING_AND_EOL.md)
for channel maturity, version format and support-window durations.

## Public API

The public compatibility contract covers what your application consumes when
declared public or shipped as part of a module’s compatibility commitment:

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
in any release; check the selected channel’s commitments before relying on a
surface.

## Version numbers

A release identifier alone promises neither compatibility nor a support window.
Where incompatible changes are permitted, release notes must name each affected
contract and its upgrade actions. Transition-specific notes apply only to the
adjacent transition they name.

For channels with semantic-versioning commitments, those commitments cover the
whole public contract:

- **Major:** may remove a previously deprecated contract after its compatibility
  bridge has been provided.
- **Minor:** adds contracts or deprecates existing ones without breaking them.
- **Patch:** fixes defects without intentionally changing the public contract.

A deprecation must keep the old behavior working, name its replacement and
explain the upgrade action. Keep the compatibility bridge for the period
required by the versioning policy, with explicit upgrade notes before removal.
Check that policy’s release prerequisites before claiming compatibility,
idempotency or adapter-extension commitments.

Upgrade matching `@openlup/*` packages as a set from the same commit. Read the
versioning policy for the package-set and tag conventions. A source release
artifact does not itself contain npm packages.

## Support window

Check the versioning policy for the current and previous major’s maintenance
scope and end-of-life rules. Upgrade to the latest minor and reproduce a defect
there before reporting it. Releases outside their advertised support window
receive no fixes, including security fixes. Evaluation channels do not acquire
a support window merely because a later major exists.

## Exceptional cessation

If the unanswered-issue period specified by the versioning policy elapses,
the project enters exceptional cessation. A notice in that policy and at the
top of the
[repository README](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/README.md)
records the decision date, exact end-of-maintenance date and last supported
releases. The repository is archived on or after that date; channels without a
support commitment may be archived as soon as the condition is recorded.

If maintenance ends before an advertised support window is complete, the notice
must correct the support claim. Cessation does not erase the licence or prevent
forking a released artifact.

## Upgrades

Upgrade all `@openlup/*` packages together. Where ordered major upgrades are
required, do not skip a major even if doing so appears to work.

Database changes are forward-only, with no supported downgrade path. Before
upgrading, take a backup and test restoring it. Schema evolution expands the
schema, deploys code compatible with old and new shapes, backfills data, then
removes the old shape in a later release. A code rollback must work with the
expanded schema and must not depend on a database down migration.
